import path from 'node:path';
import { Router } from 'express';
import {
  b64u, randomId, openid4vpTranscript, verifyDeviceResponse, verifySdJwtPresentation, DEFAULT_BRANDING, parseQuery,
  ReaderProximity, engagementFromQr,
} from '@mosipid/core';
import { createApp, errorHandler, wrap, HttpError, rateLimit, Store, sharedWeb, parseCookies, signToken, verifyToken, secretFromEnv } from '@mosipid/server-kit';
import { FLOWS, isFlow, dcqlFor, presentationDefinitionFor, Flow } from './flows';
import { TrustService } from './trust';
import { relayRouter } from './relay';

export interface VerifierConfig { publicUrl: string; adminUrl?: string; issuerUrl?: string; secret: string; brandCacheMs?: number; /** how this process reaches its own relay (defaults to publicUrl) */ internalUrl?: string }

interface Tx { mode?: 'remote' | 'proximity'; flow: Flow['id']; nonce: string; pollToken: string; status: 'pending' | 'verified' | 'rejected'; error?: string; claims?: Record<string, unknown>; issuer?: string; consumed?: boolean; createdAt: number }

const TX_TTL = 600;

export function buildApp(store: Store, cfg: VerifierConfig, trust: TrustService) {
  const app = createApp({ name: 'verifier', staticDirs: [path.resolve(__dirname, '../public')], sharedWebDir: sharedWeb(__dirname) });
  const secure = cfg.publicUrl.startsWith('https');
  const responseUri = `${cfg.publicUrl}/api/response`;
  const clientId = `redirect_uri:${responseUri}`;

  app.get('/config.js', (_req, res) => res.type('js').send(`window.__CONFIG__=${JSON.stringify({
    adminUrl: cfg.adminUrl, issuerUrl: cfg.issuerUrl, verifierUrl: cfg.publicUrl, defaults: DEFAULT_BRANDING,
  })};`));
  app.get('/api/trust', wrap(async (_req, res) => { res.setHeader('cache-control', 'public, max-age=60'); res.json({ anchors: await trust.list() }); }));

  const api = Router();
  api.post('/sessions', rateLimit(60, 60_000), wrap(async (req, res) => {
    const flowId = req.body?.flow;
    if (!isFlow(flowId)) throw new HttpError(400, 'invalid_flow');
    const id = randomId(18);
    const tx: Tx = { flow: flowId, nonce: randomId(18), pollToken: randomId(18), status: 'pending', createdAt: Date.now() };
    await store.set('vtx', id, tx, TX_TTL);
    const uri = `openid4vp://authorize?client_id=${encodeURIComponent(clientId)}&request_uri=${encodeURIComponent(`${cfg.publicUrl}/api/request/${id}`)}&request_uri_method=get`;
    res.json({ id, poll_token: tx.pollToken, request_uri: uri, expires_in: TX_TTL });
  }));

  api.get('/request/:id', wrap(async (req, res) => {
    const tx = await store.get<Tx>('vtx', req.params.id);
    if (!tx || tx.status !== 'pending') throw new HttpError(404, 'request_not_found');
    const f = FLOWS[tx.flow];
    res.json({
      client_id: clientId, response_type: 'vp_token', response_mode: 'direct_post', response_uri: responseUri,
      nonce: tx.nonce, state: req.params.id,
      dcql_query: dcqlFor(f), presentation_definition: presentationDefinitionFor(f, `pd-${f.id}`),
      client_metadata: {
        client_name: (await brandName(f.tenant)),
        vp_formats: { mso_mdoc: { alg: ['ES256'] }, 'dc+sd-jwt': { 'sd-jwt_alg_values': ['ES256'], 'kb-jwt_alg_values': ['ES256'] } },
      },
      purpose: f.id === 'electricity' ? 'Sign in with your digital ID' : 'Sign in with your degree attestation',
    });
  }));

  const brandCache = new Map<string, { at: number; name: string }>();
  async function brandName(tenant: string): Promise<string> {
    const c = brandCache.get(tenant);
    if (c && Date.now() - c.at < (cfg.brandCacheMs ?? 30_000)) return c.name;
    let name = DEFAULT_BRANDING[tenant]?.names.en ?? tenant;
    if (cfg.adminUrl) { try { const r = await fetch(`${cfg.adminUrl}/api/branding/${tenant}`, { signal: AbortSignal.timeout(2500) }); if (r.ok) name = (await r.json()).names?.en ?? name; } catch { /* default */ } }
    brandCache.set(tenant, { at: Date.now(), name });
    return name;
  }

  /** Turn verified claims into what the page shows; binary portraits become data URLs. Returns an error when requested claims are missing. */
  const finalizeClaims = (f: Flow, raw: Record<string, unknown>): { claims: Record<string, unknown> } | { error: string } => {
    const claims = { ...raw };
    const missing = f.claims.filter((c) => claims[c] === undefined && c !== 'portrait' && c !== 'university');
    if (missing.length) return { error: 'required claims not disclosed: ' + missing.join(', ') };
    for (const k of Object.keys(claims)) if (claims[k] instanceof Uint8Array) claims[k] = `data:image/jpeg;base64,${Buffer.from(claims[k] as Uint8Array).toString('base64')}`;
    return { claims };
  };

  // ---- proximity from a website: the browser scans the wallet's QR (device engagement), this server plays the reader.
  // The encrypted DeviceRequest/DeviceResponse travel through this server's own relay; the browser just polls as in the remote flow.
  const sameOrigin = (a: string, b: string) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };
  api.post('/proximity/start', rateLimit(30, 60_000), wrap(async (req, res) => {
    const flowId = req.body?.flow, qr = req.body?.engagement;
    if (!isFlow(flowId)) throw new HttpError(400, 'invalid_flow');
    if (typeof qr !== 'string' || !/^mdoc:/i.test(qr) || qr.length > 4000) throw new HttpError(400, 'invalid_engagement', 'not a wallet QR code');
    let relayUrl: string | undefined;
    try { relayUrl = engagementFromQr(qr).relay?.url; } catch { throw new HttpError(400, 'invalid_engagement', 'unreadable device engagement'); }
    // only our own relay: this endpoint must not be usable to make the server call arbitrary URLs
    if (!relayUrl || !sameOrigin(relayUrl, cfg.publicUrl)) throw new HttpError(400, 'unsupported_relay', 'the wallet must use this verifier as its relay (check the wallet\'s verifier URL setting)');
    const f = FLOWS[flowId];
    const id = randomId(18);
    const tx: Tx = { mode: 'proximity', flow: flowId, nonce: randomId(18), pollToken: randomId(18), status: 'pending', createdAt: Date.now() };
    await store.set('vtx', id, tx, TX_TTL);
    void (async () => {
      const finish = (t: Tx) => store.set('vtx', id, t, TX_TTL).catch(() => {});
      try {
        const anchors = await trust.certs(f.anchor);
        if (!anchors.length) return void finish({ ...tx, status: 'rejected', error: 'no trust anchors available for ' + f.anchor });
        const relayBase = cfg.internalUrl ?? cfg.publicUrl;
        if (f.format === 'mso_mdoc') {
          const r = await ReaderProximity.request(qr, { [f.docType!]: { [f.namespace!]: f.claims } }, { trustAnchors: anchors, relayBase, timeoutMs: 100_000 });
          if (!r.ok) return void finish({ ...tx, status: 'rejected', error: r.error });
          const out = finalizeClaims(f, r.documents[0].claims[f.namespace!] ?? {});
          return void finish('error' in out ? { ...tx, status: 'rejected', error: out.error } : { ...tx, status: 'verified', claims: out.claims, issuer: r.documents[0].anchorSubject });
        }
        const r = await ReaderProximity.requestSdJwt(qr, { vct: f.vct!, claims: f.claims }, { trustAnchors: anchors, relayBase, timeoutMs: 100_000 });
        if (!r.ok) return void finish({ ...tx, status: 'rejected', error: r.error });
        const out = finalizeClaims(f, Object.fromEntries(f.claims.filter((c) => r.claims[c] !== undefined).map((c) => [c, r.claims[c]])));
        finish('error' in out ? { ...tx, status: 'rejected', error: out.error } : { ...tx, status: 'verified', claims: out.claims, issuer: r.anchorSubject });
      } catch (e: any) { finish({ ...tx, status: 'rejected', error: e?.message ?? 'proximity failed' }); }
    })();
    res.json({ id, poll_token: tx.pollToken, expires_in: TX_TTL });
  }));

  // wallet posts here (response_mode=direct_post)
  api.post('/response', rateLimit(60, 60_000), wrap(async (req, res) => {
    const state = String(req.body?.state ?? '');
    const tx = await store.get<Tx>('vtx', state);
    if (!tx) throw new HttpError(400, 'invalid_request', 'unknown or expired state');
    if (tx.status !== 'pending') throw new HttpError(400, 'invalid_request', 'transaction already completed');
    const f = FLOWS[tx.flow];
    const fail = async (msg: string): Promise<never> => {
      await store.set('vtx', state, { ...tx, status: 'rejected', error: msg }, TX_TTL);
      throw new HttpError(400, 'invalid_presentation', msg);
    };
    let token = req.body?.vp_token as string | undefined;
    if (!token) return fail('vp_token missing');
    if (token.trim().startsWith('{')) {
      try { const o = JSON.parse(token); const v = o[f.queryId]; token = Array.isArray(v) ? v[0] : v; } catch { return fail('vp_token is not valid JSON'); }
    }
    if (typeof token !== 'string' || !token) return fail('no presentation for ' + f.queryId);
    const anchors = await trust.certs(f.anchor);
    if (!anchors.length) return fail('no trust anchors available for ' + f.anchor);

    let claims: Record<string, unknown> = {}; let issuer = '';
    if (f.format === 'mso_mdoc') {
      const result = verifyDeviceResponse(b64u.decode(token), {
        sessionTranscript: openid4vpTranscript({ clientId, nonce: tx.nonce, responseUri }), trustAnchors: anchors, expectedDocType: f.docType,
      });
      if (!result.ok) return fail(result.error);
      claims = result.documents[0].claims[f.namespace!] ?? {}; issuer = result.documents[0].anchorSubject;
    } else {
      const result = verifySdJwtPresentation(token, { trustAnchors: anchors, aud: clientId, nonce: tx.nonce, expectedVct: f.vct });
      if (!result.ok) return fail(result.error);
      claims = Object.fromEntries(f.claims.filter((c) => result.claims[c] !== undefined).map((c) => [c, result.claims[c]])); issuer = result.anchorSubject;
    }
    const out = finalizeClaims(f, claims);
    if ('error' in out) return fail(out.error);
    await store.set('vtx', state, { ...tx, status: 'verified', claims: out.claims, issuer }, TX_TTL);
    res.json({});
  }));

  // browser polls; on success we mint a login session (single use)
  api.get('/sessions/:id', wrap(async (req, res) => {
    const tx = await store.get<Tx>('vtx', req.params.id);
    if (!tx || req.query.token !== tx.pollToken) throw new HttpError(404, 'session_not_found');
    res.setHeader('cache-control', 'no-store');
    if (tx.status === 'verified' && !tx.consumed) {
      await store.set('vtx', req.params.id, { ...tx, consumed: true }, TX_TTL);
      const sid = randomId(24);
      await store.set('login', sid, { flow: tx.flow, claims: tx.claims, issuer: tx.issuer, at: new Date().toISOString() }, 3600);
      res.setHeader('set-cookie', `vsess=${signToken({ sid }, cfg.secret, 3600)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600${secure ? '; Secure' : ''}`);
      return void res.json({ status: 'verified' });
    }
    res.json({ status: tx.status === 'verified' ? 'verified' : tx.status, error: tx.error });
  }));

  api.get('/me', wrap(async (req, res) => {
    const p = verifyToken(parseCookies(req.headers.cookie).vsess, cfg.secret);
    const s = p ? await store.get<any>('login', p.sid) : undefined;
    if (!s || (req.query.flow && s.flow !== req.query.flow)) throw new HttpError(401, 'not_logged_in');
    res.setHeader('cache-control', 'no-store');
    res.json(s);
  }));
  api.post('/logout', wrap(async (req, res) => {
    const p = verifyToken(parseCookies(req.headers.cookie).vsess, cfg.secret);
    if (p) await store.del('login', p.sid);
    res.setHeader('set-cookie', 'vsess=; HttpOnly; Path=/; Max-Age=0');
    res.json({ ok: true });
  }));

  app.use('/api', api);
  app.use('/api/relay', relayRouter());
  errorHandler(app);
  return app;
}
void parseQuery; void secretFromEnv;
