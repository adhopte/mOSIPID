import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '@mosipid/server-kit';
import { verifyChain, privateKeyHex } from '@mosipid/core';
import { loadPki, trustList } from '../src/trust';

test('trust anchors are stable across restarts; Document Signer rotates before expiry without changing the IACA', async () => {
  const store = new MemoryStore();
  const a = await loadPki(store, 'https://issuer.test');
  const b = await loadPki(store, 'https://issuer.test'); // "restart"
  assert.equal(b.iaca.pem, a.iaca.pem);
  assert.equal(b.idSigner.pem, a.idSigner.pem);
  assert.equal(b.edu.pem, a.edu.pem);
  assert.match(a.iaca.cert.subject, /IN Groupe Mock IACA/);
  assert.ok(verifyChain([a.idSigner.cert], [a.iaca.cert], { requireEku: '1.0.18013.5.1.2' }).ok);
  assert.ok(verifyChain([a.eduSigner.cert], [a.edu.cert]).ok);
  assert.equal(verifyChain([a.eduSigner.cert], [a.iaca.cert]).ok, false, 'education signer must not chain to the IACA');

  // expire the stored DS soon → next load issues a fresh one under the same IACA
  const rec = await store.get('pki', 'iaca');
  const { createRootCa, issueDocumentSigner, rememberDn, loadIssuedCert } = await import('@mosipid/core');
  const ca = rememberDn(loadIssuedCert(rec.caPem, rec.caKey), { C: 'FR', O: 'IN Groupe (Mock - not for production)', CN: 'IN Groupe Mock IACA' });
  const old = issueDocumentSigner(ca, { subject: { C: 'FR', CN: 'old ds' }, days: 5 });
  await store.set('pki', 'iaca', { ...rec, dsPem: old.pem, dsKey: privateKeyHex(old.key) });
  const c = await loadPki(store, 'https://issuer.test');
  assert.notEqual(c.idSigner.pem, old.pem);
  assert.equal(c.iaca.pem, a.iaca.pem);
  assert.ok(verifyChain([c.idSigner.cert], [c.iaca.cert]).ok);
  void createRootCa;

  const list = trustList(c, 'https://issuer.test');
  assert.deepEqual(list.map((x) => x.id), ['iaca', 'edu']);
});
