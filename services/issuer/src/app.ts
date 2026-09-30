import path from 'node:path';
import { DEFAULT_BRANDING } from '@mosipid/core';
import { createApp, errorHandler, Store, sharedWeb } from '@mosipid/server-kit';
import { IssuerConfig } from './config';
import { oid4vciRouter } from './oid4vci';
import { proofingRouter } from './proofing/routes';
import { loadPki, trustList, Pki } from './trust';

export async function buildApp(store: Store, cfg: IssuerConfig, pkiOverride?: Pki) {
  const pki = pkiOverride ?? (await loadPki(store, cfg.publicUrl));
  const app = createApp({ name: 'issuer', staticDirs: [path.resolve(__dirname, '../public')], sharedWebDir: sharedWeb(__dirname), jsonLimit: '12mb' });

  app.get('/config.js', (_req, res) => res.type('js').send(`window.__CONFIG__=${JSON.stringify({
    adminUrl: cfg.adminUrl, verifierUrl: cfg.verifierUrl, issuerUrl: cfg.publicUrl,
    demo: { face: cfg.faceProvider === 'mock', passiveAuth: cfg.cscaPems.length === 0 },
    defaultBranding: DEFAULT_BRANDING['issuer-id'], universityBranding: DEFAULT_BRANDING['issuer-university'],
  })};`));
  app.get('/api/trust', (_req, res) => { res.setHeader('cache-control', 'public, max-age=60'); res.json({ anchors: trustList(pki, cfg.publicUrl) }); });
  app.get('/iaca.pem', (_req, res) => res.type('application/x-pem-file').send(pki.iaca.pem));
  app.use(oid4vciRouter(store, cfg, pki));
  app.use(proofingRouter(store, cfg));
  errorHandler(app);
  return app;
}
