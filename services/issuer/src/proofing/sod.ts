// ICAO 9303 passive authentication: verify that DG1/DG2 hash to the values signed in EF.SOD,
// that the SOD signature is valid under its embedded Document Signer certificate, and (optionally)
// that the DS certificate chains to a trusted CSCA.
import { createHash, createPublicKey, verify as cryptoVerify, X509Certificate, constants } from 'node:crypto';
import { parseDer, derOid, Asn1, derInt } from '@mosipid/core';

const HASHES: Record<string, string> = {
  '1.3.14.3.2.26': 'sha1', '2.16.840.1.101.3.4.2.4': 'sha224', '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512',
};
const SIG: Record<string, { hash?: string; kind: 'rsa' | 'pss' | 'ecdsa' }> = {
  '1.2.840.113549.1.1.1': { kind: 'rsa' }, '1.2.840.113549.1.1.5': { kind: 'rsa', hash: 'sha1' }, '1.2.840.113549.1.1.11': { kind: 'rsa', hash: 'sha256' },
  '1.2.840.113549.1.1.12': { kind: 'rsa', hash: 'sha384' }, '1.2.840.113549.1.1.13': { kind: 'rsa', hash: 'sha512' }, '1.2.840.113549.1.1.10': { kind: 'pss' },
  '1.2.840.10045.4.1': { kind: 'ecdsa', hash: 'sha1' }, '1.2.840.10045.4.3.1': { kind: 'ecdsa', hash: 'sha224' }, '1.2.840.10045.4.3.2': { kind: 'ecdsa', hash: 'sha256' },
  '1.2.840.10045.4.3.3': { kind: 'ecdsa', hash: 'sha384' }, '1.2.840.10045.4.3.4': { kind: 'ecdsa', hash: 'sha512' }, '1.2.840.10045.2.1': { kind: 'ecdsa' },
};
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';

export interface SodResult {
  ok: boolean;
  hashesOk: boolean;
  signatureOk: boolean;
  chainOk: boolean | 'skipped';
  dsSubject?: string;
  errors: string[];
}

function unwrapSod(sod: Uint8Array): Uint8Array {
  return sod[0] === 0x77 ? parseDer(sod).value : sod; // EF.SOD is wrapped in application tag 0x77
}
const hash = (alg: string, data: Uint8Array) => createHash(alg).update(data).digest();

export function verifySod(
  sodFile: Uint8Array,
  dataGroups: Record<number, Uint8Array>,
  opts: { csca: X509Certificate[]; strict: boolean },
): SodResult {
  const res: SodResult = { ok: false, hashesOk: false, signatureOk: false, chainOk: 'skipped', errors: [] };
  try {
    const ci = parseDer(unwrapSod(sodFile));
    const signedData = ci.children[1].children[0];
    const kids = signedData.children;
    const encap = kids.find((k) => k.tag === 0x30 && k.children[0]?.tag === 0x06 && derOid(k.children[0]) === '2.23.136.1.1.1');
    if (!encap) throw new Error('not an LDS security object');
    const eContent = encap.children[1].children[0].value; // [0] EXPLICIT OCTET STRING
    const lds = parseDer(eContent);
    const hashAlg = HASHES[derOid(lds.children[1].children[0])];
    if (!hashAlg) throw new Error('unsupported LDS hash algorithm');
    const expected = new Map<number, Uint8Array>();
    for (const dg of lds.children[2].children) expected.set(Number(derInt(dg.children[0])), dg.children[1].value);
    res.hashesOk = Object.entries(dataGroups).every(([n, bytes]) => {
      const e = expected.get(Number(n));
      const ok = !!e && Buffer.from(e).equals(hash(hashAlg, bytes));
      if (!ok) res.errors.push(`sod_hash_mismatch_dg${n}`);
      return ok;
    });

    // signer info + certificate
    const certsNode = kids.find((k) => k.tag === 0xa0);
    const signerInfos = kids[kids.length - 1];
    const si = signerInfos.children[0];
    const certNode = certsNode?.children[0];
    if (!certNode) throw new Error('SOD has no Document Signer certificate');
    const ds = new X509Certificate(Buffer.from(certNode.raw));
    res.dsSubject = ds.subject.replace(/\n/g, ', ');
    const siKids = si.children;
    const digestAlg = HASHES[derOid(siKids[2].children[0])];
    const attrs = siKids.find((k) => k.tag === 0xa0);
    const sigAlgNode = siKids[attrs ? 4 : 3];
    const signature = siKids[siKids.length - 1].value;
    let signedBytes: Uint8Array;
    if (attrs) {
      const md = attrs.children.find((a) => derOid(a.children[0]) === OID_MESSAGE_DIGEST);
      const mdValue = md?.children[1].children[0].value;
      if (!mdValue || !Buffer.from(mdValue).equals(hash(digestAlg, eContent))) throw new Error('SOD messageDigest does not match content');
      signedBytes = Uint8Array.from(attrs.raw); signedBytes[0] = 0x31; // re-tag [0] IMPLICIT as SET OF for signing
    } else signedBytes = eContent;

    const sigOid = derOid(sigAlgNode.children[0]);
    const spec = SIG[sigOid];
    if (!spec) throw new Error('unsupported SOD signature algorithm ' + sigOid);
    let ok: boolean;
    if (spec.kind === 'pss') {
      const params = sigAlgNode.children[1];
      const h = HASHES[derOid(params.children.find((c: Asn1) => c.tag === 0xa0)!.children[0].children[0])] ?? digestAlg;
      const saltNode = params.children.find((c: Asn1) => c.tag === 0xa2);
      const salt = saltNode ? Number(derInt(saltNode.children[0])) : 20;
      ok = cryptoVerify(h, signedBytes, { key: ds.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: salt }, signature);
    } else ok = cryptoVerify(spec.hash ?? digestAlg, signedBytes, ds.publicKey, signature);
    res.signatureOk = ok;
    if (!ok) res.errors.push('sod_signature_invalid');

    if (opts.csca.length) {
      res.chainOk = opts.csca.some((c) => ds.checkIssued(c) && ds.verify(c.publicKey));
      if (!res.chainOk) res.errors.push('csca_untrusted');
    } else if (opts.strict) { res.chainOk = false; res.errors.push('csca_not_configured'); }
    res.ok = res.hashesOk && res.signatureOk && (res.chainOk === true || (res.chainOk === 'skipped' && !opts.strict));
  } catch (e: any) {
    res.errors.push('sod_parse_error: ' + (e?.message ?? e));
  }
  void createPublicKey;
  return res;
}
