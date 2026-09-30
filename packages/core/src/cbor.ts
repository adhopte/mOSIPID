// Minimal deterministic CBOR (RFC 8949) sufficient for ISO 18013-5 / COSE.
// Maps decode to `Map` (keys may be int or text); JS objects encode as text-keyed maps.
import { concat, utf8, fromUtf8 } from './bytes';

export class Tagged {
  constructor(public tag: number, public value: unknown) {}
}
/** Marks a Uint8Array-like pre-encoded CBOR item to be embedded verbatim. */
export class Raw {
  constructor(public bytes: Uint8Array) {}
}
/** CBOR `undefined`-free "simple" null helper */

function head(major: number, n: number | bigint): Uint8Array {
  const m = major << 5;
  if (typeof n === 'bigint') {
    const b = new Uint8Array(9);
    b[0] = m | 27;
    let v = n;
    for (let i = 8; i >= 1; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
    return b;
  }
  if (n < 24) return Uint8Array.of(m | n);
  if (n < 0x100) return Uint8Array.of(m | 24, n);
  if (n < 0x10000) return Uint8Array.of(m | 25, n >> 8, n & 0xff);
  if (n < 0x100000000) return Uint8Array.of(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  return head(major, BigInt(n));
}

export function encode(v: unknown): Uint8Array {
  if (v instanceof Raw) return v.bytes;
  if (v === null || v === undefined) return Uint8Array.of(0xf6);
  if (v === true) return Uint8Array.of(0xf5);
  if (v === false) return Uint8Array.of(0xf4);
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) {
      const b = new Uint8Array(9);
      b[0] = 0xfb;
      new DataView(b.buffer).setFloat64(1, v);
      return b;
    }
    return v >= 0 ? head(0, v) : head(1, -1 - v);
  }
  if (typeof v === 'bigint') return v >= 0n ? head(0, v) : head(1, -1n - v);
  if (typeof v === 'string') { const u = utf8(v); return concat(head(3, u.length), u); }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  if (v instanceof Tagged) return concat(head(6, v.tag), encode(v.value));
  if (Array.isArray(v)) return concat(head(4, v.length), ...v.map(encode));
  if (v instanceof Map) {
    const parts: Uint8Array[] = [head(5, v.size)];
    for (const [k, val] of v) parts.push(encode(k), encode(val));
    return concat(...parts);
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    const parts: Uint8Array[] = [head(5, entries.length)];
    for (const [k, val] of entries) parts.push(encode(k), encode(val));
    return concat(...parts);
  }
  throw new Error('cbor: unsupported type ' + typeof v);
}

export function decode(bytes: Uint8Array): unknown {
  const [v, off] = decodeAt(bytes, 0);
  if (off !== bytes.length) throw new Error('cbor: trailing bytes');
  return v;
}

/** Decode one item and return its value plus the raw bytes it occupied. */
export function decodeWithRaw(bytes: Uint8Array, start = 0): { value: unknown; raw: Uint8Array; end: number } {
  const [value, end] = decodeAt(bytes, start);
  return { value, raw: bytes.subarray(start, end), end };
}

function readArg(b: Uint8Array, o: number, info: number): [number | bigint, number] {
  if (info < 24) return [info, o];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (info === 24) return [b[o], o + 1];
  if (info === 25) return [dv.getUint16(o), o + 2];
  if (info === 26) return [dv.getUint32(o), o + 4];
  if (info === 27) {
    const v = dv.getBigUint64(o);
    return [v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v, o + 8];
  }
  throw new Error('cbor: unsupported additional info ' + info);
}

function decodeAt(b: Uint8Array, o: number): [unknown, number] {
  const ib = b[o++];
  if (ib === undefined) throw new Error('cbor: unexpected end');
  const major = ib >> 5, info = ib & 31;
  if (major === 7) {
    if (info === 20) return [false, o];
    if (info === 21) return [true, o];
    if (info === 22 || info === 23) return [null, o];
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (info === 26) return [dv.getFloat32(o), o + 4];
    if (info === 27) return [dv.getFloat64(o), o + 8];
    throw new Error('cbor: unsupported simple value');
  }
  const [arg, o2] = readArg(b, o, info);
  o = o2;
  switch (major) {
    case 0: return [arg, o];
    case 1: return [typeof arg === 'bigint' ? -1n - arg : -1 - arg, o];
    case 2: { const n = Number(arg); return [b.slice(o, o + n), o + n]; }
    case 3: { const n = Number(arg); return [fromUtf8(b.subarray(o, o + n)), o + n]; }
    case 4: {
      const arr: unknown[] = [];
      for (let i = 0; i < Number(arg); i++) { const [x, n] = decodeAt(b, o); arr.push(x); o = n; }
      return [arr, o];
    }
    case 5: {
      const m = new Map<unknown, unknown>();
      for (let i = 0; i < Number(arg); i++) {
        const [k, n1] = decodeAt(b, o);
        const [x, n2] = decodeAt(b, n1);
        m.set(k, x); o = n2;
      }
      return [m, o];
    }
    case 6: { const [x, n] = decodeAt(b, o); return [new Tagged(Number(arg), x), n]; }
  }
  throw new Error('cbor: bad major type');
}

// Helpers for ISO 18013-5 "tag 24" embedded CBOR
export const encodeTag24 = (v: unknown) => new Tagged(24, encode(v));
export function decodeTag24(t: unknown): unknown {
  if (!(t instanceof Tagged) || t.tag !== 24 || !(t.value instanceof Uint8Array)) throw new Error('cbor: expected tag 24 bstr');
  return decode(t.value);
}
export const tag24Bytes = (t: unknown): Uint8Array => {
  if (!(t instanceof Tagged) || t.tag !== 24) throw new Error('cbor: expected tag 24');
  return t.value as Uint8Array;
};

/** Convenience: get a text key from a decoded Map or plain object. */
export function mget<T = unknown>(m: unknown, k: string | number): T | undefined {
  if (m instanceof Map) return m.get(k) as T;
  return (m as any)?.[k];
}
