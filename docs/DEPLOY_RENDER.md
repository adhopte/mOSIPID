# Deploying the backend services on Render

You will create **3 web services + 1 Postgres** from one repo using the Blueprint in `render.yaml`:
`mosipid-admin` (branding portal), `mosipid-issuer`, `mosipid-verifier`, and `mosipid-db`.

## 0. Prerequisites
* This repo pushed to GitHub/GitLab (the branch you want to deploy).
* A Render account. Cost note: `mosipid-issuer` is set to **Starter** (OCR needs >512 MB); admin/verifier/DB use **Free**. See “Plans” below.

## 1. Create the Blueprint
Render Dashboard → **New → Blueprint** → pick the repo/branch → Render reads `render.yaml`.
It will ask for the variables marked `sync: false`. You don't know the URLs yet – **enter placeholders** (e.g. `https://placeholder`); you'll fix them in step 3.
(If you'd rather avoid the second pass, choose globally unique service names in `render.yaml` first, e.g. `acme-admin`, `acme-issuer`, `acme-verifier`, so you know the URLs `https://acme-admin.onrender.com` … in advance.)

## 2. First deploy
Wait for the three services to build (`npm ci --include=dev && npm run build -w …`) and go **Live**. Check `https://<service>.onrender.com/healthz` → `{"status":"ok"}`.

## 3. Wire the services together
Set these in each service → **Environment** and let it redeploy:

| Service | Variable | Value |
|---|---|---|
| mosipid-issuer | `ADMIN_URL` | `https://<admin>.onrender.com` |
| mosipid-issuer | `VERIFIER_URL` | `https://<verifier>.onrender.com` |
| mosipid-verifier | `ADMIN_URL` | `https://<admin>.onrender.com` |
| mosipid-verifier | `ISSUER_URL` | `https://<issuer>.onrender.com` (trust anchors are fetched from here) |

`PUBLIC_URL` is derived automatically from Render's `RENDER_EXTERNAL_URL`. If you attach a **custom domain**, set `PUBLIC_URL` to it on that service — the issuer's `credential_issuer`
and the verifier's `client_id` are built from it and must equal what wallets see.

The admin password was generated for you: **mosipid-admin → Environment → `ADMIN_PASSWORD`** (user `admin`).

## 4. Smoke test
1. `https://<admin>/` → sign in → rename “VoltEdge Electricity”, change colours, upload a logo → Save.
2. `https://<verifier>/electricity.html` → the header shows your new name/logo/theme (allow ~1 minute for caches).
3. `https://<issuer>/.well-known/openid-credential-issuer` returns metadata; `https://<verifier>/api/trust` lists two anchors (`iaca`, `edu`).
4. `https://<issuer>/university.html` → `BIT2020CS001` / `2002-03-14` → QR + PIN.

## 5. Point the mobile apps at your servers
Either edit `extra` in `apps/*/app.json`, or build with `EXPO_PUBLIC_ADMIN_URL`, `EXPO_PUBLIC_ISSUER_URL`, `EXPO_PUBLIC_VERIFIER_URL`, or change them at runtime in the app's **Settings → Servers**. See [MOBILE.md](MOBILE.md).

## Production hardening checklist
* **Database plan**: Render's *Free* Postgres is deleted after 30 days → the mock CAs would be regenerated and old credentials would stop verifying. Use a paid plan, **or** run `npm run gen:iaca` once and store the printed `IACA_*` / `EDU_*` lines as env vars on the **issuer** (they override the DB).
* **Face matching**: set `FACE_PROVIDER=http` and `FACE_API_URL` (+`FACE_API_KEY`); until then credentials are marked `assurance_level=demo`.
* **Passports**: set `PASSIVE_AUTH=strict` and `CSCA_PEM` (concatenated PEM certificates) to enforce the chain of trust.
* **CORS**: `CORS_ORIGINS=https://a.example,https://b.example` on the admin service to restrict who may read branding from a browser (default `*`, the data is public).
* **Students**: the demo registry is built in; supply your own with `STUDENTS_JSON` (array of `{studentId, givenName, familyName, dob, degree, field, graduationYear, cgpa, classOfDegree}`).
* **Scaling**: the proximity relay and rate limiters are in-memory → run **one instance** of `mosipid-verifier` (or move the relay to Redis).

## Plans, cold starts and cost
* Free web services **sleep after ~15 min idle** and take ~30–60 s to wake. The first QR of the day may be slow; the web pages fall back to built-in branding defaults if the admin portal is still waking.
* Issuer on **Free** works if you set `OCR_PROVIDER=mock` (or accept OOM risk on the ~512 MB limit when OCR runs). Starter is recommended.
* One Postgres instance is shared by the three services (they use disjoint key namespaces in a single `kv` table).

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| Build fails with `esbuild: not found` | Build command must keep `npm ci --include=dev` (Render sets `NODE_ENV=production`, which otherwise skips devDependencies). |
| Verifier shows “no trust anchors available” | `ISSUER_URL` missing/wrong, or issuer asleep. Open `<verifier>/api/trust`; it retries on demand. |
| Wallet says “issuer metadata unavailable” | The wallet's Settings → Issuer URL is wrong, or the service is cold-starting; retry. |
| Credentials suddenly fail verification | The issuer's CA changed (DB reset). Pin the CAs via `IACA_*`/`EDU_*` env vars and re-issue. |
| OCR always “mrz_not_found” | Poor photo (glare/blur), or the issuer OOM-restarted; check logs, use Starter plan. |
