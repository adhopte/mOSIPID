// Face detection (YuNet) + recognition (SFace): the OpenCV Model Zoo models used by the reference eMRTD-Tester backend,
// with the same decision thresholds and head-pose logic. Inference runs on ONNX Runtime (CPU, ~150 MB RSS), while
// YuNet's post-processing and the 5-point SFace alignment follow OpenCV's FaceDetectorYN / FaceRecognizerSF code.
import fs from 'node:fs';
import path from 'node:path';

export const YUNET_FILE = 'face_detection_yunet_2023mar.onnx';
export const SFACE_FILE = 'face_recognition_sface_2021dec.onnx';
/** SFace cosine similarity recommended by OpenCV for "same identity" (LFW-calibrated). */
export const MATCH_THRESHOLD = 0.363;
/** Frames captured seconds apart in one session: pose changes lower the score a little. */
export const SESSION_THRESHOLD = 0.30;
/** Nose offset from the eye midpoint, in inter-ocular distances, for a head turn to count. */
export const MIN_TURN_YAW = 0.12;
export const MAX_FRONTAL_YAW = 0.12;
const SCORE_THRESHOLD = 0.7, NMS_THRESHOLD = 0.3, TOP_K = 500;

/** ArcFace/SFace 112x112 landmark template: right eye, left eye, nose, right mouth corner, left mouth corner. */
const TEMPLATE: number[][] = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

export interface DetectedFace {
  /** x, y, w, h, 5 × (x, y) landmarks, score – the same 15-value layout OpenCV's FaceDetectorYN returns */
  box: Float32Array; score: number; width: number; yaw: number;
}

export function modelDir(): string {
  if (process.env.FACE_MODEL_DIR) return process.env.FACE_MODEL_DIR;
  // dev (tsx): src/proofing → ../../models ; prod (esbuild bundle): dist → ../models
  const candidates = [path.resolve(__dirname, '../models'), path.resolve(__dirname, '../../models')];
  return candidates.find((d) => fs.existsSync(path.join(d, YUNET_FILE))) ?? candidates[0];
}
export function modelsAvailable(dir = modelDir()): boolean {
  return [YUNET_FILE, SFACE_FILE].every((f) => fs.existsSync(path.join(dir, f)));
}

export function yawOf(b: ArrayLike<number>): number {
  const rex = b[4], lex = b[6], nx = b[8];
  const eye = Math.abs(lex - rex) || 1;
  return (nx - (rex + lex) / 2) / eye;
}

/** True when both turn frames are clearly turned in opposite directions and the selfie is closer to frontal. */
export function poseChanged(frontal: number, left: number, right: number): boolean {
  return Math.abs(left) >= MIN_TURN_YAW && Math.abs(right) >= MIN_TURN_YAW && left * right < 0 &&
    Math.abs(frontal) <= Math.max(MAX_FRONTAL_YAW, 0.6 * Math.min(Math.abs(left), Math.abs(right)));
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Similarity transform (scale + rotation + translation) mapping the 5 landmarks onto the SFace template. Returns [a, -b, tx, b, a, ty]. */
export function alignmentMatrix(box: ArrayLike<number>): number[] {
  const src: number[][] = [[box[4], box[5]], [box[6], box[7]], [box[8], box[9]], [box[10], box[11]], [box[12], box[13]]];
  const n = 5;
  const mean = (p: number[][], i: number) => p.reduce((s, q) => s + q[i], 0) / n;
  const sm = [mean(src, 0), mean(src, 1)], dm = [mean(TEMPLATE, 0), mean(TEMPLATE, 1)];
  let ss = 0, dot = 0, cross = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - sm[0], sy = src[i][1] - sm[1], dx = TEMPLATE[i][0] - dm[0], dy = TEMPLATE[i][1] - dm[1];
    ss += sx * sx + sy * sy; dot += sx * dx + sy * dy; cross += sx * dy - sy * dx;
  }
  const a = dot / (ss || 1), b = cross / (ss || 1);
  return [a, -b, dm[0] - (a * sm[0] - b * sm[1]), b, a, dm[1] - (b * sm[0] + a * sm[1])];
}

interface Rgb { data: Uint8Array; width: number; height: number }

/** Bilinear warp of `img` (RGB) into a 112×112 crop using the forward matrix `m` (src→dst). Zero border. */
function warp112(img: Rgb, m: number[]): Uint8Array {
  const [a, mb, tx, b, d, ty] = m;   // forward: dx = a*x + mb*y + tx ; dy = b*x + d*y + ty
  const det = a * d - mb * b;
  const ia = d / det, ib = -mb / det, ic = -b / det, id = a / det;
  const out = new Uint8Array(112 * 112 * 3);
  for (let y = 0; y < 112; y++) for (let x = 0; x < 112; x++) {
    const px = x - tx, py = y - ty;
    const sx = ia * px + ib * py, sy = ic * px + id * py;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    for (let c = 0; c < 3; c++) {
      const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height ? 0 : img.data[(yy * img.width + xx) * 3 + c]);
      const v = at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
      out[(y * 112 + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return out;
}

function nms(cands: Float32Array[]): Float32Array[] {
  const sorted = cands.sort((p, q) => q[14] - p[14]).slice(0, TOP_K);
  const keep: Float32Array[] = [];
  const iou = (p: Float32Array, q: Float32Array) => {
    const x1 = Math.max(p[0], q[0]), y1 = Math.max(p[1], q[1]), x2 = Math.min(p[0] + p[2], q[0] + q[2]), y2 = Math.min(p[1] + p[3], q[1] + q[3]);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (p[2] * p[3] + q[2] * q[3] - inter || 1);
  };
  for (const c of sorted) if (keep.every((k) => iou(k, c) <= NMS_THRESHOLD)) keep.push(c);
  return keep;
}

export class FaceEngine {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private ort: any, private yunet: any, private sface: any, private sharp: any) {}

  static async create(dir = modelDir()): Promise<FaceEngine> {
    const ort = require('onnxruntime-node');
    const opts = { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, enableCpuMemArena: false, graphOptimizationLevel: 'all', logSeverityLevel: 3 };
    const yunet = await ort.InferenceSession.create(path.join(dir, YUNET_FILE), opts);
    const sface = await ort.InferenceSession.create(path.join(dir, SFACE_FILE), opts);
    const sharp = (await import('sharp' as string)).default;
    return new FaceEngine(ort, yunet, sface, sharp);
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {   // one inference at a time keeps memory flat
    const r = this.queue.then(fn, fn);
    this.queue = r.catch(() => {});
    return r;
  }

  /** Decode to RGB and scale like the reference: max side 640, min side ≥ 320. */
  private async decode(bytes: Uint8Array): Promise<Rgb & { scale: number; origW: number; origH: number }> {
    const base = this.sharp(Buffer.from(bytes), { failOn: 'none' }).rotate().flatten({ background: '#ffffff' }).toColourspace('srgb');
    const meta = await base.clone().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = meta.info;
    const scale = Math.max(w, h) > 640 ? 640 / Math.max(w, h) : Math.min(w, h) < 320 ? 320 / Math.min(w, h) : 1;
    if (scale === 1) return { data: new Uint8Array(meta.data), width: w, height: h, scale, origW: w, origH: h };
    const tw = Math.round(w * scale), th = Math.round(h * scale);
    const r = await this.sharp(meta.data, { raw: { width: w, height: h, channels: meta.info.channels } }).resize(tw, th, { kernel: scale < 1 ? 'lanczos3' : 'cubic' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(r.data), width: tw, height: th, scale, origW: w, origH: h };
  }

  private async detect(img: Rgb): Promise<DetectedFace[]> {
    // YuNet takes BGR 0..255, NCHW. The ONNX has a fixed 640×640 input, so the (≤640 px) image sits in the top-left of a
    // zero-padded canvas – coordinates are therefore unchanged.
    const pw = 640, ph = 640;
    const t = new Float32Array(3 * pw * ph);
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 3, o = y * pw + x;
      t[o] = img.data[i + 2]; t[pw * ph + o] = img.data[i + 1]; t[2 * pw * ph + o] = img.data[i];
    }
    const out = await this.yunet.run({ input: new this.ort.Tensor('float32', t, [1, 3, ph, pw]) });
    const cands: Float32Array[] = [];
    [8, 16, 32].forEach((stride) => {
      const cols = pw / stride, rows = ph / stride;
      const cls = out[`cls_${stride}`].data, obj = out[`obj_${stride}`].data, bbox = out[`bbox_${stride}`].data, kps = out[`kps_${stride}`].data;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const score = Math.sqrt(Math.min(Math.max(cls[idx], 0), 1) * Math.min(Math.max(obj[idx], 0), 1));
        if (score < SCORE_THRESHOLD) continue;
        const cx = (c + bbox[idx * 4]) * stride, cy = (r + bbox[idx * 4 + 1]) * stride;
        const w = Math.exp(bbox[idx * 4 + 2]) * stride, h = Math.exp(bbox[idx * 4 + 3]) * stride;
        const row = new Float32Array(15);
        row[0] = cx - w / 2; row[1] = cy - h / 2; row[2] = w; row[3] = h;
        for (let n = 0; n < 5; n++) { row[4 + 2 * n] = (kps[idx * 10 + 2 * n] + c) * stride; row[5 + 2 * n] = (kps[idx * 10 + 2 * n + 1] + r) * stride; }
        row[14] = score;
        cands.push(row);
      }
    });
    return nms(cands).map((box) => ({ box, score: box[14], width: box[2], yaw: yawOf(box) })).sort((p, q) => q.width - p.width);
  }

  private async embed(img: Rgb, face: DetectedFace): Promise<Float32Array> {
    const crop = warp112(img, alignmentMatrix(face.box));       // RGB, 0..255 (SFace expects swapRB blob, no scaling)
    const t = new Float32Array(3 * 112 * 112);
    for (let i = 0; i < 112 * 112; i++) { t[i] = crop[i * 3]; t[112 * 112 + i] = crop[i * 3 + 1]; t[2 * 112 * 112 + i] = crop[i * 3 + 2]; }
    const out = await this.sface.run({ data: new this.ort.Tensor('float32', t, [1, 3, 112, 112]) });
    return Float32Array.from(out.fc1.data as Float32Array);
  }

  /** Largest face of an image: embedding, head-turn estimate and its box in *original* pixel coordinates. */
  analyse(bytes: Uint8Array, what: 'document' | 'chip' | 'selfie' | 'turn_left' | 'turn_right'): Promise<
    { ok: true; embedding: Float32Array; yaw: number; faces: number; box: { x: number; y: number; w: number; h: number }; width: number; height: number } | { ok: false; reason: string }
  > {
    return this.run(async () => {
      let img;
      try { img = await this.decode(bytes); } catch { return { ok: false as const, reason: `${what}_image_invalid` }; }
      const faces = await this.detect(img);
      if (!faces.length) return { ok: false as const, reason: `${what}_no_face` };
      if (what !== 'document' && what !== 'chip' && faces.length > 1 && faces[1].width > 0.5 * faces[0].width) return { ok: false as const, reason: `${what}_multiple_faces` };
      const f = faces[0];
      const s = 1 / img.scale;
      return {
        ok: true as const, embedding: await this.embed(img, f), yaw: f.yaw, faces: faces.length,
        box: { x: f.box[0] * s, y: f.box[1] * s, w: f.box[2] * s, h: f.box[3] * s }, width: img.origW, height: img.origH,
      };
    });
  }

  /** Portrait crop (with ICAO-style margin) of the face found by `analyse`, as a bounded JPEG. */
  async cropPortrait(bytes: Uint8Array, box: { x: number; y: number; w: number; h: number }, imgW: number, imgH: number): Promise<Uint8Array | null> {
    try {
      const mx = box.w * 0.55, top = box.h * 0.65, bottom = box.h * 0.55;
      const left = Math.max(0, Math.round(box.x - mx)), t = Math.max(0, Math.round(box.y - top));
      const width = Math.min(imgW - left, Math.round(box.w + 2 * mx)), height = Math.min(imgH - t, Math.round(box.h + top + bottom));
      return await this.sharp(Buffer.from(bytes)).rotate().extract({ left, top: t, width, height }).resize({ width: 240, height: 320, fit: 'cover' }).jpeg({ quality: 72 }).toBuffer();
    } catch { return null; }
  }
}

let engineP: Promise<FaceEngine> | undefined;
export const faceEngine = (dir?: string) => (engineP ??= FaceEngine.create(dir));
export function closeFaceEngine() { engineP = undefined; }
