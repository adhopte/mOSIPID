// Tiny DER/ASN.1 reader (enough for X.509, CMS SignedData and LDS SecurityObject).
export interface Asn1 {
  tag: number;           // full identifier octet
  cls: number;           // 0 universal, 1 app, 2 ctx, 3 private
  constructed: boolean;
  num: number;           // tag number
  header: number;        // header length
  start: number;         // offset of identifier octet
  end: number;           // offset after content
  raw: Uint8Array;       // full TLV
  value: Uint8Array;     // content
  children: Asn1[];
}

export function parseDer(buf: Uint8Array, start = 0, end = buf.length): Asn1 {
  let o = start;
  const first = buf[o++];
  let num = first & 0x1f;
  if (num === 0x1f) { num = 0; let b; do { b = buf[o++]; num = (num << 7) | (b & 0x7f); } while (b & 0x80); }
  let len = buf[o++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('der: unsupported length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[o++];
  }
  const header = o - start;
  if (o + len > end) throw new Error('der: truncated');
  const constructed = !!(first & 0x20);
  const node: Asn1 = {
    tag: first, cls: first >> 6, constructed, num, header, start, end: o + len,
    raw: buf.subarray(start, o + len), value: buf.subarray(o, o + len), children: [],
  };
  if (constructed) {
    let p = o;
    while (p < o + len) { const c = parseDer(buf, p, o + len); node.children.push(c); p = c.end; }
  }
  return node;
}

export function derOid(n: Asn1): string {
  const b = n.value;
  const parts: number[] = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) { v = (v << 7) | (b[i] & 0x7f); if (!(b[i] & 0x80)) { parts.push(v); v = 0; } }
  return parts.join('.');
}

export function derTime(n: Asn1): Date {
  const s = String.fromCharCode(...n.value);
  let y: number, rest: string;
  if (n.num === 23) { const yy = +s.slice(0, 2); y = yy >= 50 ? 1900 + yy : 2000 + yy; rest = s.slice(2); }
  else { y = +s.slice(0, 4); rest = s.slice(4); }
  return new Date(Date.UTC(y, +rest.slice(0, 2) - 1, +rest.slice(2, 4), +rest.slice(4, 6), +rest.slice(6, 8), +(rest.slice(8, 10) || 0)));
}

export function derInt(n: Asn1): bigint {
  let v = 0n;
  for (const x of n.value) v = (v << 8n) | BigInt(x);
  return v;
}

// --- writer (used by tests and cert building helpers) ---
export function derLen(n: number): number[] {
  if (n < 128) return [n];
  const bytes: number[] = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}
export function derEnc(tag: number, content: Uint8Array): Uint8Array {
  const l = derLen(content.length);
  const out = new Uint8Array(1 + l.length + content.length);
  out[0] = tag; out.set(l, 1); out.set(content, 1 + l.length);
  return out;
}
