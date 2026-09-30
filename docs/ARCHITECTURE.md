# Architecture

## Services and data
| Service | State (Postgres `kv` table, or memory if `DATABASE_URL` is unset) |
|---|---|
| admin | `branding/<tenant>`, `logo/<tenant>` (≤300 KB data-URL) |
| issuer | `pki/{iaca,edu}` (mock CA + Document Signer keys), `offer`, `preauth`, `authreq`, `authcode`, `access`, `nonce`, `enroll` (all short-TTL, single-use where relevant) |
| verifier | `vtx` (presentation transactions), `login` (web sessions). The proximity relay is **in-memory** (single instance). |

## Credentials
| | Identity | University degree |
|---|---|---|
| Format | ISO 18013-5 **mdoc** (`mso_mdoc`), CBOR/COSE_Sign1 (ES256) | **SD-JWT VC** (`dc+sd-jwt`), every claim selectively disclosable, KB-JWT holder binding |
| Type | docType `io.mosipid.identity.1` (custom – *not* a claim of being an ISO mDL) | `vct` `https://mosipid.example/vct/university-degree` |
| Signed by | Document Signer under **“IN Groupe Mock IACA”** (ISO 18013-5 Annex B-style profile: `cA` root, `keyCertSign/cRLSign`; DS with `digitalSignature` + EKU `1.0.18013.5.1.2`) | Document Signer under **“Mock India Education Trust CA”** (a separate mock root) |
| Claims | family/given name, birth date, sex, nationality, document number (issuer-generated), issue/expiry, issuing country/authority, `age_over_18/21`, portrait, `verification_method`, `assurance_level` | student ID, name, degree, field, university (**taken from the Admin portal name**), graduation year, CGPA, class |
| Validity | 180 days (`ID_VALIDITY_DAYS`) – short-lived by design | 10 years (`DEGREE_VALIDITY_DAYS`) |

The issuer generates both CAs on first start and persists them (or reads `IACA_*` / `EDU_*` env vars – `npm run gen:iaca` prints them). Verifiers and the proximity app
fetch anchors from `GET /api/trust`; the Document Signer rotates automatically when <30 days remain, the CA stays. Everything is produced by `packages/core/src/pki.ts`
and validated with OpenSSL (`openssl verify` passes).

## Issuance flows (OID4VCI)
* **Pre-authorised code** – used for identity (gated by identity proofing) and for the degree (gated by a 4-digit **`tx_code` PIN**, 5 attempts).
* **Authorization code + PKCE (S256)** – degree only. `GET /authorize` validates `redirect_uri` against `ALLOWED_REDIRECTS`, then the student logs in with **University ID + date of birth**.
  The wallet opens it with `expo-web-browser` (`mosipidwallet://oauth/callback`).
* `/nonce` endpoint **and** `c_nonce` in the token response are both supported; proof JWTs (`openid4vci-proof+jwt`, jwk in header) are verified, nonces are single-use.
  Credential requests accept `credential_configuration_id` (1.0) or `format`+`doctype/vct` (draft 13); responses carry both `credentials[]` and `credential`.

### Identity proofing (`services/issuer/src/proofing`)
1. Portal (`/id.html`) or wallet calls `POST /api/enroll {method}` → session + offer whose pre-authorised code is **held back** (`authorization_pending`) until proofing succeeds.
2. **NFC path** – wallet reads DG1/DG2/EF.SOD via BAC (keys from document number + birth date + expiry, from the MRZ, typed or camera-scanned), then a live selfie. Issuer: parses DG1 (MRZ + check digits), **checks DG1/DG2 hashes against the SOD**, **verifies the SOD signature** (RSA-PKCS1/PSS, ECDSA via Node crypto) and – if `CSCA_PEM` is set – the **DS→CSCA chain**; then face-compares the DG2 portrait with the selfie.
3. **Optical path** – *auto-capture*: the wallet samples camera frames and calls `/probe` (server-side Tesseract OCR of the MRZ, with OCR-error repair and check-digit validation) until a valid MRZ is seen; then selfie (3 frames: straight/left/right for liveness providers); issuer OCRs, checks expiry, face-compares document vs selfie.
4. Portrait in the credential = resized DG2 JPEG (NFC) or the verified selfie. Identity data is deleted from the session once the credential is issued.

## Presentation flows
* **Remote (OID4VP, cross-device)** – verifier creates a transaction (`nonce`, `state`, poll token) and shows `openid4vp://authorize?client_id=redirect_uri:…&request_uri=…`.
  The request object carries **DCQL and Presentation Exchange** definitions; `client_id_scheme` is `redirect_uri` (unsigned). Wallet answers with `direct_post`.
  mdoc: `DeviceResponse` with **OpenID4VPHandover** session transcript + device signature; SD-JWT: KB-JWT with `aud`=client_id, `nonce`, `sd_hash`.
  The verifier checks chain→anchor, signature, digests, validity, holder binding, requested claims present, then mints a login session for the polling browser (poll token stops QR-snooping).
* **Proximity (ISO 18013-5)** – wallet shows `mdoc:<DeviceEngagement>`; the reader app scans it, derives session keys (ECDH P-256 → HKDF → AES-256-GCM, exactly as in 18013-5 §9.1.1.5),
  sends an encrypted `DeviceRequest`, the wallet asks the user, answers with an encrypted `DeviceResponse`; the reader verifies **locally**. The bytes move over a **relay mailbox** (`/api/relay`) on the verifier backend, which only ever sees ciphertext. The transport is an interface (`Transport`) so BLE can slot in.

## Branding & i18n
`GET {admin}/api/branding/:tenant` returns names (en/fr/es), colours, theme, logo URL. Tenants: `wallet`, `issuer-id`, `issuer-university`, `verifier-electricity`, `verifier-university`, `verifier-proximity` (+ any you add).
Web pages and both apps fetch it at start (cached, with built-in defaults if the admin service is asleep). Languages: `packages/core/src/locales/{en,fr,es}.json` – one file drives web and mobile;
a test enforces identical keys, preserved placeholders and that every key referenced in the UI code exists.

## Security notes
* Admin: HMAC-signed HttpOnly cookie, timing-safe credential check, JSON-only writes (blocks cross-site form posts), rate-limited login, logo MIME allow-list + `Content-Security-Policy: default-src 'none'` on served images (neutralises SVG scripts).
* Single-use codes/nonces use an atomic `take` (Postgres `DELETE … RETURNING`) – a concurrency test guards this.
* Wallet: credentials + holder keys are AES-GCM encrypted at rest with a Keychain/Keystore-held key; sharing requires biometric/PIN; optional app lock. **Per-credential holder keys** (no correlation handle).
* **Mock PKI**: CA private keys sit unencrypted in the DB/env. Never use for real identity. Production needs HSM/KMS-held keys, CRLs/OCSP, a real IACA trust list (e.g. AAMVA VICAL/EU LOTL), audit logging.

## What is real and what is mocked
| Area | Status |
|---|---|
| mdoc issuance/verification, SD-JWT VC, X.509 chain checks, ISO session encryption, OID4VCI (both grants), OID4VP (DCQL+PEx) | **Real & tested** (unit + e2e, incl. Postgres) |
| ICAO 9303 BAC + secure messaging | **Implemented, verified against the spec's worked example** (key derivation, mutual auth, MAC). Never run against a physical chip. |
| Passive authentication (SOD hash + signature + CSCA chain) | **Real & tested with EC signatures**; RSA/PSS paths use Node crypto but are untested against real passports. Chain-of-trust needs your CSCA certs (`PASSIVE_AUTH=strict`). |
| MRZ OCR (Tesseract) | **Real**, tested on a rendered MRZ; accuracy on real camera photos is unmeasured. |
| **Face match & liveness** | **MOCK by default** (`FACE_PROVIDER=mock` accepts any image and marks the credential `assurance_level=demo`). Plug in a real service via `FACE_PROVIDER=http` (contract in `proofing/face.ts`). |
| **CAN / PACE** for NFC | **Not implemented** – only BAC (MRZ) works. The CAN tab in the wallet says so. PACE-CAN (ECDH-GM, AES-CMAC secure messaging) is the main missing piece for ID cards that lack BAC. |
| **BLE transport** for proximity | **Not implemented** – the relay (needs internet) is used. Interface is in place. |
| DG2 in JPEG2000 | Face image extracted, but conversion needs a JP2-capable `sharp`; otherwise the selfie becomes the credential portrait and JP2 is passed to the face provider. |
| Signed request objects / encrypted responses (`direct_post.jwt`), DPoP, PAR, status lists/revocation | Not implemented (roadmap). |
| Mobile apps on devices | Typecheck + Metro/Hermes bundle OK; **not exercised on a phone**. |
| Stock Inji app interoperability | Not tested. |
