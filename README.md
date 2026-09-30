# MOSIP-ID — wallet, issuer, verifiers and central branding portal

An end-to-end, **Inji-style** digital-credential stack you can run locally and deploy on [Render](https://render.com):

| Piece | What it is | Where |
|---|---|---|
| **Wallet app** (Android/iOS, Expo) | Holds credentials, receives them over **OpenID4VCI**, presents over **OpenID4VP**, shows an ISO 18013-5 QR for in-person sharing. EN / FR / ES. | `apps/wallet` |
| **Proximity Verifier app** (Android/iOS, Expo) | Scans the wallet's QR, sends a DeviceRequest, verifies the DeviceResponse **on-device** against cached trust anchors. EN / FR / ES. | `apps/proximity-verifier` |
| **Issuer** (web + API) | OID4VCI issuer. Issues an **identity mdoc** after **NFC chip read (MRZ/BAC)** *or* **document OCR + live selfie face-match**, and a **university degree SD-JWT VC** through **pre-authorised code (+PIN)** *or* **authorization-code + PKCE** with University-ID login. Signs with a **mock "IN Groupe" IACA**. | `services/issuer` |
| **Remote Verifier** (web + API) | Two relying-party demos: **electricity company** (login with the ID credential) and **university** (login with the degree attestation). OID4VP + DCQL/PEx, cross-device QR. Also hosts the proximity relay. | `services/verifier` |
| **Admin / Asset portal** (web + API) | One place to change **logo, colours, theme and organisation/university names** (per language) for every app. | `services/admin` |
| Shared libraries | `packages/core` (CBOR, mdoc, SD-JWT VC, X.509/PKI, ICAO 9303 BAC, MRZ, ISO session crypto, OID4VCI/VP clients, i18n), `packages/server-kit`, `packages/web-shared`, `packages/mobile-kit` | `packages/*` |

```
                     ┌───────────────────────── Admin / Asset portal ─────────────────────────┐
                     │  logo · colours · theme · names (en/fr/es)  →  GET /api/branding/:tenant │
                     └───────────▲──────────────▲──────────────────────▲──────────────▲───────┘
                                 │              │                      │              │
   ┌───────────────┐  OID4VCI    │      ┌───────┴────────┐  OID4VP     │      ┌───────┴────────┐
   │    Issuer     │◄───────────►│      │     Wallet     │◄───────────►│      │ Remote Verifier │
   │ mock IACA +   │  offer/token/      │  (Expo app)    │ direct_post │      │ electricity /   │
   │ edu CA, proofing  credential       └───────┬────────┘             │      │ university      │
   └───────┬───────┘                            │ ISO 18013-5 QR       │      └───────┬────────┘
           │ trust anchors (GET /api/trust)     ▼ (encrypted, relayed) │              │
           └────────────────────────────►┌──────────────────┐◄────────┘◄─────────────┘
                                         │ Proximity Verifier│  (verifies offline with cached anchors)
                                         └──────────────────┘
```

> **Honest status – read this.** Backends, protocols and web UIs are exercised by 32 automated tests (+2 opt-in: Postgres, real OCR) (including a full
> issue→present→verify run against real Postgres) and a browser smoke test. The two mobile apps **typecheck and bundle with
> Metro/Hermes but have not been run on a phone** in this environment, so camera, NFC and biometric flows are untested on hardware.
> See [What is real and what is mocked](docs/ARCHITECTURE.md#what-is-real-and-what-is-mocked) before relying on anything.

## Quick start (local)

```bash
npm install                                  # backends + shared packages
cp .env.example .env                         # optional
npm run dev:admin      # http://localhost:3001   (admin / admin)
npm run dev:issuer     # http://localhost:3002
npm run dev:verifier   # http://localhost:3003
```
Set `ADMIN_URL=http://localhost:3001 ISSUER_URL=http://localhost:3002 VERIFIER_URL=http://localhost:3003` for the issuer/verifier so they find each other
(the verifier fetches trust anchors from the issuer; browsers fetch branding from the admin portal).

1. Open **http://localhost:3002/university.html**, sign in as `BIT2020CS001` / `2002-03-14`, and note the QR + PIN.
2. Open **http://localhost:3003/university.html** → *Sign in with wallet* to see the request QR.
3. Build the wallet ([docs/MOBILE.md](docs/MOBILE.md)), scan the issuer QR, enter the PIN, then scan the verifier QR.

Tests: `npm test` · type-check: `npm run typecheck` · production build: `npm run build`.
With Postgres: `TEST_DATABASE_URL=postgres://… npm test`. Real OCR: `RUN_OCR=1 npm test -w @mosipid/issuer`.

## Deploy on Render
Step-by-step in **[docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md)** (Blueprint: 3 web services + Postgres; asks for a card). **No card?** Use **[docs/DEPLOY_RENDER_FREE.md](docs/DEPLOY_RENDER_FREE.md)**: 3 Free web services + a free Neon Postgres.

## Documents
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – flows, credential formats, trust model, security notes, real-vs-mocked table
- [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md) – deployment guide (Blueprint)
- [docs/DEPLOY_RENDER_FREE.md](docs/DEPLOY_RENDER_FREE.md) – deploy with no card (free web services + Neon)
- [docs/MOBILE.md](docs/MOBILE.md) – building/running the two apps, NFC notes, pointing apps at your servers

## Relationship to MOSIP Inji
The wallet here is a **new Expo/React-Native app that speaks the same standards Inji uses** (OpenID4VCI, OpenID4VP, mdoc, SD-JWT VC) — it is *not* a fork of
`mosip/inji-wallet`. The issuer publishes standard OID4VCI metadata (draft-13 and 1.0 request/response shapes are both accepted), so the pre-authorised
degree flow should be receivable by other OID4VCI wallets, but interop with the stock Inji app has **not been tested**. Presentation requests are unsigned
(`redirect_uri` client-id scheme); wallets that insist on signed request objects will need an `x509_san_dns` verifier certificate (see ARCHITECTURE → Roadmap).
