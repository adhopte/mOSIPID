// ISO/IEC 18013-5 mdoc: issuance (IssuerSigned), presentation (DeviceResponse) and verification.
import { sha256 } from '@noble/hashes/sha2';
import { concat, equalBytes, randomBytes, b64u } from './bytes';
import { encode, decode, Tagged, Raw, decodeTag24, tag24Bytes, encodeTag24, mget } from './cbor';
import { coseKeyFromJwk, jwkFromCoseKey, sign1, verify1 } from './cose';
import { Jwk, jwkToPoint, es256Sign } from './keys';
import { Cert, parseCert, verifyChain } from './x509';

export const MDL_DS_EKU = '1.0.18013.5.1.2';

export interface Signer { privateKey: Uint8Array; chain: Uint8Array[] /* DER, leaf first */ }
export type Namespaces = Record<string, Record<string, unknown>>;

const fmtDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
/** ISO 18013-5 full-date */
export const fullDate = (iso: string) => new Tagged(1004, iso.slice(0, 10));

export interface IssueMdocInput {
  docType: string;
  namespaces: Namespaces;
  deviceKey: Jwk;
  signer: Signer;
  validFrom?: Date;
  validUntil: Date;
}

/** Returns CBOR-encoded IssuerSigned */
export function issueMdoc(input: IssueMdocInput): Uint8Array {
  const valueDigests = new Map<string, Map<number, Uint8Array>>();
  const nameSpaces = new Map<string, Tagged[]>();
  let digestId = 0;
  for (const [ns, elements] of Object.entries(input.namespaces)) {
    const items: Tagged[] = [];
    const digests = new Map<number, Uint8Array>();
    for (const [elementIdentifier, elementValue] of Object.entries(elements)) {
      const item = encodeTag24(new Map<string, unknown>([
        ['digestID', digestId], ['random', randomBytes(16)],
        ['elementIdentifier', elementIdentifier], ['elementValue', elementValue],
      ]));
      digests.set(digestId, sha256(encode(item)));
      items.push(item);
      digestId++;
    }
    nameSpaces.set(ns, items);
    valueDigests.set(ns, digests);
  }
  const now = input.validFrom ?? new Date();
  const mso = new Map<string, unknown>([
    ['version', '1.0'],
    ['digestAlgorithm', 'SHA-256'],
    ['valueDigests', valueDigests],
    ['deviceKeyInfo', new Map([['deviceKey', coseKeyFromJwk(input.deviceKey)]])],
    ['docType', input.docType],
    ['validityInfo', new Map<string, unknown>([
      ['signed', new Tagged(0, fmtDate(new Date()))],
      ['validFrom', new Tagged(0, fmtDate(now))],
      ['validUntil', new Tagged(0, fmtDate(input.validUntil))],
    ])],
  ]);
  const x5chain = input.signer.chain.length === 1 ? input.signer.chain[0] : input.signer.chain;
  const issuerAuth = sign1(encode(encodeTag24(mso)), input.signer.privateKey, new Map([[33, x5chain]]));
  return encode(new Map<string, unknown>([['nameSpaces', nameSpaces], ['issuerAuth', issuerAuth]]));
}

// ---------------------------------------------------------------- session transcripts
export const openid4vpTranscript = (p: { clientId: string; nonce: string; responseUri: string; jwkThumbprint?: string | null }) =>
  [null, null, ['OpenID4VPHandover', sha256(encode([p.clientId, p.nonce, p.jwkThumbprint ?? null, p.responseUri]))]];

export const proximityTranscript = (deviceEngagement: Uint8Array, eReaderKeyJwk: Jwk) =>
  [new Tagged(24, deviceEngagement), encodeTag24(coseKeyFromJwk(eReaderKeyJwk)), null];

// ---------------------------------------------------------------- requests
export type RequestedItems = Record<string /*docType*/, Record<string /*ns*/, string[]>>;

export function buildDeviceRequest(req: RequestedItems): Uint8Array {
  const docRequests = Object.entries(req).map(([docType, nss]) => {
    const nameSpaces = new Map<string, Map<string, boolean>>();
    for (const [ns, els] of Object.entries(nss)) nameSpaces.set(ns, new Map(els.map((e) => [e, false])));
    return new Map([['itemsRequest', encodeTag24(new Map<string, unknown>([['docType', docType], ['nameSpaces', nameSpaces]]))]]);
  });
  return encode(new Map<string, unknown>([['version', '1.0'], ['docRequests', docRequests]]));
}

export function parseDeviceRequest(bytes: Uint8Array): RequestedItems {
  const dr = decode(bytes);
  const out: RequestedItems = {};
  for (const d of (mget<unknown[]>(dr, 'docRequests') ?? [])) {
    const ir = decodeTag24(mget(d, 'itemsRequest'));
    const docType = mget<string>(ir, 'docType')!;
    out[docType] = {};
    for (const [ns, els] of (mget<Map<string, Map<string, boolean>>>(ir, 'nameSpaces') ?? new Map())) out[docType][ns] = [...els.keys()];
  }
  return out;
}

// ---------------------------------------------------------------- holder side
export function listIssuerSignedClaims(issuerSigned: Uint8Array): Namespaces {
  const is = decode(issuerSigned);
  const out: Namespaces = {};
  for (const [ns, items] of mget<Map<string, Tagged[]>>(is, 'nameSpaces') ?? new Map()) {
    out[ns] = {};
    for (const it of items) { const d = decodeTag24(it); out[ns][mget<string>(d, 'elementIdentifier')!] = normalize(mget(d, 'elementValue')); }
  }
  return out;
}

export function mdocDocType(issuerSigned: Uint8Array): string {
  const is = decode(issuerSigned);
  const payload = (mget<unknown[]>(is, 'issuerAuth')![2]) as Uint8Array;
  return mget<string>(decodeTag24(decode(payload)), 'docType')!;
}

export interface BuildResponseInput {
  documents: { issuerSigned: Uint8Array; deviceKeyPriv: Uint8Array; requested: Record<string, string[]> /* ns -> elements */ }[];
  sessionTranscript: unknown;
}

export function buildDeviceResponse(input: BuildResponseInput): Uint8Array {
  const docs = input.documents.map((d) => {
    const is = decode(d.issuerSigned);
    const issuerAuth = mget<unknown[]>(is, 'issuerAuth')!;
    const docType = mget<string>(decodeTag24(decode(issuerAuth[2] as Uint8Array)), 'docType')!;
    const filtered = new Map<string, Tagged[]>();
    for (const [ns, items] of mget<Map<string, Tagged[]>>(is, 'nameSpaces') ?? new Map()) {
      const wanted = d.requested[ns];
      if (!wanted) continue;
      const keep = items.filter((it: Tagged) => wanted.includes(mget<string>(decodeTag24(it), 'elementIdentifier')!));
      if (keep.length) filtered.set(ns, keep);
    }
    const deviceNameSpaces = encodeTag24(new Map());
    const deviceAuthBytes = encode(encodeTag24(['DeviceAuthentication', input.sessionTranscript, docType, deviceNameSpaces]));
    const deviceSignature = sign1(deviceAuthBytes, d.deviceKeyPriv, new Map(), true);
    return new Map<string, unknown>([
      ['docType', docType],
      ['issuerSigned', new Map<string, unknown>([['nameSpaces', filtered], ['issuerAuth', issuerAuth]])],
      ['deviceSigned', new Map<string, unknown>([['nameSpaces', deviceNameSpaces], ['deviceAuth', new Map([['deviceSignature', deviceSignature]])]])],
    ]);
  });
  return encode(new Map<string, unknown>([['version', '1.0'], ['documents', docs], ['status', 0]]));
}

// ---------------------------------------------------------------- verifier side
export interface VerifiedDocument {
  docType: string;
  claims: Namespaces;
  issuerSubject: string;
  anchorSubject: string;
  validFrom: string;
  validUntil: string;
}
export type VerifyResult = { ok: true; documents: VerifiedDocument[] } | { ok: false; error: string };

export interface VerifyOptions {
  sessionTranscript: unknown;
  trustAnchors: Cert[];
  now?: Date;
  expectedDocType?: string;
  requireDsEku?: boolean;
}

export function normalize(v: unknown): unknown {
  if (v instanceof Tagged) return v.tag === 24 ? normalize(decode(v.value as Uint8Array)) : normalize(v.value);
  if (v instanceof Map) { const o: Record<string, unknown> = {}; for (const [k, x] of v) o[String(k)] = normalize(x); return o; }
  if (Array.isArray(v)) return v.map(normalize);
  return v;
}

export function verifyDeviceResponse(bytes: Uint8Array, opts: VerifyOptions): VerifyResult {
  try {
    const dr = decode(bytes);
    const docs = mget<unknown[]>(dr, 'documents');
    if (!docs?.length) return { ok: false, error: 'DeviceResponse has no documents' };
    const now = opts.now ?? new Date();
    const out: VerifiedDocument[] = [];
    for (const doc of docs) {
      const docType = mget<string>(doc, 'docType')!;
      if (opts.expectedDocType && docType !== opts.expectedDocType) return { ok: false, error: `unexpected docType ${docType}` };
      const issuerSigned = mget(doc, 'issuerSigned');
      const issuerAuth = mget<any[]>(issuerSigned, 'issuerAuth');
      if (!issuerAuth) return { ok: false, error: 'missing issuerAuth' };

      // 1. issuer certificate chain -> trust anchor (IACA)
      const x5 = (issuerAuth[1] as Map<number, unknown>).get(33);
      const chainDer = (Array.isArray(x5) ? x5 : [x5]) as Uint8Array[];
      if (!chainDer[0]) return { ok: false, error: 'issuerAuth has no x5chain' };
      const chain = chainDer.map((c) => parseCert(c));
      const chainRes = verifyChain(chain, opts.trustAnchors, { now, requireEku: opts.requireDsEku === false ? undefined : MDL_DS_EKU });
      if (!chainRes.ok) return { ok: false, error: 'issuer certificate: ' + chainRes.reason };

      // 2. MSO signature
      if (!verify1(issuerAuth, chain[0].publicKey)) return { ok: false, error: 'issuerAuth signature invalid' };
      const mso = decodeTag24(decode(issuerAuth[2] as Uint8Array));
      if (mget(mso, 'docType') !== docType) return { ok: false, error: 'docType mismatch between MSO and document' };
      const vi = mget(mso, 'validityInfo');
      const from = new Date(String((mget(vi, 'validFrom') as Tagged).value));
      const until = new Date(String((mget(vi, 'validUntil') as Tagged).value));
      if (now < from || now > until) return { ok: false, error: 'credential outside validity period' };

      // 3. digests of disclosed elements
      const digests = mget<Map<string, Map<number, Uint8Array>>>(mso, 'valueDigests')!;
      const claims: Namespaces = {};
      for (const [ns, items] of mget<Map<string, Tagged[]>>(issuerSigned, 'nameSpaces') ?? new Map()) {
        claims[ns] = {};
        for (const it of items) {
          const item = decodeTag24(it);
          const expected = digests.get(ns)?.get(mget<number>(item, 'digestID')!);
          if (!expected || !equalBytes(expected, sha256(encode(it)))) return { ok: false, error: `digest mismatch for ${mget(item, 'elementIdentifier')}` };
          claims[ns][mget<string>(item, 'elementIdentifier')!] = normalize(mget(item, 'elementValue'));
        }
      }

      // 4. device authentication (holder binding)
      const deviceKey = jwkFromCoseKey(mget(mget(mso, 'deviceKeyInfo'), 'deviceKey'));
      const deviceSigned = mget(doc, 'deviceSigned');
      const dsig = mget(mget(deviceSigned, 'deviceAuth'), 'deviceSignature');
      if (!dsig) return { ok: false, error: 'missing deviceSignature' };
      const deviceAuthBytes = encode(encodeTag24(['DeviceAuthentication', opts.sessionTranscript, docType, mget(deviceSigned, 'nameSpaces')]));
      if (!verify1(dsig, jwkToPoint(deviceKey), deviceAuthBytes)) return { ok: false, error: 'deviceSignature invalid (session/nonce mismatch or wrong holder key)' };

      out.push({
        docType, claims, issuerSubject: chain[0].subject, anchorSubject: chainRes.anchor.subject,
        validFrom: from.toISOString(), validUntil: until.toISOString(),
      });
    }
    return { ok: true, documents: out };
  } catch (e: any) {
    return { ok: false, error: 'malformed DeviceResponse: ' + (e?.message ?? e) };
  }
}

export { Raw, tag24Bytes, es256Sign, b64u, concat };
