// Minimal X.509 parsing + ECDSA (P-256/P-384) signature verification built on noble,
// so certificate-chain checks for mdoc/SD-JWT run identically on Node and React Native.
import { p256 } from '@noble/curves/p256';
import { p384 } from '@noble/curves/p384';
import { sha256, sha384 } from '@noble/hashes/sha2';
import { fromBase64, toHex, fromUtf8 } from './bytes';
import { Asn1, parseDer, derOid, derTime } from './der';

export interface Cert {
  der: Uint8Array;
  tbs: Uint8Array;
  sigAlgOid: string;
  signature: Uint8Array;       // DER ECDSA-Sig-Value
  subjectRaw: Uint8Array;
  issuerRaw: Uint8Array;
  subject: string;
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  publicKey: Uint8Array;       // uncompressed EC point
  curve: 'P-256' | 'P-384';
  isCA: boolean;
  keyUsage?: number;           // bit string first byte(s)
  extKeyUsage: string[];
  ski?: string;
  aki?: string;
}

const OID = {
  ecdsaSha256: '1.2.840.10045.4.3.2', ecdsaSha384: '1.2.840.10045.4.3.3',
  p256: '1.2.840.10045.3.1.7', p384: '1.3.132.0.34',
  basicConstraints: '2.5.29.19', keyUsage: '2.5.29.15', eku: '2.5.29.37', ski: '2.5.29.14', aki: '2.5.29.35',
  cn: '2.5.4.3', o: '2.5.4.10', c: '2.5.4.6', ou: '2.5.4.11',
};
const NAMES: Record<string, string> = { [OID.cn]: 'CN', [OID.o]: 'O', [OID.c]: 'C', [OID.ou]: 'OU' };

function name(n: Asn1): string {
  return n.children
    .map((rdn) => {
      const atv = rdn.children[0];
      return `${NAMES[derOid(atv.children[0])] ?? derOid(atv.children[0])}=${fromUtf8(atv.children[1].value)}`;
    })
    .join(', ');
}

export function pemToDer(pem: string): Uint8Array {
  return fromBase64(pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, ''));
}

export function parseCert(input: Uint8Array | string): Cert {
  const der = typeof input === 'string' ? pemToDer(input) : input;
  const root = parseDer(der);
  const [tbs, sigAlg, sigBits] = root.children;
  let i = 0;
  if (tbs.children[0].tag === 0xa0) i = 1; // explicit version
  const kids = tbs.children.slice(i);
  const issuerN = kids[2], validityN = kids[3], subjectN = kids[4], spkiN = kids[5];
  const point = spkiN.children[1].value.subarray(1); // drop unused-bits byte
  const curveOid = derOid(spkiN.children[0].children[1]);
  const cert: Cert = {
    der, tbs: tbs.raw,
    sigAlgOid: derOid(sigAlg.children[0]),
    signature: sigBits.value.subarray(1),
    subjectRaw: subjectN.raw, issuerRaw: issuerN.raw,
    subject: name(subjectN), issuer: name(issuerN),
    notBefore: derTime(validityN.children[0]), notAfter: derTime(validityN.children[1]),
    publicKey: point,
    curve: curveOid === OID.p384 ? 'P-384' : 'P-256',
    isCA: false, extKeyUsage: [],
  };
  if (curveOid !== OID.p256 && curveOid !== OID.p384) throw new Error('x509: unsupported key curve ' + curveOid);
  const extWrap = kids.find((k) => k.tag === 0xa3);
  if (extWrap) {
    for (const ext of extWrap.children[0].children) {
      const oid = derOid(ext.children[0]);
      const valueNode = ext.children[ext.children.length - 1];
      const inner = parseDer(valueNode.value);
      if (oid === OID.basicConstraints) cert.isCA = inner.children.some((c) => c.num === 1 && c.value[0] === 0xff);
      else if (oid === OID.keyUsage) cert.keyUsage = (inner.value[1] << 8) | (inner.value[2] ?? 0);
      else if (oid === OID.eku) cert.extKeyUsage = inner.children.map(derOid);
      else if (oid === OID.ski) cert.ski = toHex(inner.value);
      else if (oid === OID.aki) { const k = inner.children.find((c) => c.tag === 0x80); if (k) cert.aki = toHex(k.value); }
    }
  }
  return cert;
}

/** ECDSA DER -> raw r||s (fixed width) */
export function ecdsaDerToRaw(der: Uint8Array, size = 32): Uint8Array {
  const n = parseDer(der);
  const out = new Uint8Array(size * 2);
  n.children.forEach((c, idx) => {
    let v = c.value;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    out.set(v, idx * size + (size - v.length));
  });
  return out;
}

export function verifyCertSignature(cert: Cert, issuerCert: Cert): boolean {
  try {
    const sig = ecdsaDerToRaw(cert.signature, issuerCert.curve === 'P-384' ? 48 : 32);
    if (issuerCert.curve === 'P-384') return p384.verify(sig, sha384(cert.tbs), issuerCert.publicKey);
    return p256.verify(sig, sha256(cert.tbs), issuerCert.publicKey);
  } catch { return false; }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export interface ChainOptions { now?: Date; requireEku?: string; }

/**
 * Validates leaf -> (intermediates) -> one of `anchors`.
 * Checks signatures, validity windows, issuer/subject linkage and CA flags.
 */
export function verifyChain(chain: Cert[], anchors: Cert[], opts: ChainOptions = {}): { ok: true; anchor: Cert } | { ok: false; reason: string } {
  const now = opts.now ?? new Date();
  if (!chain.length) return { ok: false, reason: 'empty certificate chain' };
  const leaf = chain[0];
  if (opts.requireEku && !leaf.extKeyUsage.includes(opts.requireEku)) return { ok: false, reason: 'leaf missing required extended key usage' };
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i];
    if (now < c.notBefore || now > c.notAfter) return { ok: false, reason: `certificate ${c.subject} not valid at ${now.toISOString()}` };
    const next = chain[i + 1];
    if (next) {
      if (!next.isCA) return { ok: false, reason: 'intermediate is not a CA' };
      if (!sameBytes(c.issuerRaw, next.subjectRaw) || !verifyCertSignature(c, next)) return { ok: false, reason: 'chain signature invalid' };
    }
  }
  const last = chain[chain.length - 1];
  for (const a of anchors) {
    if (now < a.notBefore || now > a.notAfter) continue;
    if (sameBytes(last.der, a.der)) return { ok: true, anchor: a };
    if (a.isCA && sameBytes(last.issuerRaw, a.subjectRaw) && verifyCertSignature(last, a)) return { ok: true, anchor: a };
  }
  return { ok: false, reason: 'certificate does not chain to a trusted anchor' };
}
