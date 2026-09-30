// Certificate authority helpers (ISO 18013-5 Annex B profile): mock IACA root + Document Signer certs.
// Pure noble + DER writer; runs on Node and React Native.
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';
import { concat, randomBytes, toBase64, fromBase64, utf8, toHex } from './bytes';
import { derEnc } from './der';
import { generateKeyPair, KeyPair, es256Sign } from './keys';
import { MDL_DS_EKU } from './mdoc';
import { parseCert, Cert, pemToDer } from './x509';

const seq = (...p: Uint8Array[]) => derEnc(0x30, concat(...p));
const set = (...p: Uint8Array[]) => derEnc(0x31, concat(...p));
const ctx = (n: number, c: Uint8Array, constructed = true) => derEnc((constructed ? 0xa0 : 0x80) | n, c);
const octet = (b: Uint8Array) => derEnc(0x04, b);
const bool = (v: boolean) => derEnc(0x01, Uint8Array.of(v ? 0xff : 0));
const int = (bytes: Uint8Array) => {
  let b = bytes; while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  return derEnc(0x02, b[0] & 0x80 ? concat(Uint8Array.of(0), b) : b);
};
const smallInt = (n: number) => int(Uint8Array.of(n));
export function oid(s: string): Uint8Array {
  const p = s.split('.').map(Number);
  const out: number[] = [p[0] * 40 + p[1]];
  for (const v of p.slice(2)) { const t: number[] = [v & 0x7f]; let x = v >> 7; while (x > 0) { t.unshift((x & 0x7f) | 0x80); x >>= 7; } out.push(...t); }
  return derEnc(0x06, Uint8Array.from(out));
}
const OIDS = { ecPublicKey: '1.2.840.10045.2.1', p256: '1.2.840.10045.3.1.7', ecdsaSha256: '1.2.840.10045.4.3.2', cn: '2.5.4.3', o: '2.5.4.10', c: '2.5.4.6', st: '2.5.4.8', ou: '2.5.4.11' };

export interface DN { C: string; O?: string; CN: string; ST?: string; OU?: string }
function name(dn: DN): Uint8Array {
  const rdn = (o: string, v: string, printable = false) => set(seq(oid(o), derEnc(printable ? 0x13 : 0x0c, utf8(v))));
  const parts = [rdn(OIDS.c, dn.C, true)];
  if (dn.ST) parts.push(rdn(OIDS.st, dn.ST));
  if (dn.O) parts.push(rdn(OIDS.o, dn.O));
  if (dn.OU) parts.push(rdn(OIDS.ou, dn.OU));
  parts.push(rdn(OIDS.cn, dn.CN));
  return seq(...parts);
}
const utc = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return derEnc(0x17, utf8(s));
};
const ext = (o: string, critical: boolean, value: Uint8Array) => seq(oid(o), ...(critical ? [bool(true)] : []), octet(value));

const ecdsaRawToDer = (raw: Uint8Array) => seq(int(raw.subarray(0, 32)), int(raw.subarray(32)));

export interface IssuedCert { cert: Cert; der: Uint8Array; pem: string; key: KeyPair }

export const toPem = (der: Uint8Array, label = 'CERTIFICATE') =>
  `-----BEGIN ${label}-----\n${toBase64(der).match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;

interface BuildOpts {
  subject: DN; issuer: DN; subjectKey: KeyPair; issuerKey: KeyPair; issuerSki?: Uint8Array;
  notBefore: Date; notAfter: Date; ca: boolean; eku?: string[]; crlUrl?: string; issuerAltNameUri?: string;
}

function build(o: BuildOpts): IssuedCert {
  const pub = p256.getPublicKey(o.subjectKey.privateKey, false);
  const ski = sha256(pub).slice(0, 20);
  const spki = seq(seq(oid(OIDS.ecPublicKey), oid(OIDS.p256)), derEnc(0x03, concat(Uint8Array.of(0), pub)));
  const exts: Uint8Array[] = [];
  exts.push(ext('2.5.29.19', true, o.ca ? seq(bool(true), smallInt(0)) : seq()));
  exts.push(ext('2.5.29.15', true, derEnc(0x03, o.ca ? Uint8Array.of(1, 0x06) : Uint8Array.of(7, 0x80))));
  exts.push(ext('2.5.29.14', false, octet(ski)));
  if (o.issuerSki) exts.push(ext('2.5.29.35', false, seq(ctx(0, o.issuerSki, false))));
  if (o.eku?.length) exts.push(ext('2.5.29.37', false, seq(...o.eku.map(oid))));
  if (o.issuerAltNameUri) exts.push(ext('2.5.29.18', false, seq(derEnc(0x86, utf8(o.issuerAltNameUri)))));
  if (o.crlUrl) exts.push(ext('2.5.29.31', false, seq(seq(ctx(0, ctx(0, derEnc(0x86, utf8(o.crlUrl))))))));
  const tbs = seq(
    ctx(0, smallInt(2)), int(concat(Uint8Array.of(0x01), randomBytes(15))), seq(oid(OIDS.ecdsaSha256)),
    name(o.issuer), seq(utc(o.notBefore), utc(o.notAfter)), name(o.subject), spki, ctx(3, seq(...exts)),
  );
  const sig = ecdsaRawToDer(es256Sign(tbs, o.issuerKey.privateKey));
  const der = seq(tbs, seq(oid(OIDS.ecdsaSha256)), derEnc(0x03, concat(Uint8Array.of(0), sig)));
  return { der, pem: toPem(der), key: o.subjectKey, cert: parseCert(der) };
}

const YEAR = 365 * 24 * 3600 * 1000;

export function createRootCa(o: { subject: DN; years?: number; key?: KeyPair; crlUrl?: string; altNameUri?: string; now?: Date }): IssuedCert {
  const key = o.key ?? generateKeyPair();
  const now = o.now ?? new Date();
  const c = build({
    subject: o.subject, issuer: o.subject, subjectKey: key, issuerKey: key,
    notBefore: new Date(now.getTime() - 3600_000), notAfter: new Date(now.getTime() + (o.years ?? 15) * YEAR), ca: true,
    crlUrl: o.crlUrl, issuerAltNameUri: o.altNameUri,
  });
  return c;
}

export function issueDocumentSigner(ca: IssuedCert, o: { subject: DN; days?: number; key?: KeyPair; eku?: string[]; crlUrl?: string; altNameUri?: string; now?: Date }): IssuedCert {
  const now = o.now ?? new Date();
  const skiHex = ca.cert.ski ? Uint8Array.from(ca.cert.ski.match(/../g)!.map((h) => parseInt(h, 16))) : undefined;
  return build({
    subject: o.subject, issuer: parseSubjectDn(ca), subjectKey: o.key ?? generateKeyPair(), issuerKey: ca.key, issuerSki: skiHex,
    notBefore: new Date(now.getTime() - 3600_000), notAfter: new Date(now.getTime() + (o.days ?? 400) * 24 * 3600_000), ca: false,
    eku: o.eku ?? [MDL_DS_EKU], crlUrl: o.crlUrl, issuerAltNameUri: o.altNameUri,
  });
}

// The DN used for the CA is kept alongside so child certs reuse the identical encoding.
const dnStore = new WeakMap<object, DN>();
export function rememberDn(c: IssuedCert, dn: DN) { dnStore.set(c, dn); return c; }
function parseSubjectDn(ca: IssuedCert): DN {
  const known = dnStore.get(ca);
  if (known) return known;
  const m = Object.fromEntries(ca.cert.subject.split(', ').map((p) => p.split('=') as [string, string]));
  return { C: m.C, ST: m.ST, O: m.O, OU: m.OU, CN: m.CN };
}

export function loadIssuedCert(pem: string, privateKeyHex: string): IssuedCert {
  const der = pemToDer(pem);
  const priv = Uint8Array.from(privateKeyHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = { privateKey: priv, publicJwk: generateKeyPairFromPriv(priv) };
  return { der, pem, cert: parseCert(der), key };
}
function generateKeyPairFromPriv(priv: Uint8Array) {
  const pub = p256.getPublicKey(priv, false);
  return { kty: 'EC' as const, crv: 'P-256' as const, x: toBase64(pub.slice(1, 33)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), y: toBase64(pub.slice(33, 65)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') };
}
export const privateKeyHex = (k: KeyPair) => toHex(k.privateKey);
void fromBase64;
