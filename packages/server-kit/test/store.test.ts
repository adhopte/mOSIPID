// Runs against Postgres when TEST_DATABASE_URL is set; the in-memory store always runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, PgStore, Store } from '../src/store';

async function contract(name: string, s: Store) {
  await s.set('ns', 'a', { x: 1, nested: { y: [1, 2] } });
  assert.deepEqual(await s.get('ns', 'a'), { x: 1, nested: { y: [1, 2] } }, name + ' get');
  await s.set('ns', 'a', { x: 2 });
  assert.deepEqual(await s.get('ns', 'a'), { x: 2 }, name + ' overwrite');
  assert.equal(await s.get('ns', 'missing'), undefined);
  assert.deepEqual(await s.take('ns', 'a'), { x: 2 }, name + ' take');
  assert.equal(await s.take('ns', 'a'), undefined, name + ' take is single-use');
  await s.set('ns', 'ttl', 1, 1);
  assert.equal(await s.get('ns', 'ttl'), 1);
  await s.set('other', 'k', 'v'); await s.set('ns', 'k2', 'v2');
  assert.deepEqual((await s.list('ns')).map((e) => e.key).sort(), ['k2', 'ttl']);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(await s.get('ns', 'ttl'), undefined, name + ' ttl expiry');
  await s.del('ns', 'k2'); assert.equal(await s.get('ns', 'k2'), undefined);
  // concurrent take: exactly one winner
  await s.set('race', 'code', { ok: true });
  const results = await Promise.all(Array.from({ length: 10 }, () => s.take('race', 'code')));
  assert.equal(results.filter(Boolean).length, 1, name + ' atomic take');
}

test('MemoryStore satisfies the store contract', async () => { await contract('memory', new MemoryStore()); });
test('PgStore satisfies the store contract', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pg = await import('pg');
  const s = new PgStore(process.env.TEST_DATABASE_URL!, (pg as any).default ?? pg);
  try { await contract('postgres', s); } finally { await s.close(); }
});

test('several PgStore instances starting at once do not race on table creation', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pg: any = await import('pg');
  const url = process.env.TEST_DATABASE_URL!;
  const boot = new PgStore(url, pg.default ?? pg);
  await boot.get('x', 'y'); await (boot as any).pool.query('DROP TABLE kv'); await boot.close();
  const stores = Array.from({ length: 4 }, () => new PgStore(url, pg.default ?? pg));
  try { await Promise.all(stores.map((s, i) => s.set('race', 'k' + i, i))); assert.equal((await stores[0].list('race')).length, 4); }
  finally { await Promise.all(stores.map((s) => s.close())); }
});
