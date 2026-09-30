// Opt-in integration test for the real Tesseract MRZ pipeline (downloads eng.traineddata on first run):
//   RUN_OCR=1 npm test -w @mosipid/issuer
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { readMrzFromImage, closeOcr } from '../src/proofing/ocr';

after(() => closeOcr());

test('Tesseract reads a rendered TD3 passport MRZ', { skip: !process.env.RUN_OCR, timeout: 180_000 }, async () => {
  const sharp = (await import('sharp')).default;
  const l1 = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', l2 = 'L898902C36UTO7408122F2909303<<<<<<<<<<<<<<<6';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900"><rect width="100%" height="100%" fill="#f2efe4"/>
    <text x="60" y="120" font-family="sans-serif" font-size="46" fill="#222">PASSPORT / PASSEPORT  ERIKSSON ANNA MARIA</text>
    <rect x="60" y="180" width="260" height="340" fill="#9bb"/>
    <text x="40" y="770" font-family="DejaVu Sans Mono, monospace" font-size="38" fill="#111">${l1.replace(/</g, '&lt;')}</text>
    <text x="40" y="830" font-family="DejaVu Sans Mono, monospace" font-size="38" fill="#111">${l2.replace(/</g, '&lt;')}</text></svg>`;
  const jpg = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
  const m = await readMrzFromImage(loadConfig({}, { ocrProvider: 'tesseract' }), jpg);
  assert.ok(m?.checksOk, 'MRZ checksums should pass: ' + JSON.stringify(m?.lines));
  assert.equal(m!.documentNumber, 'L898902C3');
  assert.equal(m!.surname, 'ERIKSSON');
});
