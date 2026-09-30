import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { alignmentMatrix, poseChanged, yawOf, cosine, modelsAvailable, faceEngine, MATCH_THRESHOLD } from '../src/proofing/face-engine';
import { compareFaces, effectiveProvider } from '../src/proofing/face';
import { loadConfig } from '../src/config';

test('alignment: landmarks already on the SFace template give the identity transform; scaled/shifted ones are undone', () => {
  const T = [38.2946, 51.6963, 73.5318, 51.5014, 56.0252, 71.7366, 41.5493, 92.3655, 70.7299, 92.2041];
  const id = alignmentMatrix([0, 0, 0, 0, ...T, 0.9]);
  [1, 0, 0, 0, 1, 0].forEach((v, i) => assert.ok(Math.abs(id[i] - v) < 1e-6, `m[${i}]=${id[i]}`));
  // same landmarks scaled ×2 and shifted by (100, 40) → transform must map them back
  const moved = T.map((v, i) => v * 2 + (i % 2 ? 40 : 100));
  const m = alignmentMatrix([0, 0, 0, 0, ...moved, 0.9]);
  const [a, , tx, , , ty] = m;
  assert.ok(Math.abs(a - 0.5) < 1e-6);
  assert.ok(Math.abs(a * moved[0] + tx - T[0]) < 1e-6 && Math.abs(a * moved[1] + ty - T[1]) < 1e-6);
});

test('head-pose logic: opposite turns and a frontal selfie pass; same-direction, tiny or non-frontal fail', () => {
  assert.equal(poseChanged(0.02, -0.25, 0.3), true);
  assert.equal(poseChanged(0.0, 0.25, 0.3), false);      // same side twice
  assert.equal(poseChanged(0.0, -0.05, 0.3), false);     // barely turned
  assert.equal(poseChanged(0.28, -0.25, 0.3), false);    // "selfie" is itself turned
  const box = new Float32Array(15); box[4] = 40; box[6] = 80; box[8] = 66; // nose right of the eye midpoint (60)
  assert.ok(Math.abs(yawOf(box) - 0.15) < 1e-6);
  assert.equal(cosine(Float32Array.of(1, 0), Float32Array.of(1, 0)), 1);
  assert.equal(MATCH_THRESHOLD, 0.363);
});

test('mock provider is flagged as demo; auto falls back to mock without models', async () => {
  const cfg = loadConfig({}, { faceProvider: 'mock' });
  const r = await compareFaces(cfg, { source: new Uint8Array(100), sourceMime: 'image/jpeg', sourceKind: 'document', selfie: new Uint8Array(100) });
  assert.ok(r.match && r.demo && r.provider === 'mock');
  assert.equal(effectiveProvider(loadConfig({}, { faceProvider: 'auto' })), modelsAvailable() ? 'opencv' : 'mock');
});

// Real models on real photos. Point FACE_TEST_DIR at a folder with sample1.jpg (person A) and sample2.jpg (person B).
const dir = process.env.FACE_TEST_DIR;
test('YuNet+SFace: same person matches, different person does not', { skip: !dir || !modelsAvailable() }, async () => {
  const sharp = (await import('sharp')).default;
  const e = await faceEngine();
  const a = await e.analyse(fs.readFileSync(path.join(dir!, 'sample1.jpg')), 'document');
  const b = await e.analyse(fs.readFileSync(path.join(dir!, 'sample2.jpg')), 'document');
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  const crop = await sharp(fs.readFileSync(path.join(dir!, 'sample1.jpg'))).extract({ left: Math.max(0, Math.round(a.box.x - a.box.w)), top: Math.max(0, Math.round(a.box.y - a.box.h * 0.8)), width: Math.round(a.box.w * 3), height: Math.round(a.box.h * 2.8) }).toBuffer();
  const same = await e.analyse(await sharp(crop).rotate(6, { background: '#777' }).jpeg({ quality: 60 }).toBuffer(), 'selfie');
  assert.ok(same.ok && cosine(a.embedding, same.embedding) > MATCH_THRESHOLD, 'same person should match');
  assert.ok(cosine(a.embedding, b.embedding) < MATCH_THRESHOLD, 'different people should not match');
  const cfg = loadConfig({}, { faceProvider: 'opencv' });
  const good = await compareFaces(cfg, { source: crop, sourceMime: 'image/jpeg', sourceKind: 'document', selfie: crop });
  assert.equal(good.failure, 'liveness_missing', 'liveness frames are required by default');
  const noFace = await compareFaces(cfg, { source: await sharp({ create: { width: 400, height: 400, channels: 3, background: '#8899aa' } }).jpeg().toBuffer(), sourceMime: 'image/jpeg', sourceKind: 'document', selfie: crop });
  assert.equal(noFace.failure, 'document_no_face');
});
