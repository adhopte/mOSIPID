import { createStore } from '@mosipid/server-kit';
import { loadConfig } from './config';
import { buildApp } from './app';

async function main() {
  const cfg = loadConfig();
  const store = await createStore();
  const app = await buildApp(store, cfg);
  const port = Number(process.env.PORT || 3002);
  app.listen(port, () => {
    console.log(`[issuer] ${cfg.publicUrl} listening on :${port}`);
    if (cfg.faceProvider === 'mock') console.warn('[issuer] FACE_PROVIDER=mock – face matching is a DEMO stub, credentials are marked assurance_level=demo');
    if (!cfg.cscaPems.length) console.warn('[issuer] no CSCA_PEM configured – passport chain-of-trust is not checked (demo mode)');
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
