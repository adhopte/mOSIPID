// Mock PKI. "IN Groupe (Mock) IACA" is the root for identity mdocs; a separate education CA signs
// university attestations. Keys persist in the store (or come from env) so restarts keep the same anchors.
import { createRootCa, issueDocumentSigner, rememberDn, loadIssuedCert, privateKeyHex, IssuedCert, DN, Signer, parseCert } from '@mosipid/core';
import { Store } from '@mosipid/server-kit';

export interface Pki {
  iaca: IssuedCert; idSigner: IssuedCert;
  edu: IssuedCert; eduSigner: IssuedCert;
}
export const IACA_DN: DN = { C: 'FR', O: 'IN Groupe (Mock - not for production)', CN: 'IN Groupe Mock IACA' };
export const EDU_DN: DN = { C: 'IN', O: 'Mock India Education Trust (not for production)', CN: 'Mock India Education Trust CA' };

interface Persisted { caPem: string; caKey: string; dsPem: string; dsKey: string }

async function loadOne(store: Store, id: 'iaca' | 'edu', caDn: DN, dsDn: DN, altUri: string, envPrefix: string, eku?: string[]) {
  const env = process.env;
  let p = await store.get<Persisted>('pki', id);
  if (env[`${envPrefix}_CA_PEM`] && env[`${envPrefix}_CA_KEY`] && env[`${envPrefix}_DS_PEM`] && env[`${envPrefix}_DS_KEY`]) {
    p = { caPem: env[`${envPrefix}_CA_PEM`]!.replace(/\\n/g, '\n'), caKey: env[`${envPrefix}_CA_KEY`]!, dsPem: env[`${envPrefix}_DS_PEM`]!.replace(/\\n/g, '\n'), dsKey: env[`${envPrefix}_DS_KEY`]! };
  }
  let ca: IssuedCert;
  let ds: IssuedCert;
  const now = new Date();
  if (p) {
    ca = rememberDn(loadIssuedCert(p.caPem, p.caKey), caDn);
    ds = loadIssuedCert(p.dsPem, p.dsKey);
    if (ds.cert.notAfter.getTime() - now.getTime() < 30 * 86400_000) { // rotate the Document Signer when it is close to expiry
      ds = issueDocumentSigner(ca, { subject: dsDn, altNameUri: altUri, eku });
      await store.set('pki', id, { ...p, dsPem: ds.pem, dsKey: privateKeyHex(ds.key) });
    }
  } else {
    ca = rememberDn(createRootCa({ subject: caDn, altNameUri: altUri, years: 15 }), caDn);
    ds = issueDocumentSigner(ca, { subject: dsDn, altNameUri: altUri, eku });
    await store.set('pki', id, { caPem: ca.pem, caKey: privateKeyHex(ca.key), dsPem: ds.pem, dsKey: privateKeyHex(ds.key) });
    console.log(`[pki] generated new ${id} trust chain`);
  }
  return { ca, ds };
}

export async function loadPki(store: Store, publicUrl: string): Promise<Pki> {
  const a = await loadOne(store, 'iaca', IACA_DN, { ...IACA_DN, CN: 'IN Groupe Mock Document Signer 01' }, publicUrl, 'IACA');
  const b = await loadOne(store, 'edu', EDU_DN, { ...EDU_DN, CN: 'Mock Education Attestation Signer 01' }, publicUrl, 'EDU', ['1.3.6.1.5.5.7.3.36']);
  return { iaca: a.ca, idSigner: a.ds, edu: b.ca, eduSigner: b.ds };
}

export const toSigner = (c: IssuedCert): Signer => ({ privateKey: c.key.privateKey, chain: [c.der] });

export function trustList(p: Pki, publicUrl: string) {
  const entry = (id: string, name: string, use: string, c: IssuedCert) => ({ id, name, use, pem: c.pem, subject: c.cert.subject, notAfter: c.cert.notAfter.toISOString(), source: publicUrl });
  return [
    entry('iaca', 'IN Groupe (Mock) IACA', 'mdoc-identity', p.iaca),
    entry('edu', 'Mock India Education Trust CA', 'sd-jwt-education', p.edu),
  ];
}
void parseCert;
