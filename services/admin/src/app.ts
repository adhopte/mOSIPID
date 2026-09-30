import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { DEFAULT_BRANDING, Branding, LANGUAGES } from '@mosipid/core';
import { createApp, errorHandler, wrap, HttpError, signToken, verifyToken, parseCookies, rateLimit, baseUrl, sharedWeb, Store, Request, Response, NextFunction } from '@mosipid/server-kit';

const NS = 'branding';
const LOGO_NS = 'logo';
const MAX_LOGO_BYTES = 300 * 1024;
const HEX = /^#[0-9a-fA-F]{6}$/;

export interface AdminConfig { store: Store; user: string; password: string; secret: string; publicUrl?: string }

export function buildApp(cfg: AdminConfig) {
  const app = createApp({ name: 'admin', staticDirs: [path.resolve(__dirname, '../public')], sharedWebDir: sharedWeb(__dirname) });
  const base = () => cfg.publicUrl ?? baseUrl();
  const secure = () => base().startsWith('https');

  const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
  const isAdmin = (req: Request) => verifyToken(parseCookies(req.headers.cookie).admin, cfg.secret)?.sub === 'admin';
  const requireAdmin = (req: Request, _res: Response, next: NextFunction) => {
    if (!isAdmin(req)) return next(new HttpError(401, 'unauthorized', 'admin login required'));
    // state-changing calls must be JSON (blocks cross-site form posts)
    if (req.method !== 'GET' && !(req.headers['content-type'] ?? '').startsWith('application/json')) return next(new HttpError(415, 'unsupported_media_type'));
    next();
  };

  const view = async (tenant: string): Promise<Branding | undefined> => {
    const stored = await cfg.store.get<Branding>(NS, tenant);
    const def = DEFAULT_BRANDING[tenant];
    const b = stored ?? def;
    if (!b) return undefined;
    const hasLogo = !!(await cfg.store.get(LOGO_NS, tenant));
    const logoUrl = hasLogo ? `${base()}/assets/logo/${tenant}?v=${encodeURIComponent(b.updatedAt ?? '0')}`
      : def?.defaultLogo ? `${base()}/assets/default/bluetiger.png` : undefined;
    return { ...b, defaultLogo: def?.defaultLogo, logoUrl };
  };
  const allTenants = async () => {
    const ids = new Set([...Object.keys(DEFAULT_BRANDING), ...(await cfg.store.list(NS)).map((e) => e.key)]);
    return (await Promise.all([...ids].map(view))).filter(Boolean) as Branding[];
  };

  app.get('/api/branding', wrap(async (_req, res) => { res.setHeader('cache-control', 'public, max-age=30'); res.json(await allTenants()); }));
  app.get('/api/branding/:tenant', wrap(async (req, res) => {
    const b = await view(req.params.tenant);
    if (!b) throw new HttpError(404, 'unknown_tenant');
    res.setHeader('cache-control', 'public, max-age=30');
    res.json(b);
  }));
  // convenience for plain HTML consumers
  app.get('/api/branding/:tenant/theme.css', wrap(async (req, res) => {
    const b = await view(req.params.tenant);
    if (!b) throw new HttpError(404, 'unknown_tenant');
    res.type('text/css').send(`:root{--primary:${b.colors.primary};--secondary:${b.colors.secondary};--bg:${b.colors.background};--surface:${b.colors.surface};--text:${b.colors.text};--accent:${b.colors.accent}}`);
  }));
  app.get('/assets/default/bluetiger.png', (_req, res) => {
    res.setHeader('cache-control', 'public, max-age=86400');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    res.sendFile(path.resolve(__dirname, '../../../packages/web-shared/brand/bluetiger-logo.png'));
  });
  app.get('/assets/logo/:tenant', wrap(async (req, res) => {
    const l = await cfg.store.get<{ mime: string; b64: string }>(LOGO_NS, req.params.tenant);
    if (!l) throw new HttpError(404, 'no_logo');
    res.setHeader('cache-control', 'public, max-age=300');
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'"); // neutralise SVG scripts
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    res.type(l.mime).send(Buffer.from(l.b64, 'base64'));
  }));

  // ---------- auth
  app.post('/api/admin/login', rateLimit(10, 60_000), wrap(async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string' || !same(username, cfg.user) || !same(password, cfg.password)) throw new HttpError(401, 'invalid_credentials');
    res.setHeader('set-cookie', `admin=${signToken({ sub: 'admin' }, cfg.secret, 8 * 3600)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${8 * 3600}${secure() ? '; Secure' : ''}`);
    res.json({ ok: true });
  }));
  app.post('/api/admin/logout', (_req, res) => { res.setHeader('set-cookie', 'admin=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true }); });
  app.get('/api/admin/me', (req, res) => res.json({ admin: isAdmin(req) }));

  // ---------- admin writes
  const validate = (b: any): Partial<Branding> => {
    const out: Partial<Branding> = {};
    if (b.names !== undefined) {
      if (typeof b.names !== 'object' || !b.names) throw new HttpError(400, 'invalid_names');
      const names: Record<string, string> = {};
      for (const [k, v] of Object.entries(b.names)) {
        if (!LANGUAGES.some((l) => l.code === k) || typeof v !== 'string' || v.length > 100) throw new HttpError(400, 'invalid_names', `bad name for ${k}`);
        if (v.trim()) names[k] = v.trim();
      }
      if (!names.en) throw new HttpError(400, 'invalid_names', 'an English name is required');
      out.names = names;
    }
    if (b.colors !== undefined) {
      const c: any = {};
      for (const k of ['primary', 'secondary', 'background', 'surface', 'text', 'accent']) {
        if (typeof b.colors?.[k] !== 'string' || !HEX.test(b.colors[k])) throw new HttpError(400, 'invalid_colors', `${k} must be #RRGGBB`);
        c[k] = b.colors[k];
      }
      out.colors = c;
    }
    if (b.theme !== undefined) {
      if (!['light', 'dark', 'auto'].includes(b.theme)) throw new HttpError(400, 'invalid_theme');
      out.theme = b.theme;
    }
    return out;
  };

  app.put('/api/branding/:tenant', requireAdmin, wrap(async (req, res) => {
    const tenant = req.params.tenant;
    if (!/^[a-z0-9-]{2,40}$/.test(tenant)) throw new HttpError(400, 'invalid_tenant');
    const existing = (await cfg.store.get<Branding>(NS, tenant)) ?? DEFAULT_BRANDING[tenant] ??
      ({ tenant, kind: req.body.kind === 'issuer' || req.body.kind === 'wallet' ? req.body.kind : 'verifier', names: { en: tenant }, colors: DEFAULT_BRANDING.wallet.colors, theme: 'auto' } as Branding);
    const merged: Branding = { ...existing, ...validate(req.body), tenant, updatedAt: new Date().toISOString() };
    await cfg.store.set(NS, tenant, merged);
    if (req.body.logo === null) await cfg.store.del(LOGO_NS, tenant);
    else if (typeof req.body.logo === 'string') {
      const m = req.body.logo.match(/^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/);
      if (!m) throw new HttpError(400, 'invalid_logo', 'logo must be a PNG, JPEG, WebP or SVG data URL');
      if (Buffer.from(m[2], 'base64').length > MAX_LOGO_BYTES) throw new HttpError(413, 'logo_too_large', 'max 300 KB');
      await cfg.store.set(LOGO_NS, tenant, { mime: m[1], b64: m[2] });
    }
    res.json(await view(tenant));
  }));

  app.delete('/api/branding/:tenant', requireAdmin, wrap(async (req, res) => {
    await cfg.store.del(NS, req.params.tenant);
    await cfg.store.del(LOGO_NS, req.params.tenant);
    const b = await view(req.params.tenant);
    res.json(b ?? { deleted: true });
  }));

  app.get('/config.js', (_req, res) => res.type('js').send(`window.__CONFIG__=${JSON.stringify({ adminUrl: base() })};`));
  errorHandler(app);
  return app;
}
