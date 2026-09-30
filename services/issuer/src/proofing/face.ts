// Face match + liveness re-check. Providers:
//   opencv (default when the models are present): OpenCV Model Zoo YuNet + SFace, cosine ≥ 0.363, and a server-side
//                 re-check of the head-turn frames (same person, opposite yaw) – the same approach as eMRTD-Tester.
//   http          delegate to your own service (contract below).
//   mock          DEMO ONLY: accepts any image; credentials are marked assurance_level=demo.
//
// http contract:  POST FACE_API_URL {source_b64, source_mime, selfie_b64, turn_left_b64?, turn_right_b64?}
//                 -> {score: 0..1, liveness?: 0..1}
import { IssuerConfig } from '../config';
import { faceEngine, modelsAvailable, cosine, MATCH_THRESHOLD, SESSION_THRESHOLD, poseChanged } from './face-engine';

export interface FaceInput {
  source: Uint8Array; sourceMime: string; sourceKind: 'document' | 'chip';
  selfie: Uint8Array; turnLeft?: Uint8Array; turnRight?: Uint8Array;
}
export interface FaceResult {
  match: boolean; score: number; demo: boolean; provider: 'opencv' | 'http' | 'mock';
  /** undefined = not checked (no frames supplied) */
  liveness?: { ok: boolean; reason?: string };
  failure?: string;            // machine-readable reason code when match=false
  portrait?: Uint8Array;       // face cropped from the source image (opencv provider)
}

export function effectiveProvider(cfg: IssuerConfig): 'opencv' | 'http' | 'mock' {
  if (cfg.faceProvider === 'http') return 'http';
  if (cfg.faceProvider === 'opencv' || (cfg.faceProvider === 'auto' && modelsAvailable())) return modelsAvailable() ? 'opencv' : 'mock';
  return 'mock';
}

export async function compareFaces(cfg: IssuerConfig, input: FaceInput): Promise<FaceResult> {
  const provider = effectiveProvider(cfg);

  if (provider === 'http') {
    if (!cfg.faceApiUrl) throw new Error('FACE_API_URL not configured');
    const b64 = (b?: Uint8Array) => (b ? Buffer.from(b).toString('base64') : undefined);
    const r = await fetch(cfg.faceApiUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(cfg.faceApiKey ? { authorization: `Bearer ${cfg.faceApiKey}` } : {}) },
      body: JSON.stringify({ source_b64: b64(input.source), source_mime: input.sourceMime, selfie_b64: b64(input.selfie), turn_left_b64: b64(input.turnLeft), turn_right_b64: b64(input.turnRight) }),
    });
    if (!r.ok) throw new Error('face provider error ' + r.status);
    const j: any = await r.json();
    const score = Number(j.score), lv = j.liveness === undefined ? undefined : Number(j.liveness);
    const ok = score >= cfg.faceThreshold && (lv === undefined || lv >= 0.5);
    return { match: ok, score, demo: false, provider, liveness: lv === undefined ? undefined : { ok: lv >= 0.5 }, failure: ok ? undefined : score < cfg.faceThreshold ? 'face_mismatch' : 'liveness_failed' };
  }

  if (provider === 'mock') {
    const looksLikeImage = input.selfie.length >= 64 && input.source.length >= 64;
    return { match: looksLikeImage, score: looksLikeImage ? 0.99 : 0, demo: true, provider, failure: looksLikeImage ? undefined : 'face_mismatch' };
  }

  // ---- opencv (YuNet + SFace)
  const eng = await faceEngine();
  const src = await eng.analyse(input.source, input.sourceKind);
  if (!src.ok) return { match: false, score: 0, demo: false, provider, failure: src.reason };
  const sel = await eng.analyse(input.selfie, 'selfie');
  if (!sel.ok) return { match: false, score: 0, demo: false, provider, failure: sel.reason };
  const score = cosine(src.embedding, sel.embedding);
  const portrait = (await eng.cropPortrait(input.source, src.box, src.width, src.height)) ?? undefined;
  const base = { score, demo: false, provider, portrait } as const;
  if (score < MATCH_THRESHOLD) return { ...base, match: false, failure: 'face_mismatch' };

  if (!input.turnLeft || !input.turnRight) {
    return { ...base, match: !cfg.faceRequireLiveness, liveness: undefined, failure: cfg.faceRequireLiveness ? 'liveness_missing' : undefined };
  }
  const l = await eng.analyse(input.turnLeft, 'turn_left');
  const r = await eng.analyse(input.turnRight, 'turn_right');
  if (!l.ok) return { ...base, match: false, liveness: { ok: false, reason: l.reason }, failure: 'liveness_failed' };
  if (!r.ok) return { ...base, match: false, liveness: { ok: false, reason: r.reason }, failure: 'liveness_failed' };
  // every pose must show the same person as the selfie, and the head must really turn in opposite directions
  if (cosine(sel.embedding, l.embedding) < SESSION_THRESHOLD || cosine(sel.embedding, r.embedding) < SESSION_THRESHOLD) {
    return { ...base, match: false, liveness: { ok: false, reason: 'different_person' }, failure: 'liveness_failed' };
  }
  if (!poseChanged(sel.yaw, l.yaw, r.yaw)) return { ...base, match: false, liveness: { ok: false, reason: 'no_head_turn' }, failure: 'liveness_failed' };
  return { ...base, match: true, liveness: { ok: true } };
}
