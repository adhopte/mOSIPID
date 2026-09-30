// OpenID for Verifiable Credential Issuance (wallet side). Supports pre-authorized code and
// authorization code (PKCE) flows, and both draft-13 (Inji-era) and 1.0 request/response shapes.
import { sha256 } from '@noble/hashes/sha2';
import { b64u, randomId, toHex, utf8 } from '../bytes';
import { generateKeyPair, KeyPair, signJwt } from '../keys';
import { FetchLike, defaultFetch, ProtocolError, parseQuery, formBody, StoredCredential, FORMAT_MDOC, FORMAT_SDJWT } from './common';
import { listSdJwtClaims } from '../sdjwt';
import { mdocDocType } from '../mdoc';

export interface CredentialOffer {
  credential_issuer: string;
  credential_configuration_ids: string[];
  grants?: {
    'urn:ietf:params:oauth:grant-type:pre-authorized_code'?: { 'pre-authorized_code': string; tx_code?: { input_mode?: string; length?: number; description?: string } };
    authorization_code?: { issuer_state?: string; authorization_server?: string };
  };
  /** project extension: identity proofing required before the issuer will release the credential */
  x_proofing?: { session_id: string; method: 'nfc' | 'ocr'; api: string };
}

export async function resolveOffer(uri: string, f: FetchLike = defaultFetch): Promise<CredentialOffer> {
  const q = parseQuery(uri);
  if (q.credential_offer) return JSON.parse(q.credential_offer);
  if (q.credential_offer_uri) {
    const r = await f(q.credential_offer_uri);
    if (!r.ok) throw new ProtocolError('could not fetch credential offer', 'offer_fetch_failed', r.status);
    return r.json();
  }
  throw new ProtocolError('not a credential offer', 'invalid_offer');
}

export interface IssuerMetadata {
  credential_issuer: string;
  credential_endpoint: string;
  nonce_endpoint?: string;
  authorization_servers?: string[];
  display?: { name?: string; logo?: { uri: string } }[];
  x_branding_url?: string;
  x_branding_tenant?: string;
  credential_configurations_supported: Record<string, {
    format: string; scope?: string; doctype?: string; vct?: string; x_branding_tenant?: string;
    display?: { name: string; locale?: string; background_color?: string; text_color?: string }[];
    cryptographic_binding_methods_supported?: string[];
  }>;
}

export async function fetchIssuerMetadata(issuer: string, f: FetchLike = defaultFetch): Promise<IssuerMetadata> {
  const r = await f(issuer.replace(/\/$/, '') + '/.well-known/openid-credential-issuer');
  if (!r.ok) throw new ProtocolError('issuer metadata unavailable', 'metadata_failed', r.status);
  return r.json();
}
export async function fetchAuthServerMetadata(as: string, f: FetchLike = defaultFetch) {
  const r = await f(as.replace(/\/$/, '') + '/.well-known/oauth-authorization-server');
  if (!r.ok) throw new ProtocolError('authorization server metadata unavailable', 'metadata_failed', r.status);
  return r.json() as Promise<{ issuer: string; token_endpoint: string; authorization_endpoint?: string }>;
}

export interface TokenResponse { access_token: string; c_nonce?: string; c_nonce_expires_in?: number; token_type?: string }

export async function tokenPreAuthorized(tokenEndpoint: string, code: string, txCode?: string, f: FetchLike = defaultFetch): Promise<TokenResponse> {
  return tokenRequest(tokenEndpoint, { grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code', 'pre-authorized_code': code, tx_code: txCode }, f);
}

async function tokenRequest(endpoint: string, body: Record<string, string | undefined>, f: FetchLike): Promise<TokenResponse> {
  const r = await f(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: formBody(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ProtocolError(j.error_description || j.error || 'token request failed', j.error || 'token_failed', r.status, j);
  return j;
}

/** Poll the token endpoint while the issuer reports identity proofing is still pending. */
export async function tokenPreAuthorizedWaiting(tokenEndpoint: string, code: string, opts: { txCode?: string; timeoutMs?: number; intervalMs?: number; f?: FetchLike } = {}) {
  const end = Date.now() + (opts.timeoutMs ?? 120_000);
  for (;;) {
    try { return await tokenPreAuthorized(tokenEndpoint, code, opts.txCode, opts.f); }
    catch (e: any) {
      if (e?.code !== 'authorization_pending' || Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1500));
    }
  }
}

// ---- authorization code + PKCE
export function createPkce() {
  const verifier = randomId(32);
  return { verifier, challenge: b64u.encode(sha256(utf8(verifier))), method: 'S256' as const };
}
export function buildAuthorizationUrl(o: { endpoint: string; clientId: string; redirectUri: string; scope?: string; state: string; challenge: string; issuerState?: string; issuer: string; language?: string }) {
  const q = formBody({
    response_type: 'code', client_id: o.clientId, redirect_uri: o.redirectUri, scope: o.scope, state: o.state,
    code_challenge: o.challenge, code_challenge_method: 'S256', issuer_state: o.issuerState, resource: o.issuer, ui_locales: o.language,
  });
  return `${o.endpoint}${o.endpoint.includes('?') ? '&' : '?'}${q}`;
}
export function tokenAuthorizationCode(tokenEndpoint: string, o: { code: string; verifier: string; redirectUri: string; clientId: string }, f: FetchLike = defaultFetch) {
  return tokenRequest(tokenEndpoint, { grant_type: 'authorization_code', code: o.code, code_verifier: o.verifier, redirect_uri: o.redirectUri, client_id: o.clientId }, f);
}

// ---- credential request
export async function fetchNonce(meta: IssuerMetadata, f: FetchLike = defaultFetch): Promise<string | undefined> {
  if (!meta.nonce_endpoint) return undefined;
  const r = await f(meta.nonce_endpoint, { method: 'POST' });
  if (!r.ok) return undefined;
  return (await r.json()).c_nonce;
}

export function buildProofJwt(key: KeyPair, audience: string, nonce: string | undefined, clientId?: string): string {
  return signJwt({ typ: 'openid4vci-proof+jwt', jwk: key.publicJwk }, { iss: clientId, aud: audience, iat: Math.floor(Date.now() / 1000), nonce }, key.privateKey);
}

export interface IssuedCredential { format: string; credential: string }

export async function requestCredential(o: {
  meta: IssuerMetadata; configId: string; accessToken: string; cNonce?: string; key: KeyPair; clientId?: string; f?: FetchLike;
}): Promise<IssuedCredential> {
  const f = o.f ?? defaultFetch;
  const cfg = o.meta.credential_configurations_supported[o.configId];
  if (!cfg) throw new ProtocolError('issuer does not support ' + o.configId, 'unsupported_configuration');
  let nonce = o.cNonce ?? (await fetchNonce(o.meta, f));
  for (let attempt = 0; attempt < 2; attempt++) {
    const jwt = buildProofJwt(o.key, o.meta.credential_issuer, nonce, o.clientId);
    const body: any = {
      credential_configuration_id: o.configId,
      // draft-13 style fields for older issuers/gateways
      format: cfg.format, doctype: cfg.doctype, vct: cfg.vct,
      proof: { proof_type: 'jwt', jwt },
      proofs: { jwt: [jwt] },
    };
    const r = await f(o.meta.credential_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.accessToken}` }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const c = j.credentials?.[0]?.credential ?? j.credential;
      if (!c) throw new ProtocolError('issuer returned no credential', 'no_credential', r.status, j);
      return { format: cfg.format, credential: typeof c === 'string' ? c : JSON.stringify(c) };
    }
    if (j.error === 'invalid_nonce' && j.c_nonce && attempt === 0) { nonce = j.c_nonce; continue; }
    if (j.error === 'invalid_proof' && j.c_nonce && attempt === 0) { nonce = j.c_nonce; continue; }
    throw new ProtocolError(j.error_description || j.error || 'credential request failed', j.error || 'credential_failed', r.status, j);
  }
  throw new ProtocolError('credential request failed', 'credential_failed');
}

export function toStoredCredential(o: { issued: IssuedCredential; configId: string; meta: IssuerMetadata; key: KeyPair; locale?: string }): StoredCredential {
  const cfg = o.meta.credential_configurations_supported[o.configId];
  const disp = cfg.display?.find((d) => d.locale?.startsWith(o.locale ?? 'en')) ?? cfg.display?.[0];
  const mdoc = o.issued.format === FORMAT_MDOC;
  let expiresAt: string | undefined;
  try {
    if (!mdoc) { const { visible } = listSdJwtClaims(o.issued.credential); if (typeof visible.exp === 'number') expiresAt = new Date(visible.exp * 1000).toISOString(); }
  } catch { /* ignore */ }
  return {
    id: randomId(9), format: mdoc ? FORMAT_MDOC : FORMAT_SDJWT, configId: o.configId,
    docType: mdoc ? mdocDocType(b64u.decode(o.issued.credential)) : undefined, vct: cfg.vct,
    raw: o.issued.credential, devicePrivateKeyHex: toHex(o.key.privateKey), devicePublicJwk: o.key.publicJwk,
    issuer: o.meta.credential_issuer, issuerName: o.meta.display?.[0]?.name, brandingTenant: cfg.x_branding_tenant ?? o.meta.x_branding_tenant,
    title: disp?.name ?? o.configId, addedAt: new Date().toISOString(), expiresAt,
  };
}

/** High level: run the pre-authorized flow end to end. */
export async function receivePreAuthorized(o: { offer: CredentialOffer; txCode?: string; f?: FetchLike; clientId?: string; timeoutMs?: number }): Promise<StoredCredential[]> {
  const f = o.f ?? defaultFetch;
  const grant = o.offer.grants?.['urn:ietf:params:oauth:grant-type:pre-authorized_code'];
  if (!grant) throw new ProtocolError('offer has no pre-authorized grant', 'unsupported_grant');
  const meta = await fetchIssuerMetadata(o.offer.credential_issuer, f);
  const asUrl = meta.authorization_servers?.[0] ?? meta.credential_issuer;
  const as = await fetchAuthServerMetadata(asUrl, f);
  const tok = await tokenPreAuthorizedWaiting(as.token_endpoint, grant['pre-authorized_code'], { txCode: o.txCode, f, timeoutMs: o.timeoutMs });
  const out: StoredCredential[] = [];
  for (const configId of o.offer.credential_configuration_ids) {
    const key = generateKeyPair();
    const issued = await requestCredential({ meta, configId, accessToken: tok.access_token, cNonce: tok.c_nonce, key, clientId: o.clientId, f });
    out.push(toStoredCredential({ issued, configId, meta, key }));
  }
  return out;
}
