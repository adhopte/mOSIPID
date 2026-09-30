// OpenID for Verifiable Presentations (wallet side): request parsing (PEx + DCQL), credential
// matching, and vp_token construction for mdoc (DeviceResponse) and SD-JWT VC (with KB-JWT).
import { b64u } from '../bytes';
import { buildDeviceResponse, openid4vpTranscript, listIssuerSignedClaims } from '../mdoc';
import { presentSdJwt, listSdJwtClaims } from '../sdjwt';
import { FetchLike, defaultFetch, ProtocolError, parseQuery, formBody, StoredCredential, FORMAT_MDOC, FORMAT_SDJWT, asKeyPair } from './common';

export interface NormalizedItem {
  id: string;
  format: 'mso_mdoc' | 'dc+sd-jwt';
  docType?: string;
  vct?: string;
  claims: { namespace?: string; name: string }[];
}
export interface AuthRequest {
  clientId: string;
  responseUri: string;
  responseMode: string;
  nonce: string;
  state?: string;
  items: NormalizedItem[];
  dcql: boolean;
  definitionId?: string;
  verifierName?: string;
  purpose?: string;
  raw: any;
}

export async function resolveAuthorizationRequest(uri: string, f: FetchLike = defaultFetch): Promise<AuthRequest> {
  let q: any = parseQuery(uri);
  if (q.request_uri) {
    const r = await f(q.request_uri);
    if (!r.ok) throw new ProtocolError('could not fetch request object', 'request_fetch_failed', r.status);
    const text = await r.text();
    q = text.trim().startsWith('{') ? JSON.parse(text) : decodeRequestJwt(text);
  } else if (q.request) q = decodeRequestJwt(q.request);
  for (const k of ['presentation_definition', 'dcql_query', 'client_metadata']) if (typeof q[k] === 'string') { try { q[k] = JSON.parse(q[k]); } catch { /* keep */ } }
  return normalizeRequest(q);
}

function decodeRequestJwt(jwt: string) {
  const p = jwt.split('.')[1];
  return JSON.parse(new TextDecoder().decode(b64u.decode(p)));
}

export function normalizeRequest(q: any): AuthRequest {
  if (q.response_type && q.response_type !== 'vp_token') throw new ProtocolError('unsupported response_type', 'unsupported_response_type');
  if (!q.client_id || !q.nonce) throw new ProtocolError('request missing client_id or nonce', 'invalid_request');
  const mode = q.response_mode ?? 'direct_post';
  if (mode !== 'direct_post') throw new ProtocolError('only response_mode=direct_post is supported', 'unsupported_response_mode');
  const responseUri = q.response_uri ?? q.redirect_uri;
  if (!responseUri) throw new ProtocolError('missing response_uri', 'invalid_request');
  const items: NormalizedItem[] = [];
  if (q.dcql_query) {
    for (const c of q.dcql_query.credentials ?? []) {
      const format = c.format === 'mso_mdoc' ? 'mso_mdoc' : 'dc+sd-jwt';
      items.push({
        id: c.id, format, docType: c.meta?.doctype_value, vct: c.meta?.vct_values?.[0],
        claims: (c.claims ?? []).map((cl: any) => (format === 'mso_mdoc' ? { namespace: cl.path[0], name: cl.path[1] } : { name: cl.path[0] })),
      });
    }
  } else if (q.presentation_definition) {
    for (const d of q.presentation_definition.input_descriptors ?? []) {
      const fmt = d.format ? Object.keys(d.format)[0] : 'mso_mdoc';
      const format = fmt === 'mso_mdoc' ? 'mso_mdoc' : 'dc+sd-jwt';
      const claims = (d.constraints?.fields ?? []).map((fld: any) => {
        const path: string = fld.path?.[0] ?? '';
        const m = path.match(/\['([^']+)'\]/g)?.map((s) => s.slice(2, -2)) ?? [path.replace(/^\$\.?/, '')];
        return format === 'mso_mdoc' ? { namespace: m[0], name: m[1] } : { name: m[m.length - 1] };
      });
      items.push({ id: d.id, format, docType: format === 'mso_mdoc' ? d.id : undefined, vct: d.vct, claims });
    }
  } else throw new ProtocolError('request has neither dcql_query nor presentation_definition', 'invalid_request');
  return {
    clientId: q.client_id, responseUri, responseMode: mode, nonce: q.nonce, state: q.state, items, dcql: !!q.dcql_query,
    definitionId: q.presentation_definition?.id, verifierName: q.client_metadata?.client_name, purpose: q.purpose ?? q.presentation_definition?.purpose, raw: q,
  };
}

export interface Match { item: NormalizedItem; credential: StoredCredential; available: boolean }

export function matchCredentials(req: AuthRequest, creds: StoredCredential[]): Match[] {
  return req.items.map((item) => {
    const c = creds.find((c) =>
      item.format === c.format &&
      (item.format === FORMAT_MDOC ? (item.docType ? c.docType === item.docType : true) : item.vct ? c.vct === item.vct : true) &&
      (!c.expiresAt || new Date(c.expiresAt) > new Date()));
    return { item, credential: c as StoredCredential, available: !!c };
  });
}

/** Human-readable list of what will be shared (only claims that exist in the credential). */
export function claimsToShare(m: Match): { name: string; value: unknown; namespace?: string }[] {
  const c = m.credential;
  if (c.format === FORMAT_MDOC) {
    const all = listIssuerSignedClaims(b64u.decode(c.raw));
    return m.item.claims.filter((cl) => all[cl.namespace!]?.[cl.name] !== undefined).map((cl) => ({ namespace: cl.namespace, name: cl.name, value: all[cl.namespace!][cl.name] }));
  }
  const { disclosable, visible } = listSdJwtClaims(c.raw);
  const all = { ...visible, ...disclosable } as Record<string, unknown>;
  return m.item.claims.filter((cl) => all[cl.name] !== undefined).map((cl) => ({ name: cl.name, value: all[cl.name] }));
}

export function buildVpToken(req: AuthRequest, matches: Match[]): { vp_token: string; presentation_submission?: string } {
  const presentations: Record<string, string> = {};
  for (const m of matches) {
    if (!m.available) throw new ProtocolError('no matching credential for ' + m.item.id, 'no_credential');
    const key = asKeyPair(m.credential);
    if (m.credential.format === FORMAT_MDOC) {
      const requested: Record<string, string[]> = {};
      for (const cl of m.item.claims) (requested[cl.namespace!] ??= []).push(cl.name);
      const resp = buildDeviceResponse({
        documents: [{ issuerSigned: b64u.decode(m.credential.raw), deviceKeyPriv: key.privateKey, requested }],
        sessionTranscript: openid4vpTranscript({ clientId: req.clientId, nonce: req.nonce, responseUri: req.responseUri }),
      });
      presentations[m.item.id] = b64u.encode(resp);
    } else {
      presentations[m.item.id] = presentSdJwt(m.credential.raw, m.item.claims.map((c) => c.name), key.privateKey, req.clientId, req.nonce);
    }
  }
  if (req.dcql) {
    const wrapped = Object.fromEntries(Object.entries(presentations).map(([k, v]) => [k, [v]]));
    return { vp_token: JSON.stringify(wrapped) };
  }
  const first = matches[0];
  return {
    vp_token: presentations[first.item.id],
    presentation_submission: JSON.stringify({
      id: 'sub-' + Date.now(), definition_id: req.definitionId,
      descriptor_map: [{ id: first.item.id, format: first.item.format === 'mso_mdoc' ? 'mso_mdoc' : 'vc+sd-jwt', path: '$' }],
    }),
  };
}

export async function submitResponse(req: AuthRequest, matches: Match[], f: FetchLike = defaultFetch): Promise<{ redirect_uri?: string }> {
  const { vp_token, presentation_submission } = buildVpToken(req, matches);
  const r = await f(req.responseUri, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ vp_token, presentation_submission, state: req.state }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ProtocolError(j.error_description || j.error || 'verifier rejected the presentation', j.error || 'rejected', r.status, j);
  return j;
}
