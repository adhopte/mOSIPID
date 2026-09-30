// Generates app icons / splash / web logos from brand/bluetiger-source.png (run: node scripts/make-brand-assets.js)
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '../brand/bluetiger-source.png');
const NAVY = { r: 10, g: 18, b: 48, alpha: 1 };

async function logo(size, pad = 0) {
  const inner = Math.round(size * (1 - pad * 2));
  const buf = await sharp(SRC).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: buf, gravity: 'center' }]).png();
}

(async () => {
  for (const app of ['wallet', 'proximity-verifier']) {
    const dir = path.join(__dirname, '../apps', app, 'assets');
    fs.mkdirSync(dir, { recursive: true });
    // legacy/iOS icon: opaque navy tile with the tiger
    const tile = await (await logo(1024, 0.08)).toBuffer();
    await sharp({ create: { width: 1024, height: 1024, channels: 4, background: NAVY } }).composite([{ input: tile }]).flatten({ background: NAVY }).png().toFile(path.join(dir, 'icon.png'));
    // Android adaptive icon: foreground must live inside the central 66% safe zone
    await (await logo(1024, 0.19)).toFile(path.join(dir, 'adaptive-icon.png'));
    await (await logo(1024, 0.19)).toFile(path.join(dir, 'splash-icon.png'));
    await (await logo(512, 0.02)).toFile(path.join(dir, 'logo.png'));
    await (await logo(96, 0.04)).toFile(path.join(dir, 'favicon.png'));
  }
  const web = path.join(__dirname, '../packages/web-shared/brand');
  fs.mkdirSync(web, { recursive: true });
  await (await logo(512, 0.02)).toFile(path.join(web, 'bluetiger-logo.png'));
  await (await logo(64, 0.04)).toFile(path.join(web, 'favicon.png'));
  const tile = await (await logo(180, 0.1)).toBuffer();
  await sharp({ create: { width: 180, height: 180, channels: 4, background: NAVY } }).composite([{ input: tile }]).png().toFile(path.join(web, 'apple-touch-icon.png'));
  console.log('brand assets written');
})();
