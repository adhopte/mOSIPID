// Face comparison + liveness are delegated to a provider. `mock` is for demos only and is flagged in the
// issued credential (assurance_level = "demo"). `http` calls any service implementing the contract below
// (e.g. a thin wrapper around AWS Rekognition, Azure Face, MOSIP's face SDK or an in-house model):
//   POST FACE_API_URL   {source_b64, source_mime, selfie_b64, liveness_frames_b64?: string[]}
//   -> {score: 0..1, liveness?: 0..1}
import { IssuerConfig } from '../config';

export interface FaceResult { match: boolean; score: number; liveness?: number; demo: boolean }
export interface FaceInput { source: Uint8Array; sourceMime: string; selfie: Uint8Array; livenessFrames?: Uint8Array[] }

export async function compareFaces(cfg: IssuerConfig, input: FaceInput): Promise<FaceResult> {
  if (cfg.faceProvider === 'http') {
    if (!cfg.faceApiUrl) throw new Error('FACE_API_URL not configured');
    const r = await fetch(cfg.faceApiUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(cfg.faceApiKey ? { authorization: `Bearer ${cfg.faceApiKey}` } : {}) },
      body: JSON.stringify({
        source_b64: Buffer.from(input.source).toString('base64'), source_mime: input.sourceMime, selfie_b64: Buffer.from(input.selfie).toString('base64'),
        liveness_frames_b64: input.livenessFrames?.map((f) => Buffer.from(f).toString('base64')),
      }),
    });
    if (!r.ok) throw new Error('face provider error ' + r.status);
    const j: any = await r.json();
    const score = Number(j.score);
    const liveness = j.liveness === undefined ? undefined : Number(j.liveness);
    return { match: score >= cfg.faceThreshold && (liveness === undefined || liveness >= 0.5), score, liveness, demo: false };
  }
  // demo: accepts any non-trivial selfie. NEVER use in production.
  const looksLikeImage = input.selfie.length >= 64 && input.source.length >= 64;
  return { match: looksLikeImage, score: looksLikeImage ? 0.99 : 0, liveness: undefined, demo: true };
}
