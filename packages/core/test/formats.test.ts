import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRootCa, issueDocumentSigner, rememberDn } from '../src/pki';
import { generateKeyPair, cbor, Tagged, b64u, fullDate, issueMdoc, buildDeviceResponse, verifyDeviceResponse, openid4vpTranscript,
  listIssuerSignedClaims, issueSdJwt, presentSdJwt, verifySdJwtPresentation, parseMrz, extractMrz, checkDigit, verifyChain, parseCert,
  buildDeviceEngagement, parseDeviceEngagement, SecureSession, proximityTranscript, buildDeviceRequest, parseDeviceRequest, mdocDocType, ageOver } from '../src';

const iacaDn = { C: 'FR', O: 'IN Groupe (Mock)', CN: 'IN Groupe Mock IACA' };
function pki() {
  const iaca = rememberDn(createRootCa({ subject: iacaDn, crlUrl: 'https://x.test/crl', altNameUri: 'https://x.test' }), iacaDn);
  const ds = issueDocumentSigner(iaca, { subject: { C: 'FR', O: 'IN Groupe (Mock)', CN: 'Mock DS 1' } });
  return { iaca, ds };
}
const holder = generateKeyPair();

test('cbor round trip incl. tags, maps, bytes, negatives', () => {
  const v = new Map<unknown, unknown>([['a', 1], [-3, new Uint8Array([1, 2, 3])], ['t', new Tagged(1004, '2020-01-01')], ['n', null], ['arr', [true, false, -1000, 2 ** 40]]]);
  const back = cbor.decode(cbor.encode(v)) as Map<unknown, any>;
  assert.equal(back.get('a'), 1);
  assert.deepEqual([...back.get(-3)], [1, 2, 3]);
  assert.equal(back.get('t').tag, 1004);
  assert.deepEqual(back.get('arr'), [true, false, -1000, 2 ** 40]);
  // known vector: {1: 2} => a10102
  assert.equal(Buffer.from(cbor.encode(new Map([[1, 2]]))).toString('hex'), 'a10102');
});

test('certificates: chain validation, tampering and expiry', () => {
  const { iaca, ds } = pki();
  assert.equal(verifyChain([ds.cert], [iaca.cert], { requireEku: '1.0.18013.5.1.2' }).ok, true);
  const other = pki();
  assert.equal(verifyChain([ds.cert], [other.iaca.cert]).ok, false);
  assert.equal(verifyChain([ds.cert], [iaca.cert], { now: new Date(Date.now() + 500 * 24 * 3600_000) }).ok, false);
  assert.ok(iaca.cert.isCA);
  assert.equal(parseCert(ds.der).issuer, iaca.cert.subject);
});

function makeMdoc() {
  const { iaca, ds } = pki();
  const issuerSigned = issueMdoc({
    docType: 'io.mosipid.identity.1', deviceKey: holder.publicJwk, signer: { privateKey: ds.key.privateKey, chain: [ds.der] },
    validUntil: new Date(Date.now() + 86400_000 * 30),
    namespaces: { 'io.mosipid.identity.1': { family_name: 'Doe', given_name: 'Jane', birth_date: fullDate('1990-05-01'), age_over_18: true, portrait: new Uint8Array([1, 2, 3]), document_number: 'X123' } },
  });
  return { iaca, ds, issuerSigned };
}

test('mdoc: issue -> selective present -> verify (OpenID4VP transcript)', () => {
  const { iaca, issuerSigned } = makeMdoc();
  assert.equal(mdocDocType(issuerSigned), 'io.mosipid.identity.1');
  const transcript = openid4vpTranscript({ clientId: 'redirect_uri:https://v.test/r', nonce: 'n-1', responseUri: 'https://v.test/r' });
  const resp = buildDeviceResponse({ documents: [{ issuerSigned, deviceKeyPriv: holder.privateKey, requested: { 'io.mosipid.identity.1': ['family_name', 'age_over_18'] } }], sessionTranscript: transcript });
  const res = verifyDeviceResponse(resp, { sessionTranscript: transcript, trustAnchors: [iaca.cert] });
  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) {
    assert.deepEqual(res.documents[0].claims['io.mosipid.identity.1'], { family_name: 'Doe', age_over_18: true });
    assert.match(res.documents[0].anchorSubject, /IN Groupe Mock IACA/);
  }
  // all claims are visible to the holder
  assert.equal(listIssuerSignedClaims(issuerSigned)['io.mosipid.identity.1'].birth_date, '1990-05-01');
});

test('mdoc: replay with different nonce, wrong anchor, tampered element and wrong holder are rejected', () => {
  const { iaca, issuerSigned } = makeMdoc();
  const t1 = openid4vpTranscript({ clientId: 'c', nonce: 'n1', responseUri: 'https://v.test/r' });
  const t2 = openid4vpTranscript({ clientId: 'c', nonce: 'n2', responseUri: 'https://v.test/r' });
  const resp = buildDeviceResponse({ documents: [{ issuerSigned, deviceKeyPriv: holder.privateKey, requested: { 'io.mosipid.identity.1': ['family_name'] } }], sessionTranscript: t1 });
  assert.equal(verifyDeviceResponse(resp, { sessionTranscript: t2, trustAnchors: [iaca.cert] }).ok, false);
  assert.equal(verifyDeviceResponse(resp, { sessionTranscript: t1, trustAnchors: [pki().iaca.cert] }).ok, false);
  const thief = generateKeyPair();
  const stolen = buildDeviceResponse({ documents: [{ issuerSigned, deviceKeyPriv: thief.privateKey, requested: { 'io.mosipid.identity.1': ['family_name'] } }], sessionTranscript: t1 });
  assert.equal(verifyDeviceResponse(stolen, { sessionTranscript: t1, trustAnchors: [iaca.cert] }).ok, false);
  // flip a byte of the disclosed value
  const bytes = resp.slice(); const i = Buffer.from(bytes).indexOf(Buffer.from('Doe')); bytes[i] = 0x58;
  const r = verifyDeviceResponse(bytes, { sessionTranscript: t1, trustAnchors: [iaca.cert] });
  assert.equal(r.ok, false);
});

test('SD-JWT VC: issue -> present subset -> verify; nonce/aud/holder binding enforced', () => {
  const { iaca, ds } = pki();
  const sd = issueSdJwt({ iss: 'https://uni.test', vct: 'https://x/vct', claims: { student_id: 'S1', degree: 'B.Tech', cgpa: 8.7, given_name: 'Asha' }, holderKey: holder.publicJwk, signer: { privateKey: ds.key.privateKey, chain: [ds.der] }, validitySeconds: 3600 });
  const pres = presentSdJwt(sd, ['student_id', 'degree'], holder.privateKey, 'https://v.test', 'nonce-1');
  const ok = verifySdJwtPresentation(pres, { trustAnchors: [iaca.cert], aud: 'https://v.test', nonce: 'nonce-1' });
  assert.ok(ok.ok, JSON.stringify(ok));
  if (ok.ok) { assert.equal(ok.claims.degree, 'B.Tech'); assert.equal(ok.claims.cgpa, undefined); }
  assert.equal(verifySdJwtPresentation(pres, { trustAnchors: [iaca.cert], aud: 'https://v.test', nonce: 'other' }).ok, false);
  assert.equal(verifySdJwtPresentation(pres, { trustAnchors: [iaca.cert], aud: 'https://evil.test', nonce: 'nonce-1' }).ok, false);
  const forged = presentSdJwt(sd, ['student_id'], generateKeyPair().privateKey, 'https://v.test', 'nonce-1');
  assert.equal(verifySdJwtPresentation(forged, { trustAnchors: [iaca.cert], aud: 'https://v.test', nonce: 'nonce-1' }).ok, false);
});

test('MRZ: ICAO specimen TD3 parses with valid checksums; OCR noise is repaired', () => {
  const lines = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'];
  const m = parseMrz(lines);
  assert.ok(m.checksOk, JSON.stringify(m.checks));
  assert.equal(m.surname, 'ERIKSSON'); assert.equal(m.givenNames, 'ANNA MARIA'); assert.equal(m.birthDate, '1974-08-12'); assert.equal(m.expiryDate, '2012-04-15'); assert.equal(m.sex, 'F');
  assert.equal(checkDigit('520727'), '3');
  const noisy = 'junk header\n' + lines[0] + '\nL898902C36UT07408I22F12O4159ZE184226B<<<<<10\nfooter';
  const rec = extractMrz(noisy);
  assert.ok(rec?.checksOk, 'repair failed');
  assert.equal(rec!.documentNumber, 'L898902C3');
  const td1 = parseMrz(['I<UTOD231458907<<<<<<<<<<<<<<<', '7408122F1204159UTO<<<<<<<<<<<6', 'ERIKSSON<<ANNA<MARIA<<<<<<<<<<']);
  assert.ok(td1.checksOk); assert.equal(td1.format, 'TD1');
  assert.equal(ageOver('2000-01-01', 18, new Date('2026-09-30')), true);
  assert.equal(ageOver('2010-01-01', 18, new Date('2026-09-30')), false);
});

test('MRZ: real Tesseract output (O/0 in nationality, garbled composite digit) is repaired', () => {
  const ocr = 'PASSEPORT\nP<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<L<\nL898902C36UT07408122F2909303<<<<<<<<<<<<<<<H\n';
  const m = extractMrz(ocr);
  assert.ok(m?.checksOk, JSON.stringify(m?.checks));
  assert.equal(m!.nationality, 'UTO'); assert.equal(m!.documentNumber, 'L898902C3'); assert.equal(m!.givenNames, 'ANNA MARIA');
  // a genuinely wrong field-level digit must NOT be papered over
  assert.equal(extractMrz('P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C46UTO7408122F2909303<<<<<<<<<<<<<<<6')?.checksOk, false);
});

test('ISO 18013-5 session: engagement, key agreement and encrypted request/response', () => {
  const dev = generateKeyPair(), rdr = generateKeyPair();
  const eng = buildDeviceEngagement(dev, { url: 'https://relay.test', sessionId: 'abc' });
  const parsed = parseDeviceEngagement(eng.bytes);
  assert.equal(parsed.relay?.sessionId, 'abc');
  const tr = proximityTranscript(eng.bytes, rdr.publicJwk);
  const reader = new SecureSession(rdr.privateKey, parsed.eDeviceKey, tr, 'reader');
  const device = new SecureSession(dev.privateKey, rdr.publicJwk, tr, 'device');
  const req = buildDeviceRequest({ 'io.mosipid.identity.1': { 'io.mosipid.identity.1': ['family_name'] } });
  assert.deepEqual(parseDeviceRequest(device.decrypt(reader.encrypt(req))), { 'io.mosipid.identity.1': { 'io.mosipid.identity.1': ['family_name'] } });
  assert.equal(new TextDecoder().decode(reader.decrypt(device.encrypt(new TextEncoder().encode('hello')))), 'hello');
  assert.throws(() => device.decrypt(new Uint8Array(40)));
  void b64u;
});
