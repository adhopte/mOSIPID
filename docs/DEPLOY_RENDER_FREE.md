# Deploying on Render with **no card** (all free)

Render asks for a payment method when you use a **Blueprint** (`render.yaml`) because it also creates a paid-plan service and a Render-hosted database.
Creating **individual Free web services** from the dashboard, and hosting the database elsewhere, avoids that. (Render's policies change – if a card prompt still
appears, the free web-service form is the part they've historically not asked for it on; Neon below never asks.)

Total: **3 Free web services (Render) + 1 free Postgres (Neon)**, no card.

## 1. Free Postgres on Neon (2 min)
1. Sign up at <https://neon.tech> (GitHub login, no card) → create a project → copy the **connection string**
   (looks like `postgres://user:pass@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require`).
2. Keep it for the `DATABASE_URL` variable below. (Supabase's free Postgres works the same way.)
   The code enables TLS automatically for `sslmode=require` / `*.render.com` URLs.

> Why a database at all? Free Render services **sleep and restart**; without a DB, the branding you set and – more importantly – the **mock IACA keys** would be
> regenerated, breaking every credential already issued. If you skip the DB, at least pin the CAs: run `npm run gen:iaca` locally and paste the printed
> `IACA_*` / `EDU_*` lines into the issuer's environment. (Branding edits will still reset on each restart.)

## 2. Create the three Free web services
Render → **New → Web Service** → connect this GitHub repo/branch. Use these settings for each (leave *Root Directory* empty, **Instance Type: Free**):

| | Name | Build Command | Start Command |
|---|---|---|---|
| A | `yourname-admin` | `ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --include=dev && npm run build -w @mosipid/admin` | `node services/admin/dist/index.js` |
| B | `yourname-issuer` | `ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --include=dev && npm run build -w @mosipid/issuer` | `node services/issuer/dist/index.js` |
| C | `yourname-verifier` | `ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --include=dev && npm run build -w @mosipid/verifier` | `node services/verifier/dist/index.js` |

Set **Health Check Path** to `/healthz` on each. Names must be globally unique, so prefix them – your URLs will be `https://yourname-admin.onrender.com`, etc. Note all three now.

### Environment variables
**All three:** `NODE_VERSION=22` · `NODE_ENV=production` · `DATABASE_URL=<Neon string>`

| Service | Also set |
|---|---|
| A admin | `ADMIN_USER=admin` · `ADMIN_PASSWORD=<pick one>` · `SESSION_SECRET=<random 32+ chars>` |
| B issuer | `ADMIN_URL=https://yourname-admin.onrender.com` · `VERIFIER_URL=https://yourname-verifier.onrender.com` · `OCR_PROVIDER=tesseract` · `FACE_PROVIDER=mock` · `PASSIVE_AUTH=demo` |
| C verifier | `SESSION_SECRET=<random 32+ chars>` · `ADMIN_URL=https://yourname-admin.onrender.com` · `ISSUER_URL=https://yourname-issuer.onrender.com` |

(`PUBLIC_URL` is filled in automatically from Render.) Generate a secret with `openssl rand -hex 32`.

### Is the free 512 MB enough for OCR?
Measured on this code: the issuer idles at ~60 MB and peaks around **270 MB** while OCR-ing a document photo; OCR jobs are serialized and image processing is capped
to keep it flat. One user at a time is fine. If you ever see out-of-memory restarts, set `OCR_PROVIDER=mock` (OCR off; only for demos) or move the issuer to a paid plan.

## 3. Smoke test
Same as [DEPLOY_RENDER.md § 4](DEPLOY_RENDER.md): `/healthz` on each, admin sign-in, `…/verifier/electricity.html` picks up your branding, `…/issuer/university.html` shows a QR + PIN.

## Free-tier behaviour to expect
* Services **spin down after ~15 min idle** and take ~30–60 s to wake (first request of the day is slow; the mobile apps and web pages fall back to built-in branding while admin wakes).
  Tip: open the three `/healthz` URLs a minute before a demo, or point a free uptime pinger (e.g. UptimeRobot) at them – be aware this uses your monthly free-instance hours (750 h/month across the account).
* The proximity relay is in-memory: fine on one instance (free is always one).
* Neon free databases auto-suspend when idle and resume on the next query (~1 s).

## Point the apps at your URLs
`apps/*/app.json → expo.extra`, or in the app: **Settings → Servers** (see [MOBILE.md](MOBILE.md)).
