import { X509Certificate } from 'node:crypto';
import { Router } from 'express';
import { parseMrz, dg1ToMrzLines, extractFaceImage, extractMrz, randomId, randomBytes, CONFIG_ID_MDOC, MrzData, fromBase64 } from '@mosipid/core';
import { wrap, HttpError, rateLimit, Store } from '@mosipid/server-kit';
import { IssuerConfig } from '../config';
import { createOffer } from '../oid4vci';
import { VerifiedIdentity } from '../credentials';
import { compareFaces, FaceResult, effectiveProvider } from './face';
import { decodeB64Image, toPortraitJpeg } from './images';
import { readMrzFromImage } from './ocr';
import { verifySod } from './sod';
import { jp2ToJpeg } from './jp2';

const SESSION_TTL = 1800;
const MAX_ATTEMPTS = 5;

interface Enroll { sid: string; method: 'nfc' | 'ocr' | 'manual'; status: 'created' | 'verified' | 'failed' | 'issued'; attempts: number; reason?: string; identity?: VerifiedIdentity; createdAt: string }

const title = (s: string) => s.toLowerCase().replace(/(^|[\s'-])(\S)/g, (_m, a, b) => a + b.toUpperCase());
const NAME_RE = /^[\p{L}][\p{L} '.-]{0,78}$/u;

export function proofingRouter(store: Store, cfg: IssuerConfig): Router {
  const r = Router();
  const csca = cfg.cscaPems.map((p) => new X509Certificate(p));

  r.get('/api/proofing/capabilities', (_req, res) => res.json({
    face_provider: effectiveProvider(cfg), face_demo: effectiveProvider(cfg) === 'mock', liveness_required: cfg.faceRequireLiveness && effectiveProvider(cfg) === 'opencv',
    passive_auth: csca.length ? 'chain' : 'signature_only', manual_pid: cfg.allowManualPid, ocr: cfg.ocrProvider,
  }));

  r.post('/api/enroll', rateLimit(30, 60_000), wrap(async (req, res) => {
    const method = req.body?.method === 'nfc' ? 'nfc' : 'ocr';
    const sid = randomId(18);
    const rec: Enroll = { sid, method, status: 'created', attempts: 0, createdAt: new Date().toISOString() };
    await store.set('enroll', sid, rec, SESSION_TTL);
    const o = await createOffer(store, cfg, { configIds: [CONFIG_ID_MDOC], preAuth: { subject: { kind: 'enroll', sid } }, proofing: { session_id: sid, method } });
    res.json({ sid, method, offer_uri: o.uri });
  }));

  /** Pre-authorised PID from details typed on the issuer site: no proofing, so the credential is marked self-asserted. */
  r.post('/api/pid/manual', rateLimit(20, 60_000), wrap(async (req, res) => {
    if (!cfg.allowManualPid) throw new HttpError(403, 'manual_pid_disabled');
    const b = req.body ?? {};
    const family = String(b.family_name ?? '').trim(), given = String(b.given_names ?? '').trim();
    if (!NAME_RE.test(family) || !NAME_RE.test(given)) throw new HttpError(400, 'invalid_name', 'family and given names are required');
    const birth = String(b.birth_date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birth) || Number.isNaN(Date.parse(birth)) || birth > new Date().toISOString().slice(0, 10) || birth < '1900-01-01') throw new HttpError(400, 'invalid_birth_date');
    const sex = ['M', 'F', 'X'].includes(b.sex) ? b.sex : 'X';
    const nat = String(b.nationality ?? 'IND').toUpperCase();
    if (!/^[A-Z]{3}$/.test(nat)) throw new HttpError(400, 'invalid_nationality', 'use the 3-letter ICAO code, e.g. IND, FRA, ESP');
    const docNo = String(b.document_number ?? '').trim().toUpperCase();
    if (docNo && !/^[A-Z0-9]{5,20}$/.test(docNo)) throw new HttpError(400, 'invalid_document_number');
    let portrait: string | undefined;
    if (b.portrait) {
      try { const p = await toPortraitJpeg(decodeB64Image(b.portrait, 4 * 1024 * 1024)); if (p) portrait = Buffer.from(p).toString('base64'); } catch { throw new HttpError(400, 'invalid_image', 'portrait could not be read'); }
    }
    const sid = randomId(18);
    const identity: VerifiedIdentity = {
      familyName: title(family), givenNames: title(given), birthDate: birth, sex, nationality: nat, method: 'manual', source: 'manual',
      portrait, demoAssurance: false, sourceDocumentNumber: docNo || undefined,
    };
    await store.set('enroll', sid, { sid, method: 'manual', status: 'verified', attempts: 0, createdAt: new Date().toISOString(), identity } satisfies Enroll, SESSION_TTL);
    const pin = String(randomBytes(3).reduce((a, x) => a * 256 + x, 0) % 10000).padStart(4, '0');
    const o = await createOffer(store, cfg, { configIds: [CONFIG_ID_MDOC], preAuth: { subject: { kind: 'enroll', sid }, txCode: pin } });
    res.json({ sid, offer_uri: o.uri, tx_code: pin, assurance_level: 'self_asserted' });
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
  const optImage = (v: unknown) => (v ? decodeB64Image(v, 4 * 1024 * 1024) : undefined);
  /** selfie + the two head-turn frames. `liveness_frames` = [straight, left, right] is the older expo-camera format. */
  const selfieSet = (body: any) => {
    const f = Array.isArray(body?.liveness_frames) ? body.liveness_frames : [];
    return { selfie: optImage(body?.selfie ?? f[0]), turnLeft: optImage(body?.turn_left ?? f[1]), turnRight: optImage(body?.turn_right ?? f[2]) };
  };
  const checkMrz = (m: MrzData | null) => {
    if (!m) return 'mrz_not_found';
    if (!m.checksOk) return 'mrz_checksum_failed';
    if (m.expiryDate < new Date().toISOString().slice(0, 10)) return 'document_expired';
    return null;
  };
  const faceFailure = (f: FaceResult) => f.failure ?? 'face_mismatch';

  // lightweight OCR probe used by the fallback auto-capture loop (no state change)
  r.post('/api/proofing/:sid/probe', rateLimit(60, 60_000), wrap(async (req, res) => {
    await load(req.params.sid);
    let img: Uint8Array;
    try { img = decodeB64Image(req.body?.image); } catch (e) { throw bad(e); }
    const m = await readMrzFromImage(cfg, img, req.body?.debug_mrz);
    res.json({ found: !!m, valid: !!m?.checksOk, format: m?.format, ...(m?.checksOk ? { mrz: { documentNumber: m.documentNumber, birthDate: m.birthDate, expiryDate: m.expiryDate } } : {}) });
  }));

  r.post('/api/proofing/:sid/ocr', rateLimit(20, 60_000), wrap(async (req, res) => {
    const s = await load(req.params.sid);
    const body = req.body ?? {};
    let docs: Uint8Array[];
    try {
      const list: unknown[] = Array.isArray(body.images) ? body.images.slice(0, 3) : body.image ? [body.image] : [];
      docs = list.map((x) => decodeB64Image(x, 12 * 1024 * 1024));
      if (!docs.length) throw new Error('missing_image');
    } catch (e) { throw bad(e); }
    let frames;
    try { frames = selfieSet(body); if ((cfg.requireSelfie || body.selfie) && !frames.selfie) throw new Error('missing_image'); } catch (e) { throw bad(e); }
    const source: 'camera' | 'upload' = body.capture_source === 'upload' ? 'upload' : 'camera';

    // 1) MRZ: the phone's ML Kit text (fast, on-device) and/or server Tesseract
    const clientMrz = typeof body.ocr_text === 'string' && body.ocr_text.length < 20000 ? extractMrz(body.ocr_text) : null;
    let mrz: MrzData | null = clientMrz?.checksOk ? clientMrz : null;
    let ocrSource = mrz ? 'device_mlkit' : 'server_tesseract';
    if (!mrz || cfg.ocrVerifyClient) {
      let server: MrzData | null = null;
      for (const d of docs) { server = await readMrzFromImage(cfg, d, body.debug_mrz); if (server?.checksOk) break; }
      if (mrz && server?.checksOk && (server.documentNumber !== mrz.documentNumber || server.birthDate !== mrz.birthDate)) return reject(s, 'mrz_mismatch');
      if (!mrz) mrz = server;
      else if (server?.checksOk) ocrSource = 'device_mlkit+server';
    }
    const problem = checkMrz(mrz);
    if (problem) return reject(s, problem);

    // 2) face match against the portrait on the document + head-turn liveness
    let demo = false, portraitBytes: Uint8Array | null = null;
    if (frames.selfie) {
      let face: FaceResult | undefined;
      for (const d of docs) {
        face = await compareFaces(cfg, { source: d, sourceMime: 'image/jpeg', sourceKind: 'document', selfie: frames.selfie, turnLeft: frames.turnLeft, turnRight: frames.turnRight });
        if (face.failure !== 'document_no_face' && face.failure !== 'document_image_invalid') break;
      }
      demo = face!.demo;
      if (!face!.match) return reject(s, faceFailure(face!), { score: Number(face!.score.toFixed(2)) });
      portraitBytes = face!.portrait ?? null;
    }
    portraitBytes ??= frames.selfie ? await toPortraitJpeg(frames.selfie) : null;
    if (frames.selfie && !portraitBytes) return reject(s, 'selfie_unusable');
    const identity: VerifiedIdentity = {
      familyName: title(mrz!.surname), givenNames: title(mrz!.givenNames), birthDate: mrz!.birthDate, sex: mrz!.sex, nationality: mrz!.nationality,
      method: 'ocr', source, ocrSource, portrait: portraitBytes ? Buffer.from(portraitBytes).toString('base64') : undefined, demoAssurance: demo,
      sourceDocumentNumber: mrz!.documentNumber,
    };
    await store.set('enroll', s.sid, { ...s, status: 'verified', identity, attempts: s.attempts + 1, reason: undefined }, SESSION_TTL);
    res.json({ status: 'verified' });
  }));

  r.post('/api/proofing/:sid/nfc', rateLimit(20, 60_000), wrap(async (req, res) => {
    const s = await load(req.params.sid);
    let dg1: Uint8Array, dg2: Uint8Array, sod: Uint8Array, frames;
    try {
      dg1 = fromBase64(String(req.body?.dg1 ?? '')); dg2 = fromBase64(String(req.body?.dg2 ?? '')); sod = fromBase64(String(req.body?.sod ?? ''));
      if (!dg1.length || !dg2.length || !sod.length) throw new Error('dg1, dg2 and sod are required');
      if (dg2.length > 4 * 1024 * 1024) throw new Error('dg2 too large');
      frames = selfieSet(req.body);
      if ((cfg.requireSelfie || req.body?.selfie) && !frames.selfie) throw new Error('missing_image');
    } catch (e) { throw bad(e); }

    let mrz: MrzData;
    try { mrz = parseMrz(dg1ToMrzLines(dg1)); } catch { return reject(s, 'dg1_unreadable'); }
    const problem = checkMrz(mrz);
    if (problem) return reject(s, problem);

    const sodRes = verifySod(sod, { 1: dg1, 2: dg2 }, { csca, strict: cfg.passiveAuth === 'strict' });
    if (!sodRes.ok) return reject(s, sodRes.errors[0]?.split(':')[0] ?? 'passive_auth_failed', { errors: sodRes.errors });
    const passiveAuth: 'verified' | 'demo' = sodRes.chainOk === true ? 'verified' : 'demo';

    let chipFace = extractFaceImage(dg2);
    if (chipFace?.mime === 'image/jp2') {                       // most passports store JPEG 2000: convert once, use everywhere
      const jpg = await jp2ToJpeg(chipFace.data);
      chipFace = jpg ? { data: jpg, mime: 'image/jpeg' } : chipFace;
    }
    let demo = passiveAuth === 'demo';
    let portrait: Uint8Array | null = null;
    if (frames.selfie) {
      if (!chipFace) return reject(s, 'dg2_no_face_image');
      if (chipFace.mime === 'image/jp2') return reject(s, 'dg2_unsupported_image');
      const f = await compareFaces(cfg, { source: chipFace.data, sourceMime: chipFace.mime, sourceKind: 'chip', selfie: frames.selfie, turnLeft: frames.turnLeft, turnRight: frames.turnRight });
      demo ||= f.demo;
      if (!f.match) return reject(s, faceFailure(f), { score: Number(f.score.toFixed(2)) });
      portrait = f.portrait ?? null;
    }
    if (!portrait && chipFace?.mime === 'image/jpeg') portrait = await toPortraitJpeg(chipFace.data);
    portrait ??= frames.selfie ? await toPortraitJpeg(frames.selfie) : null;
    const identity: VerifiedIdentity = {
      familyName: title(mrz.surname), givenNames: title(mrz.givenNames), birthDate: mrz.birthDate, sex: mrz.sex, nationality: mrz.nationality,
      method: 'nfc', source: 'chip', portrait: portrait ? Buffer.from(portrait).toString('base64') : undefined, demoAssurance: demo, passiveAuth,
      sourceDocumentNumber: mrz.documentNumber,
    };
    await store.set('enroll', s.sid, { ...s, status: 'verified', identity, attempts: s.attempts + 1, reason: undefined }, SESSION_TTL);
    res.json({ status: 'verified', passive_authentication: passiveAuth });
  }));

  return r;
}
