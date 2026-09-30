import path from 'node:path';
import { extractMrz, MrzData } from '@mosipid/core';
import { IssuerConfig } from '../config';
import { mrzRegions } from './images';

let workerP: Promise<any> | undefined;
async function worker() {
  workerP ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    // eng.traineddata ships in the npm package, so no CDN download is needed at runtime (works offline / behind proxies)
    const langPath = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');
    const w = await createWorker('eng', 1, { langPath, cachePath: process.env.TESSDATA_CACHE || '/tmp/tessdata' });
    await w.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<', preserve_interword_spaces: '0' });
    return w;
  })();
  return workerP;
}

/** Finds and parses the MRZ from a document photo. `debugMrz` is honoured only with OCR_PROVIDER=mock. */
export async function readMrzFromImage(cfg: IssuerConfig, image: Uint8Array, debugMrz?: string[]): Promise<MrzData | null> {
  if (cfg.ocrProvider === 'mock') {
    if (!debugMrz) return null;
    return extractMrz(debugMrz.join('\n'));
  }
  const w = await worker();
  let best: MrzData | null = null;
  for (const region of await mrzRegions(image)) {
    const { data } = await w.recognize(Buffer.from(region));
    const m = extractMrz(data.text);
    if (m?.checksOk) return m;
    best ??= m;
  }
  return best;
}
