import { X509Certificate } from 'node:crypto';
import { Router } from 'express';
import { parseMrz, dg1ToMrzLines, extractFaceImage, randomId, CONFIG_ID_MDOC, MrzData, fromBase64 } from '@mosipid/core';
import { wrap, HttpError, rateLimit, Store } from '@mosipid/server-kit';
import { IssuerConfig } from '../config';
import { createOffer } from '../oid4vci';
import { VerifiedIdentity } from '../credentials';
import { compareFaces } from './face';
import { decodeB64Image, toPortraitJpeg } from './images';
import { readMrzFromImage } from './ocr';
import { verifySod } from './sod';

const SESSION_TTL = 1800;
const MAX_ATTEMPTS = 5;

interface Enroll { sid: string; method: 'nfc' | 'ocr'; status: 'created' | 'verified' | 'failed' | 'issued'; attempts: number; reason?: string; identity?: VerifiedIdentity; createdAt: string }

const title = (s: string) => s.toLowerCase().replace(/(^|[\s'-])(\S)/g, (_m, a, b) => a + b.toUpperCase());

export function proofingRouter(store: Store, cfg: IssuerConfig): Router {
  const r = Router();
  const csca = cfg.cscaPems.map((p) => new X509Certificate(p));

  r.post('/api/enroll', rateLimit(30, 60_000), wrap(async (req, res) => {
    const method = req.body?.method === 'nfc' ? 'nfc' : 'ocr';
    const sid = randomId(18);
    const rec: Enroll = { sid, method, status: 'created', attempts: 0, createdAt: new Date().toISOString() };
    await store.set('enroll', sid, rec, SESSION_TTL);
    const o = await createOffer(store, cfg, { configIds: [CONFIG_ID_MDOC], preAuth: { subject: { kind: 'enroll', sid } }, proofing: { session_id: sid, method } });
    res.json({ sid, method, offer_uri: o.uri });
  }));

  r.get('/api/enroll/:sid', wrap(async (req, res) => {
    const s = await store.get<Enroll>('enroll', req.params.sid);
    if (!s) throw new HttpError(404, 'session_not_found');
    res.setHeader('cache-control', 'no-store');
    res.json({ status: s.status, method: s.method, attempts: s.attempts, reason: s.reason });
  }));

  const load = async (sid: string): Promise<Enroll> => {
    const s = await store.get<Enroll>('enroll', sid);
    if (!s) throw new HttpError(404, 'session_not_found', 'enrolment session expired or unknown');
    if (s.status !== 'created') throw new HttpError(409, 'session_closed', `session is ${s.status}`);
    return s;
  };
  const reject = async (s: Enroll, code: string, extra: Record<string, unknown> = {}) => {
    const attempts = s.attempts + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    await store.set('enroll', s.sid, { ...s, attempts, status: failed ? 'failed' : 'created', reason: code }, SESSION_TTL);
    throw new HttpError(422, code, undefined, { attempts_left: Math.max(0, MAX_ATTEMPTS - attempts), ...extra });
  };
  const bad = (e: any) => new HttpError(400, 'invalid_image', e?.message ?? 'invalid image');
  const optFrames = (v: unknown) => (Array.isArray(v) ? v.slice(0, 5).map((x) => decodeB64Image(x, 2 * 1024 * 1024)) : undefined);
  const checkMrz = (m: MrzData | null) => {
    if (!m) return 'mrz_not_found';
    if (!m.checksOk) return 'mrz_checksum_failed';
    if (m.expiryDate < new Date().toISOString().slice(0, 10)) return 'document_expired';
    return null;
  };

  // lightweight OCR probe used by the wallet's auto-capture loop (no state change)
  r.post('/api/proofing/:sid/probe', rateLimit(60, 60_000), wrap(async (req, res) => {
    await load(req.params.sid);
    let img: Uint8Array;
    try { img = decodeB64Image(req.body?.image); } catch (e) { throw bad(e); }
    const m = await readMrzFromImage(cfg, img, req.body?.debug_mrz);
    res.json({ found: !!m, valid: !!m?.checksOk, format: m?.format });
  }));

  r.post('/api/proofing/:sid/ocr', rateLimit(20, 60_000), wrap(async (req, res) => {
    const s = await load(req.params.sid);
    let doc: Uint8Array, selfie: Uint8Array | undefined;
    try {
      doc = decodeB64Image(req.body?.image);
      if (cfg.requireSelfie || req.body?.selfie) selfie = decodeB64Image(req.body?.selfie);
    } catch (e) { throw bad(e); }
    const mrz = await readMrzFromImage(cfg, doc, req.body?.debug_mrz);
    const problem = checkMrz(mrz);
    if (problem) return reject(s, problem);
    let demo = false;
    if (selfie) {
      const face = await compareFaces(cfg, { source: doc, sourceMime: 'image/jpeg', selfie, livenessFrames: optFrames(req.body?.liveness_frames) });
      demo = face.demo;
      if (!face.match) return reject(s, 'face_mismatch', { score: Number(face.score.toFixed(2)) });
    }
    const portrait = selfie ? await toPortraitJpeg(selfie) : null;
    if (selfie && !portrait) return reject(s, 'selfie_unusable');
    const identity: VerifiedIdentity = {
      familyName: title(mrz!.surname), givenNames: title(mrz!.givenNames), birthDate: mrz!.birthDate, sex: mrz!.sex, nationality: mrz!.nationality,
      method: 'ocr', portrait: portrait ? Buffer.from(portrait).toString('base64') : undefined, demoAssurance: demo,
    };
    await store.set('enroll', s.sid, { ...s, status: 'verified', identity, attempts: s.attempts + 1, reason: undefined }, SESSION_TTL);
    res.json({ status: 'verified' });
  }));

  r.post('/api/proofing/:sid/nfc', rateLimit(20, 60_000), wrap(async (req, res) => {
    const s = await load(req.params.sid);
    let dg1: Uint8Array, dg2: Uint8Array, sod: Uint8Array, selfie: Uint8Array | undefined;
    try {
      dg1 = fromBase64(String(req.body?.dg1 ?? '')); dg2 = fromBase64(String(req.body?.dg2 ?? '')); sod = fromBase64(String(req.body?.sod ?? ''));
      if (!dg1.length || !dg2.length || !sod.length) throw new Error('dg1, dg2 and sod are required');
      if (dg2.length > 4 * 1024 * 1024) throw new Error('dg2 too large');
      if (cfg.requireSelfie || req.body?.selfie) selfie = decodeB64Image(req.body?.selfie);
    } catch (e) { throw bad(e); }

    let mrz: MrzData;
    try { mrz = parseMrz(dg1ToMrzLines(dg1)); } catch { return reject(s, 'dg1_unreadable'); }
    const problem = checkMrz(mrz);
    if (problem) return reject(s, problem);

    const sodRes = verifySod(sod, { 1: dg1, 2: dg2 }, { csca, strict: cfg.passiveAuth === 'strict' });
    if (!sodRes.ok) return reject(s, sodRes.errors[0]?.split(':')[0] ?? 'passive_auth_failed', { errors: sodRes.errors });
    const passiveAuth: 'verified' | 'demo' = sodRes.chainOk === true ? 'verified' : 'demo';

    const face = extractFaceImage(dg2);
    let demo = passiveAuth === 'demo';
    let portrait: Uint8Array | null = null;
    if (selfie) {
      if (!face) return reject(s, 'dg2_no_face_image');
      const f = await compareFaces(cfg, { source: face.data, sourceMime: face.mime, selfie, livenessFrames: optFrames(req.body?.liveness_frames) });
      demo ||= f.demo;
      if (!f.match) return reject(s, 'face_mismatch', { score: Number(f.score.toFixed(2)) });
    }
    if (face?.mime === 'image/jpeg') portrait = await toPortraitJpeg(face.data);
    portrait ??= selfie ? await toPortraitJpeg(selfie) : null;
    const identity: VerifiedIdentity = {
      familyName: title(mrz.surname), givenNames: title(mrz.givenNames), birthDate: mrz.birthDate, sex: mrz.sex, nationality: mrz.nationality,
      method: 'nfc', portrait: portrait ? Buffer.from(portrait).toString('base64') : undefined, demoAssurance: demo, passiveAuth,
    };
    await store.set('enroll', s.sid, { ...s, status: 'verified', identity, attempts: s.attempts + 1, reason: undefined }, SESSION_TTL);
    res.json({ status: 'verified', passive_authentication: passiveAuth });
  }));

  return r;
}
