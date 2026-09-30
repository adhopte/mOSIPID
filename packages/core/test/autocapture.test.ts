import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoCaptureDetector, observeFrame, mrzFromPages, EMPTY_OBSERVATION } from '../src/autocapture';

const L1 = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', L2 = 'L898902C36UTO7408122F2909303<<<<<<<<<<<<<<<6';
const frame = (dx = 0, lines = [L1, L2], width = 1000) => ({
  text: lines.join('\n'), width, height: 1400,
  lines: lines.map((t, i) => ({ text: t, left: 80 + dx, top: 1100 + i * 60, right: 920 + dx, bottom: 1150 + i * 60 })),
});

test('captures only after a valid MRZ is seen in 3 consecutive steady frames', () => {
  const d = new AutoCaptureDetector();
  assert.equal(d.onFrame(observeFrame(frame())), 'hold_still');
  assert.equal(d.onFrame(observeFrame(frame(4))), 'hold_still');
  assert.equal(d.onFrame(observeFrame(frame(6))), 'capture');
});

test('moving the document resets the stability counter', () => {
  const d = new AutoCaptureDetector();
  d.onFrame(observeFrame(frame())); d.onFrame(observeFrame(frame()));
  assert.equal(d.onFrame(observeFrame(frame(200))), 'hold_still');   // jumped 20% sideways → restart at 1
  assert.equal(d.onFrame(observeFrame(frame(202))), 'hold_still');
  assert.equal(d.onFrame(observeFrame(frame(203))), 'capture');
});

test('invalid / missing / tiny MRZ never triggers a capture', () => {
  const d = new AutoCaptureDetector();
  const broken = frame(0, [L1, L2.slice(0, 14) + '9' + L2.slice(15)]);
  for (let i = 0; i < 5; i++) assert.equal(d.onFrame(observeFrame(broken)), 'searching');
  assert.equal(d.onFrame(EMPTY_OBSERVATION), 'searching');
  const far = frame(0, [L1, L2], 4000);      // text spans only 21% of the frame
  assert.equal(d.onFrame(observeFrame(far)), 'too_far');
});

test('noisy ML Kit output (O/0 confusion, stray characters) still validates', () => {
  const noisy = frame(0, ['PASSPORT', L1, L2.replace('UTO', 'UT0')]);
  const o = observeFrame(noisy);
  assert.ok(o.mrzValid); assert.equal(o.mrz?.documentNumber, 'L898902C3');
});

test('uploaded PDFs: MRZ is found on whichever page has it', () => {
  const m = mrzFromPages(['Photo page, no machine readable zone here', `Back page\n${L1}\n${L2}`]);
  assert.ok(m?.checksOk);
  assert.equal(mrzFromPages(['nothing', 'to see']), null);
});
