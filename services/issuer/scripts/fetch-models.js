// Downloads the OpenCV Model Zoo face models (Apache-2.0) used for the selfie face match, verifying pinned SHA-256s.
// Non-fatal: without the models the issuer falls back to the (flagged) demo face provider and says so in its logs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.FACE_MODEL_DIR || path.join(__dirname, '..', 'models');
const MODELS = [
  { file: 'face_detection_yunet_2023mar.onnx', sha: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    urls: ['https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx', 'https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx'] },
  { file: 'face_recognition_sface_2021dec.onnx', sha: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
    urls: ['https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx', 'https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx'] },
];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  let failed = 0;
  for (const m of MODELS) {
    const dest = path.join(DIR, m.file);
    if (fs.existsSync(dest) && sha(fs.readFileSync(dest)) === m.sha) { console.log(`[models] ${m.file} ok`); continue; }
    let done = false;
    for (const url of m.urls) for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      try {
        const r = await fetch(url, { redirect: 'follow' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        if (sha(buf) !== m.sha) throw new Error('checksum mismatch');
        fs.writeFileSync(dest, buf); console.log(`[models] downloaded ${m.file} (${(buf.length / 1e6).toFixed(1)} MB)`); done = true;
      } catch (e) { console.warn(`[models] ${m.file} from ${new URL(url).host} attempt ${attempt}: ${e.message}`); }
    }
    if (!done) failed++;
  }
  if (failed) console.warn('[models] WARNING: face models missing – the issuer will use the DEMO face provider (credentials marked assurance_level=demo)');
})();
