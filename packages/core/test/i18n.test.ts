import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import en from '../src/locales/en.json';
import fr from '../src/locales/fr.json';
import es from '../src/locales/es.json';
import { translate, normalizeLang } from '../src/i18n';

const root = resolve(__dirname, '../../..');
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (['node_modules', 'dist', '.expo', 'test'].includes(f)) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(html|js|ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

test('en/fr/es define exactly the same keys and no empty strings', () => {
  const keys = Object.keys(en).sort();
  assert.deepEqual(Object.keys(fr).sort(), keys);
  assert.deepEqual(Object.keys(es).sort(), keys);
  for (const d of [en, fr, es]) for (const [k, v] of Object.entries(d)) assert.ok((v as string).trim(), `empty: ${k}`);
});

test('placeholders are preserved across languages', () => {
  for (const k of Object.keys(en)) {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    assert.equal(ph((fr as any)[k]), ph((en as any)[k]), k); assert.equal(ph((es as any)[k]), ph((en as any)[k]), k);
  }
});

test('every statically referenced UI key exists', () => {
  const files = [...walk(join(root, 'services')), ...walk(join(root, 'apps')), ...walk(join(root, 'packages/mobile-kit')), ...walk(join(root, 'packages/web-shared'))];
  const missing: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const found = new Set<string>();
    for (const m of src.matchAll(/data-i18n(?:-placeholder|-title)?="([a-z][\w.]*)"/g)) found.add(m[1]);
    for (const m of src.matchAll(/\b(?:t|App\.t)\(\s*'([a-z]+\.[\w.]+)'/g)) found.add(m[1]);
    for (const m of src.matchAll(/'((?:w|p|v|i|admin|common|claim|err)\.[a-zA-Z0-9_.]+)'/g)) if (!/\.$/.test(m[1])) found.add(m[1]);
    for (const k of found) if (!k.endsWith('.') && !(k in en) && !k.startsWith('claim.') && !k.startsWith('err.')) missing.push(`${f.replace(root, '')}: ${k}`);
  }
  assert.deepEqual(missing, []);
});

test('dynamic key families are complete', () => {
  for (const s of ['created', 'verified', 'issued', 'failed']) assert.ok(`i.status.${s}` in en);
  for (const c of ['primary', 'secondary', 'background', 'surface', 'text', 'accent']) assert.ok(`admin.color.${c}` in en);
  // every rejection code the issuer can return has a translated message
  const routes = readFileSync(join(root, 'services/issuer/src/proofing/routes.ts'), 'utf8');
  const codes = new Set([...routes.matchAll(/'((?:mrz|document|face|sod|csca|dg[12]|passive|selfie)_[a-z0-9_]+)'/g)].map((m) => m[1]));
  for (const c of ['sod_hash_mismatch_dg1', 'sod_hash_mismatch_dg2']) codes.add(c);
  for (const c of codes) assert.ok(`err.${c}` in en, `err.${c} missing`);
});

test('interpolation and language negotiation', () => {
  assert.equal(translate('fr', 'p.trust.info', { count: 2, date: 'X' }), '2 ancres de confiance · dernière synchro X');
  assert.equal(normalizeLang('es-MX'), 'es');
  assert.equal(normalizeLang('de'), 'en');
  assert.equal(translate('xx', 'common.start'), 'Start');
});
