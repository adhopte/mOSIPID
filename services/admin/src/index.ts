import { randomBytes } from 'node:crypto';
import { createStore, secretFromEnv } from '@mosipid/server-kit';
import { buildApp } from './app';

async function main() {
  const prod = process.env.NODE_ENV === 'production';
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    if (prod) { password = randomBytes(9).toString('base64url'); console.warn(`[admin] ADMIN_PASSWORD not set – generated one-off password: ${password}`); }
    else password = 'admin';
  }
  const store = await createStore();
  const app = buildApp({ store, user: process.env.ADMIN_USER || 'admin', password, secret: secretFromEnv('SESSION_SECRET') });
  const port = Number(process.env.PORT || 3001);
  app.listen(port, () => console.log(`[admin] listening on :${port}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
