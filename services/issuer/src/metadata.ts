import { CONFIG_ID_MDOC, CONFIG_UNI_SDJWT, DOCTYPE_ID, NS_ID, VCT_DEGREE, ID_ELEMENTS, DEGREE_CLAIMS } from '@mosipid/core';
import { IssuerConfig } from './config';

export const SCOPES = { [CONFIG_ID_MDOC]: 'mosipid_identity', [CONFIG_UNI_SDJWT]: 'university_degree' } as const;

export function issuerMetadata(cfg: IssuerConfig) {
  const base = cfg.publicUrl;
  return {
    credential_issuer: base,
    credential_endpoint: `${base}/credential`,
    nonce_endpoint: `${base}/nonce`,
    authorization_servers: [base],
    display: [
      { name: 'IN Groupe (Mock) Issuer Portal', locale: 'en' },
      { name: 'Portail émetteur IN Groupe (fictif)', locale: 'fr' },
      { name: 'Portal emisor IN Groupe (simulado)', locale: 'es' },
    ],
    x_branding_url: cfg.adminUrl ? `${cfg.adminUrl}/api/branding` : undefined,
    credential_configurations_supported: {
      [CONFIG_ID_MDOC]: {
        format: 'mso_mdoc',
        doctype: DOCTYPE_ID,
        scope: SCOPES[CONFIG_ID_MDOC],
        cryptographic_binding_methods_supported: ['cose_key', 'jwk'],
        credential_signing_alg_values_supported: ['ES256'],
        proof_types_supported: { jwt: { proof_signing_alg_values_supported: ['ES256'] } },
        x_branding_tenant: 'issuer-id',
        display: [
          { name: 'Digital Identity (mdoc)', locale: 'en', background_color: '#0E7490', text_color: '#FFFFFF' },
          { name: "Identité numérique (mdoc)", locale: 'fr', background_color: '#0E7490', text_color: '#FFFFFF' },
          { name: 'Identidad digital (mdoc)', locale: 'es', background_color: '#0E7490', text_color: '#FFFFFF' },
        ],
        claims: { [NS_ID]: Object.fromEntries(ID_ELEMENTS.map((e) => [e, {}])) },
      },
      [CONFIG_UNI_SDJWT]: {
        format: 'dc+sd-jwt',
        vct: VCT_DEGREE,
        scope: SCOPES[CONFIG_UNI_SDJWT],
        cryptographic_binding_methods_supported: ['jwk'],
        credential_signing_alg_values_supported: ['ES256'],
        proof_types_supported: { jwt: { proof_signing_alg_values_supported: ['ES256'] } },
        x_branding_tenant: 'issuer-university',
        display: [
          { name: 'University Degree', locale: 'en', background_color: '#7C2D12', text_color: '#FFFFFF' },
          { name: 'Diplôme universitaire', locale: 'fr', background_color: '#7C2D12', text_color: '#FFFFFF' },
          { name: 'Título universitario', locale: 'es', background_color: '#7C2D12', text_color: '#FFFFFF' },
        ],
        claims: Object.fromEntries(DEGREE_CLAIMS.map((c) => [c, {}])),
      },
    },
  };
}

export function authServerMetadata(cfg: IssuerConfig) {
  const base = cfg.publicUrl;
  return {
    issuer: base,
    token_endpoint: `${base}/token`,
    authorization_endpoint: `${base}/authorize`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'urn:ietf:params:oauth:grant-type:pre-authorized_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    'pre-authorized_grant_anonymous_access_supported': true,
    scopes_supported: Object.values(SCOPES),
  };
}
