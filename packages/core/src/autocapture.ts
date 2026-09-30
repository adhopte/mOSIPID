// Auto-capture decision logic (pure, unit-tested). The phone streams ML Kit OCR results for camera frames; this decides
// when the document is readable *and* steady, so the app can take the photo by itself – the same rule the reference
// eMRTD-Tester uses: a check-digit-valid MRZ, in N consecutive frames whose text block has barely moved.
import { extractMrz, MrzData } from './mrz';

export type AutoCaptureStatus = 'searching' | 'too_far' | 'hold_still' | 'capture';

export interface OcrLine { text: string; left: number; top: number; right: number; bottom: number }
export interface FrameOcr { text: string; lines: OcrLine[]; width: number; height: number }

export interface FrameObservation {
  mrzValid: boolean; mrzLikeLines: number; textLines: number;
  left: number; top: number; right: number; bottom: number; // normalised 0..1 of the upright frame
  mrz?: MrzData;
}
export const EMPTY_OBSERVATION: FrameObservation = { mrzValid: false, mrzLikeLines: 0, textLines: 0, left: 0, top: 0, right: 0, bottom: 0 };

const looksLikeMrz = (t: string) => { const s = t.replace(/\s/g, ''); return s.length >= 28 && (s.match(/</g)?.length ?? 0) >= 2; };

export function observeFrame(f: FrameOcr): FrameObservation {
  if (!f.lines.length || !f.width || !f.height) return EMPTY_OBSERVATION;
  const mrzLines = f.lines.filter((l) => looksLikeMrz(l.text));
  const box = (mrzLines.length ? mrzLines : f.lines);
  const mrz = extractMrz(f.text) ?? undefined;
  return {
    mrzValid: !!mrz?.checksOk, mrzLikeLines: mrzLines.length, textLines: f.lines.length, mrz,
    left: Math.min(...box.map((l) => l.left)) / f.width, top: Math.min(...box.map((l) => l.top)) / f.height,
    right: Math.max(...box.map((l) => l.right)) / f.width, bottom: Math.max(...box.map((l) => l.bottom)) / f.height,
  };
}

export class AutoCaptureDetector {
  private stable = 0;
  private last?: FrameObservation;
  constructor(private requiredStableFrames = 3, private maxShift = 0.05, private minTextWidth = 0.45) {}

  onFrame(o: FrameObservation): AutoCaptureStatus {
    const width = o.right - o.left;
    if (!o.mrzValid) {
      this.reset();
      return o.textLines > 0 && width < this.minTextWidth ? 'too_far' : 'searching';
    }
    if (width < this.minTextWidth) { this.reset(); return 'too_far'; }
    const p = this.last;
    const cx = (o.left + o.right) / 2, cy = (o.top + o.bottom) / 2;
    this.stable = p && Math.abs((p.left + p.right) / 2 - cx) <= this.maxShift && Math.abs((p.top + p.bottom) / 2 - cy) <= this.maxShift && Math.abs((p.right - p.left) - width) <= this.maxShift ? this.stable + 1 : 1;
    this.last = o;
    return this.stable >= this.requiredStableFrames ? 'capture' : 'hold_still';
  }
  reset() { this.stable = 0; this.last = undefined; }
}

/** Merge the text of several pages (e.g. a PDF's photo page + back page) and return the best valid MRZ found. */
export function mrzFromPages(texts: string[]): MrzData | null {
  let best: MrzData | null = null;
  for (const t of [...texts, texts.join('\n')]) {
    const m = extractMrz(t);
    if (m?.checksOk) return m;
    best ??= m;
  }
  return best;
}
