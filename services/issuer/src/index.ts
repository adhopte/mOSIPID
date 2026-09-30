import { createStore } from '@mosipid/server-kit';
import { loadConfig } from './config';
import { buildApp } from './app';
import { effectiveProvider } from './proofing/face';

async function main() {
  const cfg = loadConfig();
  const store = await createStore();
  const app = await buildApp(store, cfg);
  const port = Number(process.env.PORT || 3002);
  app.listen(port, () => {
    console.log(`[issuer] ${cfg.publicUrl} listening on :${port}`);
    const fp = effectiveProvider(cfg);
    if (fp === 'mock') console.warn('[issuer] face matching is a DEMO stub (no models found / FACE_PROVIDER=mock) – credentials are marked assurance_level=demo');
    else console.log(`[issuer] face matching: ${fp}${fp === 'opencv' ? ' (OpenCV YuNet + SFace)' : ''}`);
    if (!cfg.cscaPems.length) console.warn('[issuer] no CSCA_PEM configured – passport chain-of-trust is not checked (demo mode)');
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
