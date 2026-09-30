import { createStore, baseUrl, secretFromEnv } from '@mosipid/server-kit';
import { buildApp } from './app';
import { TrustService } from './trust';

async function main() {
  const publicUrl = (process.env.PUBLIC_URL || baseUrl()).replace(/\/$/, '');
  const issuerUrl = process.env.ISSUER_URL?.replace(/\/$/, '');
  const store = await createStore();
  const trust = new TrustService(issuerUrl ? [issuerUrl] : [], { iaca: process.env.IACA_PEM ?? '', edu: process.env.EDU_PEM ?? '' });
  const app = buildApp(store, { internalUrl: `http://127.0.0.1:${process.env.PORT || 3003}`, publicUrl, adminUrl: process.env.ADMIN_URL?.replace(/\/$/, ''), issuerUrl, secret: secretFromEnv('SESSION_SECRET') }, trust);
  const port = Number(process.env.PORT || 3003);
  app.listen(port, () => console.log(`[verifier] ${publicUrl} listening on :${port} (trust source: ${issuerUrl ?? 'static env'})`));
  trust.list().then((a) => console.log(`[verifier] ${a.length} trust anchors loaded`)).catch(() => {});
}
main().catch((e) => { console.error(e); process.exit(1); });
