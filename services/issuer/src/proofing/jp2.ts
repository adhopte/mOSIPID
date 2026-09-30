// Passport chips (DG2) store the portrait as JPEG 2000, which sharp/libvips builds usually can't read.
// The OpenJPEG WASM decoder turns it into a normal JPEG for the face engine and the credential portrait.
import path from 'node:path';

let modP: Promise<any> | undefined;
async function openjpeg() {
  modP ??= (async () => {
    // the package's `exports` map hides package.json, so locate `dist/` through the main entry point
    const dist = path.dirname(require.resolve('@cornerstonejs/codec-openjpeg'));
    const factory = require(path.join(dist, 'openjpegwasm_decode.js'));
    return factory({ locateFile: (f: string) => path.join(dist, f) });
  })();
  return modP;
}

export async function jp2ToJpeg(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const mod = await openjpeg();
    const dec = new mod.J2KDecoder();
    try {
      dec.getEncodedBuffer(bytes.length).set(bytes);
      dec.decode();
      const fi = dec.getFrameInfo();
      const raw = Buffer.from(dec.getDecodedBuffer());
      if (fi.bitsPerSample !== 8 || ![1, 3, 4].includes(fi.componentCount) || raw.length !== fi.width * fi.height * fi.componentCount) return null;
      const sharp = (await import('sharp' as string)).default;
      return await sharp(raw, { raw: { width: fi.width, height: fi.height, channels: fi.componentCount } }).jpeg({ quality: 92 }).toBuffer();
    } finally { dec.delete(); }
  } catch { return null; }
}
