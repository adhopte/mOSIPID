import { createHash } from 'node:crypto';
import { Router } from 'express';
import { b64u, fromBase64, verifyJwtWithJwk, parseJwt, randomId, randomBytes, CONFIG_ID_MDOC, CONFIG_UNI_SDJWT, DOCTYPE_ID, VCT_DEGREE, Jwk, DEFAULT_BRANDING } from '@mosipid/core';
import { wrap, HttpError, rateLimit, Store } from '@mosipid/server-kit';
import { IssuerConfig } from './config';
import { Pki } from './trust';
import { getStudent, findStudent } from './students';
import { buildIdMdoc, buildDegreeSdJwt, VerifiedIdentity } from './credentials';
import { issuerMetadata, authServerMetadata, SCOPES } from './metadata';

type Subject = { kind: 'enroll'; sid: string } | { kind: 'student'; studentId: string };
interface PreAuth { configIds: string[]; subject?: Subject; txCode?: string; attempts: number }
interface Access { configIds: string[]; subject: Subject }

const ACCESS_TTL = 600;
const NONCE_TTL = 300;
const OFFER_TTL = 900;

export function offerUri(cfg: IssuerConfig, id: string) {
  return `openid-credential-offer://?credential_offer_uri=${encodeURIComponent(`${cfg.publicUrl}/offers/${id}`)}`;
}

export async function createOffer(store: Store, cfg: IssuerConfig, o: { configIds: string[]; preAuth?: { subject: Subject; txCode?: string }; authCode?: boolean; proofing?: { session_id: string; method: string } }) {
  const id = randomId(18);
  const offer: any = { credential_issuer: cfg.publicUrl, credential_configuration_ids: o.configIds, grants: {} };
  if (o.preAuth) {
    const code = randomId(24);
    await store.set('preauth', code, { configIds: o.configIds, subject: o.preAuth.subject, txCode: o.preAuth.txCode, attempts: 0 } satisfies PreAuth, OFFER_TTL);
    offer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code'] = { 'pre-authorized_code': code, ...(o.preAuth.txCode ? { tx_code: { input_mode: 'numeric', length: o.preAuth.txCode.length, description: 'PIN shown on the university portal' } } : {}) };
  }
  if (o.authCode) offer.grants.authorization_code = { issuer_state: randomId(12) };
  if (o.proofing) offer.x_proofing = { ...o.proofing, api: cfg.publicUrl };
  await store.set('offer', id, offer, OFFER_TTL);
  return { id, uri: offerUri(cfg, id), offer };
}

let uniNameCache: { at: number; name: string } | undefined;
async function universityName(cfg: IssuerConfig): Promise<string> {
  if (uniNameCache && Date.now() - uniNameCache.at < 30_000) return uniNameCache.name;
  let name = DEFAULT_BRANDING['issuer-university'].names.en;
  if (cfg.adminUrl) {
    try {
      const r = await fetch(`${cfg.adminUrl}/api/branding/issuer-university`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) name = (await r.json()).names?.en || name;
    } catch { /* admin portal unreachable – keep default */ }
  }
  uniNameCache = { at: Date.now(), name };
  return name;
}

export function oid4vciRouter(store: Store, cfg: IssuerConfig, pki: Pki): Router {
  const r = Router();

  r.get('/.well-known/openid-credential-issuer', (_req, res) => res.json(issuerMetadata(cfg)));
  r.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(authServerMetadata(cfg)));
  r.get('/offers/:id', wrap(async (req, res) => {
    const offer = await store.get('offer', req.params.id);
    if (!offer) throw new HttpError(404, 'offer_not_found');
    res.json(offer);
  }));

  const newNonce = async () => { const n = randomId(16); await store.set('nonce', n, 1, NONCE_TTL); return n; };
  r.post('/nonce', rateLimit(60, 60_000), wrap(async (_req, res) => { res.setHeader('cache-control', 'no-store'); res.json({ c_nonce: await newNonce() }); }));

  // ---------------------------------------------------------------- token
  r.post('/token', rateLimit(60, 60_000), wrap(async (req, res) => {
    const b = req.body ?? {};
    const err = (status: number, error: string, desc?: string) => new HttpError(status, error, desc);
    res.setHeader('cache-control', 'no-store');
    let configIds: string[]; let subject: Subject;

    if (b.grant_type === 'urn:ietf:params:oauth:grant-type:pre-authorized_code') {
      const code = String(b['pre-authorized_code'] ?? '');
      const pre = await store.get<PreAuth>('preauth', code);
      if (!pre) throw err(400, 'invalid_grant', 'unknown or expired pre-authorized code');
      if (pre.txCode) {
        if (pre.attempts >= 5) { await store.del('preauth', code); throw err(400, 'invalid_grant', 'too many wrong PIN attempts'); }
        if (String(b.tx_code ?? '') !== pre.txCode) {
          await store.set('preauth', code, { ...pre, attempts: pre.attempts + 1 }, OFFER_TTL);
          throw err(400, 'invalid_grant', 'invalid tx_code');
        }
      }
      if (pre.subject?.kind === 'enroll') {
        const s = await store.get<any>('enroll', pre.subject.sid);
        if (!s) throw err(400, 'invalid_grant', 'enrolment session expired');
        if (s.status === 'failed') throw err(400, 'access_denied', 'identity verification failed');
        if (s.status !== 'verified') throw err(400, 'authorization_pending', 'identity verification not completed yet');
      }
      await store.del('preauth', code);
      configIds = pre.configIds; subject = pre.subject!;
    } else if (b.grant_type === 'authorization_code') {
      const rec = await store.take<any>('authcode', String(b.code ?? ''));
      if (!rec) throw err(400, 'invalid_grant', 'unknown, used or expired code');
      const challenge = b64u.encode(createHash('sha256').update(String(b.code_verifier ?? '')).digest());
      if (!b.code_verifier || challenge !== rec.challenge) throw err(400, 'invalid_grant', 'PKCE verification failed');
      if (b.redirect_uri !== rec.redirectUri || (b.client_id && b.client_id !== rec.clientId)) throw err(400, 'invalid_grant', 'redirect_uri / client_id mismatch');
      configIds = rec.configIds; subject = { kind: 'student', studentId: rec.studentId };
    } else throw err(400, 'unsupported_grant_type');

    const token = randomId(32);
    await store.set('access', token, { configIds, subject } satisfies Access, ACCESS_TTL);
    res.json({ access_token: token, token_type: 'Bearer', expires_in: ACCESS_TTL, c_nonce: await newNonce(), c_nonce_expires_in: NONCE_TTL });
  }));

  // ---------------------------------------------------------------- credential
  r.post('/credential', rateLimit(60, 60_000), wrap(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const access = bearer ? await store.get<Access>('access', bearer) : undefined;
    if (!access) { res.setHeader('www-authenticate', 'Bearer error="invalid_token"'); throw new HttpError(401, 'invalid_token'); }
    const b = req.body ?? {};

    let configId: string | undefined = b.credential_configuration_id;
    if (!configId && b.format === 'mso_mdoc' && b.doctype === DOCTYPE_ID) configId = CONFIG_ID_MDOC;
    if (!configId && b.format && b.format.endsWith('sd-jwt') && (!b.vct || b.vct === VCT_DEGREE)) configId = CONFIG_UNI_SDJWT;
    if (!configId || !access.configIds.includes(configId)) throw new HttpError(400, 'unsupported_credential_type', 'credential not authorised by this token');

    const proofJwt: string | undefined = b.proofs?.jwt?.[0] ?? (b.proof?.proof_type === 'jwt' ? b.proof.jwt : undefined);
    if (!proofJwt) throw new HttpError(400, 'invalid_proof', 'a jwt proof of possession is required', { c_nonce: await newNonce(), c_nonce_expires_in: NONCE_TTL });
    let holder: Jwk;
    try {
      const parsed = parseJwt(proofJwt);
      holder = parsed.header.jwk;
      if (!holder || holder.kty !== 'EC' || holder.crv !== 'P-256') throw new Error('proof header must carry a P-256 jwk');
      if (parsed.header.typ !== 'openid4vci-proof+jwt') throw new Error('bad proof typ');
      verifyJwtWithJwk(proofJwt, holder);
      const p = parsed.payload;
      if (p.aud !== cfg.publicUrl) throw new Error('proof aud mismatch');
      if (Math.abs(Date.now() / 1000 - (p.iat ?? 0)) > 300) throw new Error('proof iat out of range');
      if (!p.nonce || !(await store.take('nonce', p.nonce))) {
        throw new HttpError(400, 'invalid_nonce', 'missing or reused nonce', { c_nonce: await newNonce(), c_nonce_expires_in: NONCE_TTL });
      }
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'invalid_proof', e.message, { c_nonce: await newNonce(), c_nonce_expires_in: NONCE_TTL });
    }

    let credential: string;
    if (configId === CONFIG_ID_MDOC) {
      if (access.subject.kind !== 'enroll') throw new HttpError(400, 'invalid_credential_request');
      const s = await store.get<any>('enroll', access.subject.sid);
      if (!s || s.status !== 'verified' || !s.identity) throw new HttpError(400, 'invalid_credential_request', 'identity not verified');
      credential = b64u.encode(buildIdMdoc(s.identity as VerifiedIdentity, holder, pki, cfg));
      await store.set('enroll', access.subject.sid, { ...s, status: 'issued', identity: undefined }, 600); // data minimisation
    } else {
      if (access.subject.kind !== 'student') throw new HttpError(400, 'invalid_credential_request');
      const st = getStudent(access.subject.studentId);
      if (!st) throw new HttpError(400, 'invalid_credential_request', 'student not found');
      credential = buildDegreeSdJwt(st, await universityName(cfg), holder, pki, cfg);
    }
    // an access token authorises the listed configurations once
    await store.del('access', bearer!);
    res.json({ credentials: [{ credential }], credential, c_nonce: await newNonce(), c_nonce_expires_in: NONCE_TTL });
  }));

  // ---------------------------------------------------------------- authorization endpoint (university login)
  const redirectAllowed = (uri: string) => cfg.allowedRedirects.some((p) => uri.startsWith(p));
  r.get('/authorize', wrap(async (req, res) => {
    const q = req.query as Record<string, string>;
    const fail = (error: string, desc: string) => { throw new HttpError(400, error, desc); };
    if (q.response_type !== 'code') fail('unsupported_response_type', 'response_type must be code');
    if (!q.client_id) fail('invalid_request', 'client_id required');
    if (!q.redirect_uri || !redirectAllowed(q.redirect_uri)) fail('invalid_request', 'redirect_uri not allowed');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') fail('invalid_request', 'PKCE S256 required');
    let configIds: string[] = [];
    const scopes = (q.scope ?? '').split(' ').filter(Boolean);
    for (const [id, sc] of Object.entries(SCOPES)) if (scopes.includes(sc)) configIds.push(id);
    if (q.authorization_details) {
      try { for (const d of JSON.parse(q.authorization_details)) if (d.credential_configuration_id) configIds.push(d.credential_configuration_id); } catch { fail('invalid_request', 'bad authorization_details'); }
    }
    configIds = [...new Set(configIds)];
    // this authorization server logs in *students*; the identity credential goes through the proofing flow instead
    if (!configIds.length || configIds.some((c) => c !== CONFIG_UNI_SDJWT)) fail('invalid_scope', `supported scope: ${SCOPES[CONFIG_UNI_SDJWT]}`);
    const id = randomId(18);
    await store.set('authreq', id, { clientId: q.client_id, redirectUri: q.redirect_uri, challenge: q.code_challenge, state: q.state, configIds, attempts: 0 }, 900);
    res.redirect(302, `/authorize.html?req=${id}${q.ui_locales ? `&lang=${encodeURIComponent(q.ui_locales.slice(0, 2))}` : ''}`);
  }));

  r.post('/authorize/login', rateLimit(20, 60_000), wrap(async (req, res) => {
    const { req: id, studentId, dob } = req.body ?? {};
    const rec = await store.get<any>('authreq', String(id));
    if (!rec) throw new HttpError(400, 'invalid_request', 'authorization request expired');
    if (rec.attempts >= 5) { await store.del('authreq', String(id)); throw new HttpError(429, 'too_many_attempts'); }
    const st = typeof studentId === 'string' && typeof dob === 'string' ? findStudent(studentId, dob) : undefined;
    if (!st) { await store.set('authreq', String(id), { ...rec, attempts: rec.attempts + 1 }, 900); throw new HttpError(401, 'invalid_credentials', 'University ID or date of birth not recognised'); }
    await store.del('authreq', String(id));
    const code = randomId(24);
    await store.set('authcode', code, { studentId: st.studentId, clientId: rec.clientId, redirectUri: rec.redirectUri, challenge: rec.challenge, configIds: rec.configIds }, 120);
    const sep = rec.redirectUri.includes('?') ? '&' : '?';
    res.json({ redirect: `${rec.redirectUri}${sep}code=${encodeURIComponent(code)}${rec.state ? `&state=${encodeURIComponent(rec.state)}` : ''}`, student: { name: `${st.givenName} ${st.familyName}` } });
  }));

  // ---------------------------------------------------------------- university portal helpers
  r.post('/api/university/preauth', rateLimit(20, 60_000), wrap(async (req, res) => {
    const { studentId, dob } = req.body ?? {};
    const st = typeof studentId === 'string' && typeof dob === 'string' ? findStudent(studentId, dob) : undefined;
    if (!st) throw new HttpError(401, 'invalid_credentials', 'University ID or date of birth not recognised');
    const txCode = String(randomBytes(2).reduce((a, b) => a * 256 + b, 0) % 10000).padStart(4, '0');
    const o = await createOffer(store, cfg, { configIds: [CONFIG_UNI_SDJWT], preAuth: { subject: { kind: 'student', studentId: st.studentId }, txCode } });
    res.json({ offer_uri: o.uri, tx_code: txCode, student: { name: `${st.givenName} ${st.familyName}`, degree: `${st.degree} ${st.field}`, year: st.graduationYear } });
  }));
  r.post('/api/university/offer', wrap(async (_req, res) => {
    const o = await createOffer(store, cfg, { configIds: [CONFIG_UNI_SDJWT], authCode: true });
    res.json({ offer_uri: o.uri });
  }));
  void fromBase64;
  return r;
}
