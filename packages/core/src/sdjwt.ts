// SD-JWT VC (IETF) issuance, presentation with KB-JWT, and verification.
import { sha256 } from '@noble/hashes/sha2';
import { b64u, utf8, randomBytes, toBase64, fromUtf8 } from './bytes';
import { Jwk, jwkToPoint, signJwt, parseJwt, es256Verify, verifyJwtWithJwk } from './keys';
import { Cert, parseCert, verifyChain } from './x509';
import { Signer } from './mdoc';

const enc = (o: unknown) => b64u.encode(utf8(JSON.stringify(o)));
const dec = (s: string) => JSON.parse(fromUtf8(b64u.decode(s)));
const digest = (s: string) => b64u.encode(sha256(utf8(s)));

export interface IssueSdJwtInput {
  iss: string;
  vct: string;
  claims: Record<string, unknown>;      // all become selectively-disclosable
  alwaysVisible?: Record<string, unknown>;
  holderKey: Jwk;
  signer: Signer;
  validitySeconds: number;
}

export function issueSdJwt(i: IssueSdJwtInput): string {
  const disclosures: string[] = [];
  const sd: string[] = [];
  for (const [k, v] of Object.entries(i.claims)) {
    const d = enc([b64u.encode(randomBytes(16)), k, v]);
    disclosures.push(d); sd.push(digest(d));
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: i.iss, iat: now, nbf: now, exp: now + i.validitySeconds, vct: i.vct,
    ...i.alwaysVisible, cnf: { jwk: i.holderKey }, _sd: sd.sort(), _sd_alg: 'sha-256',
  };
  const jwt = signJwt({ typ: 'dc+sd-jwt', x5c: i.signer.chain.map((c) => toBase64(c)) }, payload, i.signer.privateKey);
  return [jwt, ...disclosures].join('~') + '~';
}

export function parseSdJwt(s: string) {
  // "<jwt>~<d1>~...~<dn>~" or with a trailing key-binding JWT
  const parts = s.split('~');
  const last = parts[parts.length - 1];
  return { jwt: parts[0], disclosures: parts.slice(1, -1), kb: last === '' ? undefined : last };
}

/** Claims (name -> value) available in a stored SD-JWT (holder side). */
export function listSdJwtClaims(s: string): { visible: Record<string, unknown>; disclosable: Record<string, unknown> } {
  const { jwt, disclosures } = parseSdJwt(s);
  const { payload } = parseJwt(jwt);
  const disclosable: Record<string, unknown> = {};
  for (const d of disclosures) { const [, k, v] = dec(d); disclosable[k] = v; }
  const { _sd, _sd_alg, cnf, ...visible } = payload;
  return { visible, disclosable };
}

export function presentSdJwt(stored: string, reveal: string[], holderPriv: Uint8Array, aud: string, nonce: string): string {
  const { jwt, disclosures } = parseSdJwt(stored);
  const keep = disclosures.filter((d) => reveal.includes(dec(d)[1]));
  const base = [jwt, ...keep].join('~') + '~';
  const kb = signJwt({ typ: 'kb+jwt' }, { iat: Math.floor(Date.now() / 1000), aud, nonce, sd_hash: digest(base) }, holderPriv);
  return base + kb;
}

export type SdJwtResult = { ok: true; claims: Record<string, unknown>; issuerSubject: string; anchorSubject: string } | { ok: false; error: string };

export function verifySdJwtPresentation(
  presentation: string,
  o: { trustAnchors: Cert[]; aud: string; nonce: string; now?: Date; expectedVct?: string },
): SdJwtResult {
  try {
    const now = o.now ?? new Date();
    const { jwt, disclosures, kb } = parseSdJwt(presentation);
    if (!kb) return { ok: false, error: 'missing key-binding JWT' };
    const parsed = parseJwt(jwt);
    const x5c: string[] = parsed.header.x5c;
    if (!x5c?.length) return { ok: false, error: 'issuer JWT has no x5c' };
    const chain = x5c.map((c) => parseCert(b64uOrB64(c)));
    const chainRes = verifyChain(chain, o.trustAnchors, { now });
    if (!chainRes.ok) return { ok: false, error: 'issuer certificate: ' + chainRes.reason };
    if (!es256Verify(parsed.signature, utf8(parsed.signingInput), chain[0].publicKey)) return { ok: false, error: 'issuer signature invalid' };
    const p = parsed.payload;
    const t = Math.floor(now.getTime() / 1000);
    if (p.exp && t > p.exp) return { ok: false, error: 'credential expired' };
    if (p.nbf && t + 60 < p.nbf) return { ok: false, error: 'credential not yet valid' };
    if (o.expectedVct && p.vct !== o.expectedVct) return { ok: false, error: `unexpected vct ${p.vct}` };

    const claims: Record<string, unknown> = { ...p };
    delete claims._sd; delete claims._sd_alg; delete claims.cnf;
    const allowed = new Set<string>(p._sd ?? []);
    for (const d of disclosures) {
      if (!allowed.has(digest(d))) return { ok: false, error: 'disclosure not bound to signed digests' };
      const [, k, v] = dec(d);
      claims[k] = v;
    }
    // key binding
    const base = presentation.slice(0, presentation.length - kb.length);
    const kbv = verifyJwtWithJwk(kb, p.cnf?.jwk);
    if (kbv.payload.aud !== o.aud) return { ok: false, error: 'KB-JWT audience mismatch' };
    if (kbv.payload.nonce !== o.nonce) return { ok: false, error: 'KB-JWT nonce mismatch' };
    if (kbv.payload.sd_hash !== digest(base)) return { ok: false, error: 'KB-JWT sd_hash mismatch' };
    void jwkToPoint;
    return { ok: true, claims, issuerSubject: chain[0].subject, anchorSubject: chainRes.anchor.subject };
  } catch (e: any) {
    return { ok: false, error: 'malformed SD-JWT: ' + (e?.message ?? e) };
  }
}

function b64uOrB64(s: string): Uint8Array { return b64u.decode(s); }
