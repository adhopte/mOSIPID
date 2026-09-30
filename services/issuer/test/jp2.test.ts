import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractFaceImage } from '@mosipid/core';
import { jp2ToJpeg } from '../src/proofing/jp2';

test('JPEG 2000 (as stored in passport DG2) is converted to a normal JPEG', async () => {
  const jp2 = fs.readFileSync(path.join(__dirname, 'fixtures/gradient.jp2'));
  // DG2 wraps the image in biometric TLVs – make sure we find it and decode it
  const dg2 = Buffer.concat([Buffer.from('7501020304050607', 'hex'), Buffer.alloc(20, 1), jp2, Buffer.alloc(3, 0)]);
  const found = extractFaceImage(dg2);
  assert.equal(found?.mime, 'image/jp2');
  const jpg = await jp2ToJpeg(found!.data);
  assert.ok(jpg && jpg[0] === 0xff && jpg[1] === 0xd8, 'JPEG SOI');
  const sharp = (await import('sharp')).default;
  const meta = await sharp(Buffer.from(jpg!)).metadata();
  assert.deepEqual([meta.width, meta.height, meta.format], [64, 80, 'jpeg']);
  assert.equal(await jp2ToJpeg(Buffer.from('not an image')), null);
});
