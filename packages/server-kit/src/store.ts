// Tiny key/value store with TTLs: in-memory for dev/tests, Postgres (jsonb) in production.
export interface Store {
  get<T = any>(ns: string, key: string): Promise<T | undefined>;
  set(ns: string, key: string, value: unknown, ttlSec?: number): Promise<void>;
  del(ns: string, key: string): Promise<void>;
  /** atomically read and delete (single-use codes) */
  take<T = any>(ns: string, key: string): Promise<T | undefined>;
  list<T = any>(ns: string): Promise<{ key: string; value: T }[]>;
  close(): Promise<void>;
}

export class MemoryStore implements Store {
  private m = new Map<string, { v: any; exp?: number }>();
  private k = (ns: string, key: string) => `${ns}\u0000${key}`;
  private alive(e?: { exp?: number }) { return !!e && (!e.exp || e.exp > Date.now()); }
  async get(ns: string, key: string) { const e = this.m.get(this.k(ns, key)); if (!this.alive(e)) { this.m.delete(this.k(ns, key)); return undefined; } return structuredClone(e!.v); }
  async set(ns: string, key: string, value: unknown, ttlSec?: number) { this.m.set(this.k(ns, key), { v: structuredClone(value), exp: ttlSec ? Date.now() + ttlSec * 1000 : undefined }); }
  async del(ns: string, key: string) { this.m.delete(this.k(ns, key)); }
  async take(ns: string, key: string) { const v = await this.get(ns, key); await this.del(ns, key); return v; }
  async list(ns: string) {
    const out: { key: string; value: any }[] = [];
    for (const [k, e] of this.m) if (k.startsWith(ns + '\u0000') && this.alive(e)) out.push({ key: k.split('\u0000')[1], value: structuredClone(e.v) });
    return out;
  }
  async close() {}
}

export class PgStore implements Store {
  private pool: any;
  private ready: Promise<void>;
  constructor(url: string, pg: any) {
    // Render's *external* URLs (…render.com) and sslmode=require need TLS; the internal URL does not.
    const ssl = /render\.com|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined;
    this.pool = new pg.Pool({ connectionString: url, ssl, max: 5 });
    this.ready = this.pool.query(`CREATE TABLE IF NOT EXISTS kv (ns text NOT NULL, key text NOT NULL, value jsonb NOT NULL, expires_at timestamptz, PRIMARY KEY (ns, key))`).then(() => undefined);
    setInterval(() => this.pool.query('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at < now()').catch(() => {}), 60_000).unref();
  }
  async get(ns: string, key: string) {
    await this.ready;
    const r = await this.pool.query('SELECT value FROM kv WHERE ns=$1 AND key=$2 AND (expires_at IS NULL OR expires_at > now())', [ns, key]);
    return r.rows[0]?.value;
  }
  async set(ns: string, key: string, value: unknown, ttlSec?: number) {
    await this.ready;
    await this.pool.query(
      `INSERT INTO kv(ns,key,value,expires_at) VALUES($1,$2,$3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + ($4::int || ' seconds')::interval END)
       ON CONFLICT (ns,key) DO UPDATE SET value=EXCLUDED.value, expires_at=EXCLUDED.expires_at`, [ns, key, JSON.stringify(value), ttlSec ?? null]);
  }
  async del(ns: string, key: string) { await this.ready; await this.pool.query('DELETE FROM kv WHERE ns=$1 AND key=$2', [ns, key]); }
  async take(ns: string, key: string) {
    await this.ready;
    const r = await this.pool.query('DELETE FROM kv WHERE ns=$1 AND key=$2 AND (expires_at IS NULL OR expires_at > now()) RETURNING value', [ns, key]);
    return r.rows[0]?.value;
  }
  async list(ns: string) {
    await this.ready;
    const r = await this.pool.query('SELECT key, value FROM kv WHERE ns=$1 AND (expires_at IS NULL OR expires_at > now())', [ns]);
    return r.rows;
  }
  async close() { await this.pool.end(); }
}

export async function createStore(databaseUrl = process.env.DATABASE_URL): Promise<Store> {
  if (!databaseUrl) {
    console.warn('[store] DATABASE_URL not set – using in-memory store (data is lost on restart)');
    return new MemoryStore();
  }
  const pg = await import('pg');
  return new PgStore(databaseUrl, (pg as any).default ?? pg);
}
