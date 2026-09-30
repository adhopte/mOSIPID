# Building the mobile apps

Both apps are **Expo (React Native, TypeScript)**. They use native modules (NFC, camera, secure storage, biometrics), so **Expo Go cannot run them** — use a *development build*.

```bash
npm install                       # at the repo root (shared packages)
cd apps/wallet                    # or apps/proximity-verifier
npm install --legacy-peer-deps
npm run typecheck                 # tsc against the shared packages
```

## Point at your servers
`apps/*/app.json → expo.extra` holds `adminUrl`, `issuerUrl`, `verifierUrl` (defaults are the Render names from the Blueprint).
Override at build time with `EXPO_PUBLIC_ADMIN_URL` / `EXPO_PUBLIC_ISSUER_URL` / `EXPO_PUBLIC_VERIFIER_URL`, or at runtime in **Settings → Servers**.
For a local backend from the Android emulator use `http://10.0.2.2:3001|3002|3003` (the built-in fallback); for a phone use your LAN IP or an HTTPS tunnel.

## Run on a device
```bash
# Android (NFC-capable phone, USB debugging on)
npx expo run:android
# iOS (needs a Mac, an Apple developer account and the NFC Tag Reading capability)
npx expo run:ios
```
Cloud builds with EAS (profiles are in `eas.json`):
```bash
npm i -g eas-cli && eas login
eas build --profile development --platform android     # installable dev-client APK
eas build --profile preview --platform android         # standalone APK for testers
```
Then `npx expo start --dev-client` and open the installed app.

## Wallet – what to try
1. **Get university degree** – opens the issuer's sign-in page in the system browser (authorization-code + PKCE). Log in with `BIT2020CS001` / `2002-03-14`.
   Or on the issuer website choose flow **A**, scan the QR and enter the PIN.
2. **Get digital ID – scan document + selfie** – the camera auto-captures once the MRZ passes its check digits, then three selfie frames.
3. **Get digital ID – read chip (NFC)** – type (or camera-scan) document number, birth date and expiry, then hold the passport/ID to the phone's NFC antenna.
   *Only BAC is implemented; documents that require PACE with the CAN are not readable yet.*
4. **Scan** a verifier QR (electricity/university), review the claims, approve with biometrics.
5. **Share in person** – shows an `mdoc:` QR; scan it with the **Proximity Verifier** app.
6. **Settings** – language (EN/FR/ES), app lock, servers.

Deep links registered: `openid-credential-offer://`, `openid4vp://`, `haip://`, `mosipidwallet://`.

## NFC notes
* Android: `NFC` permission is in the manifest; the app checks that NFC is present and enabled and opens system settings otherwise.
* iOS: the config plugin adds the ISO7816 `select-identifiers` (`A0000002471001`, the eMRTD LDS application) and the NFC usage string; your provisioning profile must include the *NFC Tag Reading* capability.
* Reading DG2 (the photo) can take 10–30 s; keep the document still. Progress is shown in the UI.

## Proximity Verifier – what to try
Choose a check (age over 18 / name+portrait / full details) → scan the wallet's QR → the result shows *valid/invalid*, the trusted issuer and the disclosed fields.
Trust anchors are synced from the verifier backend and **cached**, so verification itself does not need connectivity (the relay transport still does — see ARCHITECTURE).
