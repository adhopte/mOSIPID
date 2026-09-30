// ICAO 9303 MRZ parsing/validation (TD1 ID cards, TD2, TD3 passports) + OCR clean-up.
export interface MrzData {
  format: 'TD1' | 'TD2' | 'TD3';
  documentType: string;
  issuingState: string;
  surname: string;
  givenNames: string;
  documentNumber: string;
  nationality: string;
  birthDate: string;   // YYYY-MM-DD
  sex: 'M' | 'F' | 'X';
  expiryDate: string;  // YYYY-MM-DD
  optional: string;
  checksOk: boolean;
  checks: Record<string, boolean>;
  lines: string[];
}

const W = [7, 3, 1];
export function charVal(c: string): number {
  if (c === '<') return 0;
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55;
  return 0;
}
export function checkDigit(s: string): string {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += charVal(s[i]) * W[i % 3];
  return String(sum % 10);
}
const chk = (field: string, d: string) => (d === '<' && /^<*$/.test(field)) || checkDigit(field) === d;

function ymd(s: string, kind: 'birth' | 'expiry', now = new Date()): string {
  const yy = +s.slice(0, 2), mm = s.slice(2, 4), dd = s.slice(4, 6);
  const cy = now.getUTCFullYear();
  let year = Math.floor(cy / 100) * 100 + yy;
  if (kind === 'birth' && year > cy) year -= 100;
  if (kind === 'expiry' && year < cy - 50) year += 100;
  return `${year}-${mm}-${dd}`;
}
const clean = (s: string) => s.replace(/</g, ' ').trim().replace(/\s+/g, ' ');
const sexOf = (c: string): 'M' | 'F' | 'X' => (c === 'M' ? 'M' : c === 'F' ? 'F' : 'X');
function names(field: string): [string, string] {
  const [sn, gn] = field.split('<<');
  return [clean(sn ?? ''), clean(gn ?? '')];
}

export function parseMrz(input: string | string[]): MrzData {
  const lines = (Array.isArray(input) ? input : input.split(/\r?\n/)).map((l) => l.replace(/\s+/g, '').toUpperCase()).filter(Boolean);
  const L = lines.map((l) => l.length);
  if (lines.length === 3 && L.every((n) => n === 30)) {
    const [l1, l2, l3] = lines;
    const [surname, givenNames] = names(l3);
    const composite = l1.slice(5, 30) + l2.slice(0, 7) + l2.slice(8, 15) + l2.slice(18, 29);
    const checks = {
      documentNumber: chk(l1.slice(5, 14), l1[14]), birthDate: chk(l2.slice(0, 6), l2[6]),
      expiryDate: chk(l2.slice(8, 14), l2[14]), composite: chk(composite, l2[29]),
    };
    return {
      format: 'TD1', documentType: l1.slice(0, 2).replace(/</g, ''), issuingState: l1.slice(2, 5).replace(/</g, ''),
      surname, givenNames, documentNumber: l1.slice(5, 14).replace(/</g, ''), nationality: l2.slice(15, 18).replace(/</g, ''),
      birthDate: ymd(l2.slice(0, 6), 'birth'), sex: sexOf(l2[7]), expiryDate: ymd(l2.slice(8, 14), 'expiry'),
      optional: clean(l1.slice(15, 30) + l2.slice(18, 29)), checks, checksOk: Object.values(checks).every(Boolean), lines,
    };
  }
  if (lines.length === 2 && L.every((n) => n === 44 || n === 36)) {
    const [l1, l2] = lines;
    const td3 = l1.length === 44;
    const [surname, givenNames] = names(l1.slice(5));
    const numEnd = 9, o = td3 ? 44 : 36;
    const compositeParts = l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, o - 1);
    const checks: Record<string, boolean> = {
      documentNumber: chk(l2.slice(0, numEnd), l2[9]), birthDate: chk(l2.slice(13, 19), l2[19]),
      expiryDate: chk(l2.slice(21, 27), l2[27]), composite: chk(compositeParts, l2[o - 1]),
    };
    if (td3) checks.personalNumber = chk(l2.slice(28, 42), l2[42]);
    return {
      format: td3 ? 'TD3' : 'TD2', documentType: l1.slice(0, 2).replace(/</g, ''), issuingState: l1.slice(2, 5).replace(/</g, ''),
      surname, givenNames, documentNumber: l2.slice(0, 9).replace(/</g, ''), nationality: l2.slice(10, 13).replace(/</g, ''),
      birthDate: ymd(l2.slice(13, 19), 'birth'), sex: sexOf(l2[20]), expiryDate: ymd(l2.slice(21, 27), 'expiry'),
      optional: clean(l2.slice(28, td3 ? 42 : 35)), checks, checksOk: Object.values(checks).every(Boolean), lines,
    };
  }
  throw new Error('Unrecognised MRZ layout');
}

/**
 * Pull MRZ candidate lines out of noisy OCR text. Repairs the usual OCR confusions
 * (O<->0, I<->1, B<->8, S<->5, Z<->2) in numeric positions by trying parse variants
 * and picking one whose check digits all pass.
 */
export function extractMrz(ocrText: string): MrzData | null {
  const cand = ocrText.split(/\r?\n/).map((l) => l.replace(/[^A-Za-z0-9<]/g, '').toUpperCase().replace(/[«‹]/g, '<')).filter((l) => l.length >= 28);
  const tryLines = (ls: string[]): MrzData | null => {
    try { const m = parseMrz(ls); return m; } catch { return null; }
  };
  const fits = (n: number) => (n >= 44 ? 44 : n >= 36 ? 36 : n >= 30 ? 30 : n);
  const attempts: string[][] = [];
  for (const size of [44, 36, 30]) {
    const same = cand.filter((l) => Math.abs(l.length - size) <= 2 && fits(l.length) === size).map((l) => (l.length > size ? l.slice(0, size) : l.padEnd(size, '<')));
    const need = size === 30 ? 3 : 2;
    for (let i = 0; i + need <= same.length; i++) attempts.push(same.slice(i, i + need));
  }
  let best: MrzData | null = null;
  for (const a of attempts) {
    const m = tryLines(a) ?? null;
    if (!m) continue;
    if (m.checksOk) return m;
    const fixed = tryLines(a.map(fixNumericFields));
    if (fixed?.checksOk) return fixed;
    best ??= m;
  }
  return best;
}

const TO_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', B: '8', S: '5', Z: '2', G: '6' };
const TO_ALPHA: Record<string, string> = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z', '6': 'G' };
const digits = (s: string) => s.replace(/[OQDILBSZG]/g, (c) => TO_DIGIT[c] ?? c);
const letters = (s: string) => s.replace(/[0-9]/g, (c) => TO_ALPHA[c] ?? c);

/**
 * Repair typical OCR confusions in the data line: letters in numeric fields, digits in alphabetic fields
 * (nationality), and an unreadable composite check digit (recomputed only when every field-level check passes).
 */
function fixNumericFields(line: string): string {
  if (!/\d{6}/.test(line)) return line;
  const a = line.split('');
  const put = (s: number, e: number, f: (x: string) => string) => { const r = f(line.slice(s, e)); for (let i = 0; i < r.length; i++) a[s + i] = r[i]; };
  if (line.length === 30) { put(14, 15, digits); put(0, 7, digits); put(8, 15, digits); put(15, 18, letters); put(29, 30, digits); }
  else if (line.length === 44 || line.length === 36) {
    const n = line.length;
    put(9, 10, digits); put(10, 13, letters); put(13, 20, digits); put(21, 28, digits); put(n - 1, n, digits);
    if (n === 44 && a[42] !== '<') put(42, 43, digits);
    const fields = [a.slice(0, 9).join(''), a[9], a.slice(13, 19).join(''), a[19], a.slice(21, 27).join(''), a[27]];
    const okFields = checkDigit(fields[0]) === fields[1] && checkDigit(fields[2]) === fields[3] && checkDigit(fields[4]) === fields[5];
    if (okFields && !/\d/.test(line[n - 1])) {
      const composite = a.slice(0, 10).join('') + a.slice(13, 20).join('') + a.slice(21, n - 1).join('');
      a[n - 1] = checkDigit(composite);
    }
  }
  return a.join('');
}

/** ISO 5218 sex code for mdoc */
export const sexToIso5218 = (s: 'M' | 'F' | 'X') => (s === 'M' ? 1 : s === 'F' ? 2 : 0);

/** ICAO alpha-3 -> ISO alpha-2 for the countries this demo cares about; falls back to alpha-3 */
const A3_A2: Record<string, string> = { IND: 'IN', FRA: 'FR', ESP: 'ES', GBR: 'GB', USA: 'US', DEU: 'DE', D: 'DE', ITA: 'IT', PRT: 'PT', BEL: 'BE', NLD: 'NL', CHE: 'CH', CAN: 'CA', AUS: 'AU', SGP: 'SG', ARE: 'AE', MAR: 'MA', DZA: 'DZ', TUN: 'TN', MEX: 'MX', ARG: 'AR', COL: 'CO', CHL: 'CL', PER: 'PE', BRA: 'BR' };
export const alpha3to2 = (a3: string) => A3_A2[a3] ?? a3;

export function ageOver(birthDateIso: string, years: number, now = new Date()): boolean {
  const [y, m, d] = birthDateIso.split('-').map(Number);
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  return new Date(Date.UTC(y, m - 1, d)) <= cutoff;
}
