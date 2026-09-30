import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from 'node:net';
import { createPrivateKey, sign as cryptoSign, createHash } from 'node:crypto';
import {
  resolveOffer, receivePreAuthorized, resolveAuthorizationRequest, matchCredentials, submitResponse, claimsToShare, fetchIssuerMetadata, fetchAuthServerMetadata,
  createPkce, buildAuthorizationUrl, tokenAuthorizationCode, requestCredential, toStoredCredential, generateKeyPair, parseQuery, checkDigit, derEnc, b64u, toBase64,
  createRootCa, issueDocumentSigner, receiveWithAuthorizationCode, rememberDn, HolderProximity, ReaderProximity, parseCert, oid, StoredCredential, DOCTYPE_ID, NS_ID, listIssuerSignedClaims,
  buildDeviceResponse, openid4vpTranscript, concat, utf8,
} from '@mosipid/core';
import { MemoryStore, PgStore, Store } from '@mosipid/server-kit';
import { buildApp as buildAdmin } from '../../admin/src/app';
import { buildApp as buildIssuer } from '../../issuer/src/app';
import { loadConfig } from '../../issuer/src/config';
import { buildApp as buildVerifier } from '../src/app';
import { TrustService } from '../src/trust';

const servers: http.Server[] = [];
const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
const listen = (app: any, port: number) => new Promise<void>((res) => { servers.push(app.listen(port, '127.0.0.1', res)); });

let admin: string, issuer: string, verifier: string;
let wallet: StoredCredential[] = [];
const csca = rememberDn(createRootCa({ subject: { C: 'UT', O: 'Utopia', CN: 'Utopia CSCA' } }), { C: 'UT', O: 'Utopia', CN: 'Utopia CSCA' });

// TEST_DATABASE_URL=postgres://… runs the whole suite against a real Postgres (all three services share one DB, as on Render)
async function makeStore(): Promise<Store> {
  if (!process.env.TEST_DATABASE_URL) return new MemoryStore();
  const pg: any = await import('pg');
  const s = new PgStore(process.env.TEST_DATABASE_URL, pg.default ?? pg);
  await new Promise((r) => setTimeout(r, 300));
  await (s as any).pool.query('DROP TABLE IF EXISTS kv');
  (s as any).ready = (s as any).pool.query('CREATE TABLE IF NOT EXISTS kv (ns text NOT NULL, key text NOT NULL, value jsonb NOT NULL, expires_at timestamptz, PRIMARY KEY (ns, key))');
  return s;
}

before(async () => {
  const sharedStore = await makeStore();
  const [pa, pi, pv] = [await freePort(), await freePort(), await freePort()];
  admin = `http://127.0.0.1:${pa}`; issuer = `http://127.0.0.1:${pi}`; verifier = `http://127.0.0.1:${pv}`;
  await listen(buildAdmin({ store: sharedStore, user: 'root', password: 's3cret', secret: 'x'.repeat(32), publicUrl: admin }), pa);
  const cfg = loadConfig({}, { publicUrl: issuer, adminUrl: admin, ocrProvider: 'mock', cscaPems: [csca.pem], passiveAuth: 'strict', faceProvider: 'mock' });
  await listen(await buildIssuer(sharedStore, cfg), pi);
  await listen(buildVerifier(sharedStore, { publicUrl: verifier, adminUrl: admin, issuerUrl: issuer, secret: 'y'.repeat(32), brandCacheMs: 0 }, new TrustService([issuer])), pv);
});
after(() => { servers.forEach((s) => s.close()); setTimeout(() => process.exit(0), 100).unref(); });

const post = (url: string, body: any, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// ---- MRZ / passport helpers -------------------------------------------------
function td3(o: { surname: string; given: string; docNo: string; dob: string; exp: string; sex?: string }) {
  const l1 = `P<UTO${o.surname}<<${o.given}`.padEnd(44, '<');
  const dn = o.docNo.padEnd(9, '<');
  const body = dn + checkDigit(dn) + 'UTO' + o.dob + checkDigit(o.dob) + (o.sex ?? 'F') + o.exp + checkDigit(o.exp) + '<'.repeat(14) + '<';
  const l2 = body + checkDigit(dn + checkDigit(dn) + o.dob + checkDigit(o.dob) + o.exp + checkDigit(o.exp) + '<'.repeat(14) + '<');
  return [l1, l2];
}
const yymmdd = (d: Date) => d.toISOString().slice(2, 10).replace(/-/g, '');
const future = yymmdd(new Date(Date.now() + 3 * 365 * 86400_000));
const seq = (...p: Uint8Array[]) => derEnc(0x30, concat(...p));
const tlvB = (tag: number, v: Uint8Array) => { const l = v.length < 128 ? [v.length] : v.length < 256 ? [0x81, v.length] : [0x82, v.length >> 8, v.length & 255]; return concat(Uint8Array.of(tag, ...l), v); };
const int = (n: number) => derEnc(0x02, Uint8Array.of(n));
const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());

function makePassport(lines: string[], signer = issueDocumentSigner(csca, { subject: { C: 'UT', O: 'Utopia', CN: 'Utopia DS' }, eku: [] })) {
  const mrz = utf8(lines.join(''));
  const dg1Proper = tlvB(0x61, concat(Uint8Array.of(0x5f, 0x1f), mrz.length < 128 ? Uint8Array.of(mrz.length) : Uint8Array.of(0x81, mrz.length), mrz));
  const jpeg = concat(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), new Uint8Array(1500).fill(7));
  const dg2 = tlvB(0x75, concat(new Uint8Array(20).fill(1), jpeg));
  const sha256Alg = seq(oid('2.16.840.1.101.3.4.2.1'));
  const lds = seq(int(0), sha256Alg, seq(seq(int(1), derEnc(0x04, sha256(dg1Proper))), seq(int(2), derEnc(0x04, sha256(dg2)))));
  const attrs = concat(
    seq(oid('1.2.840.113549.1.9.3'), derEnc(0x31, oid('2.23.136.1.1.1'))),
    seq(oid('1.2.840.113549.1.9.4'), derEnc(0x31, derEnc(0x04, sha256(lds)))),
  );
  const attrsForSig = derEnc(0x31, attrs);
  const d = b64u.encode(signer.key.privateKey);
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: signer.key.publicJwk.x, y: signer.key.publicJwk.y, d }, format: 'jwk' });
  const signature = new Uint8Array(cryptoSign('sha256', attrsForSig, key));
  const signerInfo = seq(int(1), seq(seq(), int(1)), sha256Alg, derEnc(0xa0, attrs), seq(oid('1.2.840.10045.4.3.2')), derEnc(0x04, signature));
  const signedData = seq(int(3), derEnc(0x31, sha256Alg), seq(oid('2.23.136.1.1.1'), derEnc(0xa0, derEnc(0x04, lds))), derEnc(0xa0, signer.der), derEnc(0x31, signerInfo));
  const sod = tlvB(0x77, seq(oid('1.2.840.113549.1.7.2'), derEnc(0xa0, signedData)));
  return { dg1: dg1Proper, dg2, sod };
}

// ---- tests ------------------------------------------------------------------
test('issuer metadata + trust anchors are published', async () => {
  const m = await fetchIssuerMetadata(issuer);
  assert.ok(m.credential_configurations_supported.mosipid_identity_mdoc);
  assert.equal(m.credential_configurations_supported.university_degree_sdjwt.format, 'dc+sd-jwt');
  const as = await fetchAuthServerMetadata(issuer);
  assert.match(as.token_endpoint, /\/token$/);
  const trust = await (await fetch(`${verifier}/api/trust`)).json();
  assert.deepEqual(trust.anchors.map((a: any) => a.id).sort(), ['edu', 'iaca']);
  assert.match(trust.anchors[0].subject + trust.anchors[1].subject, /IN Groupe Mock IACA/);
});

test('degree attestation via pre-authorized code + tx_code (PIN)', async () => {
  const bad = await post(`${issuer}/api/university/preauth`, { studentId: 'BIT2020CS001', dob: '1999-01-01' });
  assert.equal(bad.status, 401);
  const r = await (await post(`${issuer}/api/university/preauth`, { studentId: 'BIT2020CS001', dob: '2002-03-14' })).json();
  assert.match(r.tx_code, /^\d{4}$/);
  const offer = await resolveOffer(r.offer_uri);
  await assert.rejects(receivePreAuthorized({ offer, txCode: '0000'.replace(/0/g, r.tx_code === '0000' ? '1' : '0') }));
  const creds = await receivePreAuthorized({ offer, txCode: r.tx_code });
  assert.equal(creds[0].format, 'dc+sd-jwt');
  assert.equal(creds[0].brandingTenant, 'issuer-university');
  wallet.push(creds[0]);
});

test('degree attestation via authorization-code flow + PKCE + University ID login', async () => {
  const { offer_uri } = await (await post(`${issuer}/api/university/offer`, {})).json();
  const offer = await resolveOffer(offer_uri);
  assert.ok(offer.grants?.authorization_code);
  const meta = await fetchIssuerMetadata(issuer); const as = await fetchAuthServerMetadata(issuer);
  const pkce = createPkce();
  const url = buildAuthorizationUrl({ endpoint: as.authorization_endpoint!, clientId: 'mosipid-wallet', redirectUri: 'mosipidwallet://oauth/callback', scope: 'university_degree', state: 'st1', challenge: pkce.challenge, issuer });
  const redir = await fetch(url, { redirect: 'manual' });
  assert.equal(redir.status, 302);
  const reqId = parseQuery(redir.headers.get('location')!).req;
  assert.equal((await post(`${issuer}/authorize/login`, { req: reqId, studentId: 'BIT2020CS001', dob: '2000-01-01' })).status, 401);
  const ok = await (await post(`${issuer}/authorize/login`, { req: reqId, studentId: 'bit2019ee042', dob: '2001-11-02' })).json();
  const q = parseQuery(ok.redirect);
  assert.equal(q.state, 'st1'); assert.ok(ok.redirect.startsWith('mosipidwallet://oauth/callback'));
  const key = generateKeyPair();
  await assert.rejects(tokenAuthorizationCode(as.token_endpoint, { code: q.code, verifier: 'wrong-verifier', redirectUri: 'mosipidwallet://oauth/callback', clientId: 'mosipid-wallet' }));
  // the wrong-verifier attempt burned the code (single use)
  await assert.rejects(tokenAuthorizationCode(as.token_endpoint, { code: q.code, verifier: pkce.verifier, redirectUri: 'mosipidwallet://oauth/callback', clientId: 'mosipid-wallet' }));
  // second login for a fresh code
  const redir2 = await fetch(buildAuthorizationUrl({ endpoint: as.authorization_endpoint!, clientId: 'mosipid-wallet', redirectUri: 'mosipidwallet://oauth/callback', scope: 'university_degree', state: 's2', challenge: pkce.challenge, issuer }), { redirect: 'manual' });
  const ok2 = await (await post(`${issuer}/authorize/login`, { req: parseQuery(redir2.headers.get('location')!).req, studentId: 'BIT2019EE042', dob: '2001-11-02' })).json();
  const tok = await tokenAuthorizationCode(as.token_endpoint, { code: parseQuery(ok2.redirect).code, verifier: pkce.verifier, redirectUri: 'mosipidwallet://oauth/callback', clientId: 'mosipid-wallet' });
  const issued = await requestCredential({ meta, configId: 'university_degree_sdjwt', accessToken: tok.access_token, cNonce: tok.c_nonce, key });
  const c = toStoredCredential({ issued, configId: 'university_degree_sdjwt', meta, key });
  assert.equal(c.format, 'dc+sd-jwt');
  // disallowed redirect_uri is refused
  const evil = await fetch(buildAuthorizationUrl({ endpoint: as.authorization_endpoint!, clientId: 'x', redirectUri: 'https://evil.example/cb', scope: 'university_degree', state: 's', challenge: pkce.challenge, issuer }), { redirect: 'manual' });
  assert.equal(evil.status, 400);
});

test('wallet helper receiveWithAuthorizationCode drives the whole flow (browser callback simulated)', async () => {
  const offer = await resolveOffer((await (await post(`${issuer}/api/university/offer`, {})).json()).offer_uri);
  const creds = await receiveWithAuthorizationCode({
    offer, clientId: 'mosipid-wallet', redirectUri: 'mosipidwallet://oauth/callback',
    authorize: async (url) => {
      const r = await fetch(url, { redirect: 'manual' });
      const req = parseQuery(r.headers.get('location')!).req;
      return (await (await post(`${issuer}/authorize/login`, { req, studentId: 'BIT2022DS003', dob: '2000-12-09' })).json()).redirect;
    },
  });
  assert.equal(creds.length, 1); assert.equal(creds[0].configId, 'university_degree_sdjwt');
  // a cancelled browser session surfaces as an error, not a hang
  await assert.rejects(receiveWithAuthorizationCode({ offer, clientId: 'x', redirectUri: 'mosipidwallet://oauth/callback', authorize: async () => 'mosipidwallet://oauth/callback?error=access_denied' }), /access_denied/);
});

async function enrollAndIssue(method: 'ocr' | 'nfc', proof: (sid: string) => Promise<Response>) {
  const e = await (await post(`${issuer}/api/enroll`, { method })).json();
  const offer = await resolveOffer(e.offer_uri);
  assert.equal(offer.x_proofing?.session_id, e.sid);
  // the wallet's token request must wait for proofing
  const pending = await fetch(`${issuer}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Apre-authorized_code&pre-authorized_code=${offer.grants!['urn:ietf:params:oauth:grant-type:pre-authorized_code']!['pre-authorized_code']}` });
  assert.equal((await pending.json()).error, 'authorization_pending');
  const issuing = receivePreAuthorized({ offer, timeoutMs: 20_000 });
  const r = await proof(e.sid);
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await (await fetch(`${issuer}/api/enroll/${e.sid}`)).json()).status, 'verified');
  const creds = await issuing;
  const status = (await (await fetch(`${issuer}/api/enroll/${e.sid}`)).json()).status;
  assert.equal(status, 'issued');
  return { creds, sid: e.sid };
}
let realJpeg = Buffer.alloc(4000, 9);
before(async () => { try { const sharp = (await import('sharp')).default; realJpeg = await sharp({ create: { width: 120, height: 160, channels: 3, background: { r: 200, g: 120, b: 90 } } }).jpeg().toBuffer(); } catch { /* sharp optional */ } });
const fakeImg = () => realJpeg.toString('base64');

test('manual PID entry → pre-authorised offer with PIN → mdoc marked self_asserted', async () => {
  const bad = await post(`${issuer}/api/pid/manual`, { family_name: 'X1', given_names: 'Asha', birth_date: '1990-01-01' });
  assert.equal(bad.status, 400);
  assert.equal((await post(`${issuer}/api/pid/manual`, { family_name: 'Verma', given_names: 'Asha', birth_date: '2999-01-01' })).status, 400);
  const r = await (await post(`${issuer}/api/pid/manual`, { family_name: 'verma', given_names: 'asha rani', birth_date: '1990-05-17', sex: 'F', nationality: 'ind', document_number: 'p1234567' })).json();
  assert.match(r.tx_code, /^\d{4}$/); assert.equal(r.assurance_level, 'self_asserted');
  const offer = await resolveOffer(r.offer_uri);
  await assert.rejects(receivePreAuthorized({ offer, txCode: r.tx_code === '0000' ? '1111' : '0000' }));
  const [cred] = await receivePreAuthorized({ offer, txCode: r.tx_code });
  const c = listIssuerSignedClaims(b64u.decode(cred.raw))[NS_ID];
  assert.equal(c.family_name, 'Verma'); assert.equal(c.given_name, 'Asha Rani'); assert.equal(c.nationality, 'IN');
  assert.equal(c.assurance_level, 'self_asserted'); assert.equal(c.verification_method, 'manual_entry_unverified');
  assert.equal(c.age_over_18, true);
  // and it is still a valid, verifiable credential
  const { req, matches } = await remoteLogin('electricity', [cred]);
  await submitResponse(req, matches);
});

test('uploaded document image: ML Kit text from the phone is accepted, flagged as upload (low assurance)', async () => {
  const good = td3({ surname: 'ERIKSSON', given: 'ANNA<MARIA', docNo: 'L898902C3', dob: '740812', exp: future });
  const { creds } = await enrollAndIssue('ocr', async (sid) => {
    // the phone read the MRZ with ML Kit (noisy text); the server never needs to OCR it
    const ocrText = 'REPUBLIC OF UTOPIA\n' + good[0] + '\n' + good[1].replace('UTO', 'UT0');
    assert.equal((await post(`${issuer}/api/proofing/${sid}/ocr`, { images: [fakeImg(), fakeImg()], selfie: fakeImg(), ocr_text: 'garbage', capture_source: 'upload', debug_mrz: undefined })).status, 422);
    return post(`${issuer}/api/proofing/${sid}/ocr`, { images: [fakeImg(), fakeImg()], selfie: fakeImg(), turn_left: fakeImg(), turn_right: fakeImg(), ocr_text: ocrText, capture_source: 'upload' });
  });
  const c = listIssuerSignedClaims(b64u.decode(creds[0].raw))[NS_ID];
  assert.equal(c.verification_method, 'uploaded_document_face_match');
  assert.equal(c.family_name, 'Eriksson');
});

test('ID via optical MRZ + selfie: failure paths then success', async () => {
  const good = td3({ surname: 'ERIKSSON', given: 'ANNA<MARIA', docNo: 'L898902C3', dob: '740812', exp: future });
  const { creds, sid } = await enrollAndIssue('ocr', async (sid) => {
    assert.equal((await post(`${issuer}/api/proofing/${sid}/ocr`, { image: fakeImg(), selfie: fakeImg(), debug_mrz: ['garbage'] })).status, 422);
    const broken = [good[0], good[1].slice(0, 14) + String((+good[1][14] + 1) % 10) + good[1].slice(15)];
    const badRes = await post(`${issuer}/api/proofing/${sid}/ocr`, { image: fakeImg(), selfie: fakeImg(), debug_mrz: broken });
    assert.equal((await badRes.json()).error, 'mrz_checksum_failed');
    const expired = td3({ surname: 'X', given: 'Y', docNo: 'A1234567', dob: '800101', exp: '200101' });
    assert.equal((await (await post(`${issuer}/api/proofing/${sid}/ocr`, { image: fakeImg(), selfie: fakeImg(), debug_mrz: expired })).json()).error, 'document_expired');
    assert.equal((await post(`${issuer}/api/proofing/${sid}/ocr`, { image: fakeImg(), debug_mrz: good })).status, 400); // selfie required
    assert.equal((await (await post(`${issuer}/api/proofing/${sid}/probe`, { image: fakeImg(), debug_mrz: good })).json()).valid, true);
    return post(`${issuer}/api/proofing/${sid}/ocr`, { image: fakeImg(), selfie: fakeImg(), debug_mrz: good });
  });
  assert.equal(creds[0].format, 'mso_mdoc');
  const claims = listIssuerSignedClaims(b64u.decode(creds[0].raw))[NS_ID];
  assert.equal(claims.family_name, 'Eriksson'); assert.equal(claims.given_name, 'Anna Maria');
  assert.equal(claims.birth_date, '1974-08-12'); assert.equal(claims.issuing_country, 'FR');
  assert.equal(claims.verification_method, 'optical_mrz_face_match'); assert.equal(claims.assurance_level, 'demo');
  assert.ok(claims.portrait instanceof Uint8Array);
  wallet.push(creds[0]);
  // session data is wiped after issuance and cannot be reused
  assert.equal((await post(`${issuer}/api/proofing/${sid}/ocr`, { image: fakeImg(), selfie: fakeImg(), debug_mrz: good })).status, 409);
});

test('ID via NFC chip data: passive authentication (hashes + SOD signature + CSCA chain)', async () => {
  const lines = td3({ surname: 'MULLER', given: 'HANS', docNo: 'C01X00T47', dob: '850412', exp: future, sex: 'M' });
  const pp = makePassport(lines);
  const { creds } = await enrollAndIssue('nfc', async (sid) => {
    const tampered = { ...pp, dg2: pp.dg2.slice() }; tampered.dg2[40] ^= 1;
    const enc = (p: any) => ({ dg1: toBase64(p.dg1), dg2: toBase64(p.dg2), sod: toBase64(p.sod), selfie: fakeImg() });
    assert.equal((await (await post(`${issuer}/api/proofing/${sid}/nfc`, enc(tampered))).json()).error, 'sod_hash_mismatch_dg2');
    const rogue = makePassport(lines, issueDocumentSigner(createRootCa({ subject: { C: 'UT', CN: 'Rogue CSCA' } }), { subject: { C: 'UT', CN: 'Rogue DS' }, eku: [] }));
    assert.equal((await (await post(`${issuer}/api/proofing/${sid}/nfc`, enc(rogue))).json()).error, 'csca_untrusted');
    const forged = { ...pp, sod: pp.sod.slice() }; forged.sod[forged.sod.length - 5] ^= 0xff;
    assert.equal((await post(`${issuer}/api/proofing/${sid}/nfc`, enc(forged))).status, 422);
    return post(`${issuer}/api/proofing/${sid}/nfc`, enc(pp));
  });
  const claims = listIssuerSignedClaims(b64u.decode(creds[0].raw))[NS_ID];
  assert.equal(claims.family_name, 'Muller'); assert.equal(claims.verification_method, 'nfc_chip_passive_auth');
  assert.equal(claims.sex, 1);
  wallet = wallet.filter((c) => c.format !== 'mso_mdoc'); wallet.push(creds[0]);
});

async function remoteLogin(flow: 'electricity' | 'university', creds: StoredCredential[]) {
  const s = await (await post(`${verifier}/api/sessions`, { flow })).json();
  const req = await resolveAuthorizationRequest(s.request_uri);
  const matches = matchCredentials(req, creds);
  return { s, req, matches };
}

test('remote verifier: electricity login with the ID credential (mdoc, IACA chain)', async () => {
  const { s, req, matches } = await remoteLogin('electricity', wallet);
  assert.ok(matches[0].available);
  assert.ok(claimsToShare(matches[0]).some((c) => c.name === 'family_name'));
  assert.equal((await (await fetch(`${verifier}/api/sessions/${s.id}?token=wrong`)).status), 404);
  assert.equal((await (await fetch(`${verifier}/api/sessions/${s.id}?token=${s.poll_token}`)).json()).status, 'pending');
  await submitResponse(req, matches);
  const poll = await fetch(`${verifier}/api/sessions/${s.id}?token=${s.poll_token}`);
  assert.equal((await poll.json()).status, 'verified');
  const cookie = poll.headers.get('set-cookie')!.split(';')[0];
  const me = await (await fetch(`${verifier}/api/me?flow=electricity`, { headers: { cookie } })).json();
  assert.equal(me.claims.family_name, 'Muller'); assert.match(me.issuer, /IN Groupe Mock IACA/);
  assert.match(me.claims.portrait, /^data:image\/jpeg;base64,/);
  assert.equal((await fetch(`${verifier}/api/me?flow=university`, { headers: { cookie } })).status, 401);
  // the same response cannot be replayed
  await assert.rejects(submitResponse(req, matches));
  // logout invalidates the session
  await post(`${verifier}/api/logout`, {}, { cookie });
  assert.equal((await fetch(`${verifier}/api/me`, { headers: { cookie } })).status, 401);
});

test('remote verifier: university login with the degree attestation (SD-JWT VC, selective disclosure)', async () => {
  const { s, req, matches } = await remoteLogin('university', wallet);
  assert.ok(matches[0].available);
  await submitResponse(req, matches);
  const poll = await fetch(`${verifier}/api/sessions/${s.id}?token=${s.poll_token}`);
  assert.equal((await poll.json()).status, 'verified');
  const cookie = poll.headers.get('set-cookie')!.split(';')[0];
  const me = await (await fetch(`${verifier}/api/me`, { headers: { cookie } })).json();
  assert.equal(me.claims.degree, 'B.Tech'); assert.equal(me.claims.cgpa, undefined, 'undisclosed claims stay hidden');
  assert.equal(me.claims.university, 'Bharat Institute of Technology');
});

test('remote verifier: wrong credential type and cross-flow replay are rejected', async () => {
  // present the ID credential to the university flow's request → no match
  const { matches } = await remoteLogin('university', wallet.filter((c) => c.format === 'mso_mdoc'));
  assert.equal(matches[0].available, false);
  // replay an electricity presentation against a different transaction (different nonce)
  const a = await remoteLogin('electricity', wallet); const b = await remoteLogin('electricity', wallet);
  const idCred = a.matches[0].credential;
  const claimsList = a.matches[0].item.claims;
  const requested: Record<string, string[]> = { [NS_ID]: claimsList.map((c) => c.name) };
  const resp = buildDeviceResponse({
    documents: [{ issuerSigned: b64u.decode(idCred.raw), deviceKeyPriv: Uint8Array.from(idCred.devicePrivateKeyHex.match(/../g)!.map((h) => parseInt(h, 16))), requested }],
    sessionTranscript: openid4vpTranscript({ clientId: a.req.clientId, nonce: a.req.nonce, responseUri: a.req.responseUri }),
  });
  const r = await fetch(b.req.responseUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `vp_token=${b64u.encode(resp)}&state=${b.req.state}` });
  assert.equal(r.status, 400);
  assert.equal((await (await fetch(`${verifier}/api/sessions/${b.s.id}?token=${b.s.poll_token}`)).json()).status, 'rejected');
});

test('proximity: holder QR → encrypted request/response over relay → reader verifies on-device', async () => {
  const anchors = (await (await fetch(`${verifier}/api/trust`)).json()).anchors.filter((a: any) => a.id === 'iaca').map((a: any) => parseCert(a.pem));
  const cred = wallet.find((c) => c.format === 'mso_mdoc')!;
  const holder = await HolderProximity.start(verifier);
  const readerP = ReaderProximity.request(holder.qr, { [DOCTYPE_ID]: { [NS_ID]: ['age_over_18', 'family_name'] } }, { trustAnchors: anchors, timeoutMs: 15_000 });
  const asked = await holder.waitForRequest(15_000);
  assert.deepEqual(asked[DOCTYPE_ID][NS_ID], ['age_over_18', 'family_name']);
  await holder.respond([{ credential: cred, requested: asked[DOCTYPE_ID] }]);
  const res = await readerP;
  assert.ok(res.ok, JSON.stringify(res));
  if (res.ok) { assert.deepEqual(res.documents[0].claims[NS_ID], { age_over_18: true, family_name: 'Muller' }); }
  // an untrusted anchor makes the same exchange fail
  const holder2 = await HolderProximity.start(verifier);
  const r2 = ReaderProximity.request(holder2.qr, { [DOCTYPE_ID]: { [NS_ID]: ['age_over_18'] } }, { trustAnchors: [csca.cert], timeoutMs: 15_000 });
  const asked2 = await holder2.waitForRequest(15_000);
  await holder2.respond([{ credential: cred, requested: asked2[DOCTYPE_ID] }]);
  assert.equal((await r2).ok, false);
});

test('admin portal: branding is public, edits require login, validation and logo storage work', async () => {
  const def = await (await fetch(`${admin}/api/branding/verifier-electricity`)).json();
  assert.equal(def.names.en, 'VoltEdge Electricity');
  const put = (body: any, cookie?: string) => fetch(`${admin}/api/branding/verifier-electricity`, { method: 'PUT', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  assert.equal((await put({ names: { en: 'Hacked' } })).status, 401);
  assert.equal((await post(`${admin}/api/admin/login`, { username: 'root', password: 'nope' })).status, 401);
  const login = await post(`${admin}/api/admin/login`, { username: 'root', password: 's3cret' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await put({ colors: { ...def.colors, primary: 'red' } }, cookie)).status, 400);
  const png = 'data:image/png;base64,' + Buffer.from('\x89PNG\r\n\x1a\nfake').toString('base64');
  const ok = await put({ names: { en: 'Lumière Power', fr: 'Lumière Énergie' }, colors: { ...def.colors, primary: '#112233' }, theme: 'dark', logo: png }, cookie);
  assert.equal(ok.status, 200);
  const after = await (await fetch(`${admin}/api/branding/verifier-electricity`)).json();
  assert.equal(after.names.fr, 'Lumière Énergie'); assert.equal(after.theme, 'dark'); assert.match(after.logoUrl, /\/assets\/logo\/verifier-electricity/);
  const logo = await fetch(after.logoUrl);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.equal((await put({ logo: 'data:text/html;base64,PGI+' }, cookie)).status, 400);
  // the verifier picks up the renamed brand for the wallet's consent screen
  const { req } = await remoteLogin('electricity', []);
  assert.equal(req.verifierName, 'Lumière Power');
  assert.match(await (await fetch(`${admin}/api/branding/verifier-electricity/theme.css`)).text(), /#112233/);
  // reset (bodiless DELETE) needs the admin session + JSON header, and restores defaults incl. removing the logo
  assert.equal((await fetch(`${admin}/api/branding/verifier-electricity`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })).status, 401);
  assert.equal((await fetch(`${admin}/api/branding/verifier-electricity`, { method: 'DELETE', headers: { 'content-type': 'text/plain', cookie } })).status, 415);
  assert.equal((await fetch(`${admin}/api/branding/verifier-electricity`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie } })).status, 200);
  const reset = await (await fetch(`${admin}/api/branding/verifier-electricity`)).json();
  assert.equal(reset.names.en, 'VoltEdge Electricity'); assert.equal(reset.logoUrl, undefined);
  // tenants with a built-in logo get the Blue Tiger default until an admin uploads one
  const wb = await (await fetch(`${admin}/api/branding/wallet`)).json();
  assert.match(wb.logoUrl, /assets\/default\/bluetiger.png/);
  assert.equal((await fetch(wb.logoUrl)).headers.get('content-type'), 'image/png');
});
