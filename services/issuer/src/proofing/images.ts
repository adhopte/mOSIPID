// Image helpers. `sharp` is optional; without it we pass bytes through unchanged.
let sharpMod: any | null | undefined;
async function sharp() {
  if (sharpMod !== undefined) return sharpMod;
  try {
    sharpMod = (await import('sharp' as string)).default;
    sharpMod.cache(false); sharpMod.concurrency(1); // keep memory flat on 512 MB instances
  } catch { sharpMod = null; }
  return sharpMod;
}

export function decodeB64Image(s: unknown, max = 6 * 1024 * 1024): Uint8Array {
  if (typeof s !== 'string' || !s) throw new Error('missing_image');
  const b = Buffer.from(s.replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!b.length || b.length > max) throw new Error('image_too_large');
  return b;
}

export async function toPortraitJpeg(bytes: Uint8Array): Promise<Uint8Array | null> {
  const sh = await sharp();
  if (!sh) return bytes.length < 60_000 ? bytes : null;
  try {
    return await sh(Buffer.from(bytes)).rotate().resize({ width: 240, height: 320, fit: 'cover', position: 'attention' }).jpeg({ quality: 70 }).toBuffer();
  } catch { return null; }
}

export async function mrzRegions(bytes: Uint8Array): Promise<Uint8Array[]> {
  const sh = await sharp();
  if (!sh) return [bytes];
  const out: Uint8Array[] = [];
  try {
    const img = sh(Buffer.from(bytes)).rotate();
    const meta = await img.metadata();
    const w = meta.width ?? 1600, h = meta.height ?? 1000;
    const prep = (s: any) => s.resize({ width: 1800, withoutEnlargement: false }).grayscale().normalise().sharpen().png().toBuffer();
    out.push(await prep(sh(Buffer.from(bytes)).rotate().extract({ left: 0, top: Math.floor(h * 0.62), width: w, height: h - Math.floor(h * 0.62) })));
    out.push(await prep(sh(Buffer.from(bytes)).rotate()));
  } catch { out.push(bytes); }
  return out;
}
