import express, { Express, NextFunction, Request, Response, RequestHandler } from 'express';
import QRCode from 'qrcode';
import path from 'node:path';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { dictionaries, normalizeLang, LANGUAGES } from '@mosipid/core';

export const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>): RequestHandler => (req, res, next) => { fn(req, res, next).catch(next); };

export class HttpError extends Error { constructor(public status: number, public code: string, message?: string, public extra: Record<string, unknown> = {}) { super(message ?? code); } }

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function baseUrl(): string {
  const u = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
  return u.replace(/\/$/, '');
}

export function allowedOrigins(): string[] | '*' {
  const v = process.env.CORS_ORIGINS;
  return !v || v === '*' ? '*' : v.split(',').map((s) => s.trim());
}

/** Common middleware: security headers, CORS, body parsing, health, i18n and QR endpoints. */
export function createApp(opts: { name: string; staticDirs?: string[]; sharedWebDir?: string; jsonLimit?: string }): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const origins = allowedOrigins();
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origins === '*') res.setHeader('access-control-allow-origin', '*');
    else if (origin && origins.includes(origin)) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'origin'); }
    res.setHeader('access-control-allow-headers', 'content-type, authorization, dpop');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    if (req.method === 'OPTIONS') return void res.status(204).end();
    next();
  });
  app.use(express.json({ limit: opts.jsonLimit ?? '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', service: opts.name }));
  app.get('/i18n', (_req, res) => res.json({ languages: LANGUAGES }));
  app.get('/i18n/:lang.json', (req, res) => { res.setHeader('cache-control', 'public, max-age=300'); res.json(dictionaries[normalizeLang(req.params.lang)]); });
  app.get('/api/qr', wrap(async (req, res) => {
    const data = String(req.query.data ?? '');
    if (!data || data.length > 2500) throw new HttpError(400, 'invalid_request', 'data missing or too long');
    const svg = await QRCode.toString(data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').setHeader('cache-control', 'no-store').send(svg);
  }));
  if (opts.sharedWebDir) app.use('/shared', express.static(opts.sharedWebDir, { maxAge: '5m' }));
  for (const d of opts.staticDirs ?? []) app.use(express.static(d, { extensions: ['html'], maxAge: '1m' }));
  return app;
}

export function errorHandler(app: Express) {
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.code, error_description: err.message, ...err.extra });
    if (err?.type === 'entity.too.large') return void res.status(413).json({ error: 'payload_too_large' });
    console.error('[error]', err);
    res.status(500).json({ error: 'server_error' });
  });
}

// -------- simple fixed-window rate limiter (per IP + key)
export function rateLimit(limit: number, windowMs: number): RequestHandler {
  const hits = new Map<string, { n: number; reset: number }>();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const k = req.ip + req.path;
    const now = Date.now();
    const h = hits.get(k);
    if (!h || h.reset < now) hits.set(k, { n: 1, reset: now + windowMs });
    else if (++h.n > limit) return void res.status(429).json({ error: 'rate_limited' });
    next();
  };
}

// -------- signed cookie / token helpers (HMAC-SHA256)
export function signToken(payload: object, secret: string, ttlSec: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function verifyToken<T = any>(token: string | undefined, secret: string): T | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() / 1000 ? p : null;
}
export function parseCookies(h?: string): Record<string, string> {
  return Object.fromEntries((h ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
export const secretFromEnv = (name: string) => process.env[name] || (console.warn(`[security] ${name} not set – using an ephemeral secret`), randomBytes(32).toString('hex'));
export const sharedWeb = (dir: string) => path.resolve(dir, '../../../packages/web-shared');
