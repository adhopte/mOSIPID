// ICAO 9303 part 11: Basic Access Control + Secure Messaging (3DES), and LDS file reading.
import { sha1 } from '@noble/hashes/sha1';
import { concat, utf8, randomBytes, equalBytes, fromHex } from '../bytes';
import { TripleDes, desBlock } from './des';
import { checkDigit } from '../mrz';

export type Transceive = (apdu: Uint8Array) => Promise<Uint8Array>; // returns data||SW1||SW2

export interface BacKeys { kEnc: Uint8Array; kMac: Uint8Array }

export function adjustParity(k: Uint8Array): Uint8Array {
  return k.map((b) => { let p = 0; for (let i = 1; i < 8; i++) p ^= (b >> i) & 1; return (b & 0xfe) | (p ^ 1); });
}

/** MRZ information: docNumber(9) + cd + dob(6) + cd + doe(6) + cd  (dates as YYMMDD) */
export function bacKeySeed(documentNumber: string, birthYYMMDD: string, expiryYYMMDD: string): Uint8Array {
  const dn = documentNumber.toUpperCase().padEnd(9, '<');
  const info = dn + checkDigit(dn) + birthYYMMDD + checkDigit(birthYYMMDD) + expiryYYMMDD + checkDigit(expiryYYMMDD);
  return sha1(utf8(info)).slice(0, 16);
}
export function deriveKey(seed: Uint8Array, counter: 1 | 2): Uint8Array {
  return adjustParity(sha1(concat(seed, Uint8Array.of(0, 0, 0, counter))).slice(0, 16));
}
export const deriveBacKeys = (seed: Uint8Array): BacKeys => ({ kEnc: deriveKey(seed, 1), kMac: deriveKey(seed, 2) });

export function pad(data: Uint8Array): Uint8Array {
  const n = 8 - (data.length % 8);
  const out = new Uint8Array(data.length + n); out.set(data); out[data.length] = 0x80; return out;
}
export function unpad(data: Uint8Array): Uint8Array {
  let i = data.length - 1;
  while (i >= 0 && data[i] === 0) i--;
  if (i < 0 || data[i] !== 0x80) throw new Error('bad padding');
  return data.subarray(0, i);
}

/** ISO/IEC 9797-1 MAC algorithm 3 (retail MAC), padding method 2 applied by caller when needed */
export function retailMac(key: Uint8Array, data: Uint8Array): Uint8Array {
  const k1 = key.subarray(0, 8), k2 = key.subarray(8, 16);
  let h = new Uint8Array(8);
  for (let i = 0; i < data.length; i += 8) {
    h = desBlock(k1, data.slice(i, i + 8).map((x, j) => x ^ h[j]));
  }
  return desBlock(k1, desBlock(k2, h, true));
}

const sw = (r: Uint8Array) => (r[r.length - 2] << 8) | r[r.length - 1];
const be = (n: number) => Uint8Array.of(n >> 8, n & 0xff);

export function tlv(tag: number, value: Uint8Array): Uint8Array {
  const l = value.length;
  const len = l < 128 ? [l] : l < 256 ? [0x81, l] : [0x82, l >> 8, l & 0xff];
  return concat(Uint8Array.of(tag, ...len), value);
}
function readTlv(b: Uint8Array, o: number): { tag: number; value: Uint8Array; end: number } {
  const tag = b[o++];
  let len = b[o++];
  if (len === 0x81) len = b[o++];
  else if (len === 0x82) { len = (b[o] << 8) | b[o + 1]; o += 2; }
  return { tag, value: b.subarray(o, o + len), end: o + len };
}

export class SecureMessaging {
  constructor(private ksEnc: Uint8Array, private ksMac: Uint8Array, private ssc: Uint8Array) {}
  private incSsc() { for (let i = 7; i >= 0; i--) { this.ssc[i] = (this.ssc[i] + 1) & 0xff; if (this.ssc[i]) break; } }

  protect(cla: number, ins: number, p1: number, p2: number, data?: Uint8Array, le?: number): Uint8Array {
    const header = pad(Uint8Array.of(cla | 0x0c, ins, p1, p2));
    let body = new Uint8Array(0);
    if (data?.length) {
      const enc = new TripleDes(this.ksEnc).cbcEncrypt(pad(data));
      body = concat(body, tlv(0x87, concat(Uint8Array.of(1), enc)));
    }
    if (le !== undefined) body = concat(body, tlv(0x97, Uint8Array.of(le)));
    this.incSsc();
    const cc = retailMac(this.ksMac, pad(concat(this.ssc, header.subarray(0, 8) /* padded header */, body)));
    const do8e = tlv(0x8e, cc);
    const payload = concat(body, do8e);
    return concat(Uint8Array.of(cla | 0x0c, ins, p1, p2, payload.length), payload, Uint8Array.of(0));
  }

  unprotect(resp: Uint8Array): { data: Uint8Array; sw: number } {
    if (resp.length < 2) throw new Error('short response');
    const status = sw(resp);
    const body = resp.subarray(0, resp.length - 2);
    if (!body.length) return { data: new Uint8Array(0), sw: status };
    this.incSsc();
    let o = 0, do87: Uint8Array | undefined, do99: Uint8Array | undefined, mac: Uint8Array | undefined;
    let macInputEnd = 0;
    while (o < body.length) {
      const start = o;
      const t = readTlv(body, o);
      if (t.tag === 0x87) do87 = body.subarray(start, t.end), (do87 as any)._v = t.value;
      else if (t.tag === 0x99) do99 = body.subarray(start, t.end);
      else if (t.tag === 0x8e) { mac = t.value; macInputEnd = start; }
      o = t.end;
    }
    if (!mac) throw new Error('secure messaging: missing MAC');
    const expected = retailMac(this.ksMac, pad(concat(this.ssc, body.subarray(0, macInputEnd))));
    if (!equalBytes(expected, mac)) throw new Error('secure messaging: MAC mismatch');
    let data = new Uint8Array(0);
    if (do87) data = unpad(new TripleDes(this.ksEnc).cbcDecrypt(((do87 as any)._v as Uint8Array).subarray(1)));
    const status2 = do99 ? (do99[2] << 8) | do99[3] : status;
    return { data, sw: status2 };
  }
}

export async function performBac(tx: Transceive, keys: BacKeys): Promise<SecureMessaging> {
  const ch = await tx(Uint8Array.of(0x00, 0x84, 0x00, 0x00, 0x08));
  if (sw(ch) !== 0x9000) throw new Error('GET CHALLENGE failed: ' + sw(ch).toString(16));
  const rndIcc = ch.subarray(0, 8);
  return completeBac(tx, keys, rndIcc, randomBytes(8), randomBytes(16));
}

export async function completeBac(tx: Transceive, keys: BacKeys, rndIcc: Uint8Array, rndIfd: Uint8Array, kIfd: Uint8Array): Promise<SecureMessaging> {
  const des = new TripleDes(keys.kEnc);
  const eIfd = des.cbcEncrypt(concat(rndIfd, rndIcc, kIfd));
  const mIfd = retailMac(keys.kMac, pad(eIfd));
  const cmd = concat(Uint8Array.of(0x00, 0x82, 0x00, 0x00, 0x28), eIfd, mIfd, Uint8Array.of(0x28));
  const r = await tx(cmd);
  if (sw(r) !== 0x9000 || r.length < 42) throw new Error('BAC failed (wrong MRZ data?) SW=' + sw(r).toString(16));
  const eIcc = r.subarray(0, 32), mIcc = r.subarray(32, 40);
  if (!equalBytes(retailMac(keys.kMac, pad(eIcc)), mIcc)) throw new Error('BAC: chip MAC invalid');
  const plain = des.cbcDecrypt(eIcc);
  if (!equalBytes(plain.subarray(0, 8), rndIcc) || !equalBytes(plain.subarray(8, 16), rndIfd)) throw new Error('BAC: challenge mismatch');
  const kIcc = plain.subarray(16, 32);
  const seed = kIfd.map((b, i) => b ^ kIcc[i]);
  return new SecureMessaging(deriveKey(seed, 1), deriveKey(seed, 2), concat(rndIcc.subarray(4, 8), rndIfd.subarray(4, 8)));
}

export const FILES = { COM: 0x011e, DG1: 0x0101, DG2: 0x0102, SOD: 0x011d } as const;
export const LDS_AID = fromHex('A0000002471001');

async function sm(tx: Transceive, s: SecureMessaging, cla: number, ins: number, p1: number, p2: number, data?: Uint8Array, le?: number) {
  const raw = await tx(s.protect(cla, ins, p1, p2, data, le));
  return s.unprotect(raw);
}

export async function selectLdsApplication(tx: Transceive) {
  const r = await tx(concat(Uint8Array.of(0x00, 0xa4, 0x04, 0x0c, LDS_AID.length), LDS_AID));
  if (sw(r) !== 0x9000) throw new Error('LDS application not found');
}

export async function readFile(tx: Transceive, s: SecureMessaging, fileId: number, onProgress?: (done: number, total: number) => void): Promise<Uint8Array> {
  const sel = await sm(tx, s, 0x00, 0xa4, 0x02, 0x0c, be(fileId));
  if (sel.sw !== 0x9000) throw new Error(`SELECT ${fileId.toString(16)} failed: ${sel.sw.toString(16)}`);
  const head = await sm(tx, s, 0x00, 0xb0, 0, 0, undefined, 4);
  if (head.sw !== 0x9000) throw new Error('READ BINARY failed');
  // total length = header bytes + value length (BER)
  const h = head.data;
  let hdr = 2, len = h[1];
  if (len === 0x81) { hdr = 3; len = h[2]; } else if (len === 0x82) { hdr = 4; len = (h[2] << 8) | h[3]; }
  const total = hdr + len;
  const out = new Uint8Array(total);
  out.set(h.subarray(0, Math.min(4, total)));
  let off = Math.min(4, total);
  while (off < total) {
    const n = Math.min(0xdf, total - off);
    const chunk = await sm(tx, s, 0x00, 0xb0, off >> 8, off & 0xff, undefined, n);
    if (chunk.sw !== 0x9000 && chunk.sw !== 0x6282) throw new Error('READ BINARY failed at ' + off);
    out.set(chunk.data, off); off += chunk.data.length;
    if (!chunk.data.length) throw new Error('READ BINARY returned no data');
    onProgress?.(off, total);
  }
  return out;
}

export interface PassportRead { dg1: Uint8Array; dg2: Uint8Array; sod: Uint8Array }

export async function readPassport(tx: Transceive, mrz: { documentNumber: string; birthYYMMDD: string; expiryYYMMDD: string }, onProgress?: (stage: string, done?: number, total?: number) => void): Promise<PassportRead> {
  await selectLdsApplication(tx);
  onProgress?.('bac');
  const s = await performBac(tx, deriveBacKeys(bacKeySeed(mrz.documentNumber, mrz.birthYYMMDD, mrz.expiryYYMMDD)));
  onProgress?.('dg1');
  const dg1 = await readFile(tx, s, FILES.DG1);
  const sod = await readFile(tx, s, FILES.SOD);
  const dg2 = await readFile(tx, s, FILES.DG2, (d, t) => onProgress?.('dg2', d, t));
  return { dg1, dg2, sod };
}

/** Pull the "MRZ" text out of DG1 (tag 61 -> 5F1F) */
export function dg1ToMrzLines(dg1: Uint8Array): string[] {
  const outer = readTlv(dg1, 0);
  const inner = readTlv(outer.value, 0);
  const text = String.fromCharCode(...inner.value);
  const size = text.length === 90 ? 30 : text.length === 72 ? 36 : 44;
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += size) lines.push(text.slice(i, i + size));
  return lines;
}

/** Locate the embedded face image (JPEG / JPEG2000) in DG2 */
export function extractFaceImage(dg2: Uint8Array): { data: Uint8Array; mime: 'image/jpeg' | 'image/jp2' } | null {
  const find = (sig: number[]) => { for (let i = 0; i + sig.length <= dg2.length; i++) { if (sig.every((v, j) => dg2[i + j] === v)) return i; } return -1; };
  const jp2 = find([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20]);
  if (jp2 >= 0) return { data: dg2.subarray(jp2), mime: 'image/jp2' };
  const j2k = find([0xff, 0x4f, 0xff, 0x51]);
  if (j2k >= 0) return { data: dg2.subarray(j2k), mime: 'image/jp2' };
  const jpg = find([0xff, 0xd8, 0xff]);
  if (jpg >= 0) return { data: dg2.subarray(jpg), mime: 'image/jpeg' };
  return null;
}
