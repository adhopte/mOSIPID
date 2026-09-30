import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';
import { b64u, utf8, concat, fromUtf8 } from './bytes';

export interface Jwk { kty: 'EC'; crv: 'P-256'; x: string; y: string; d?: string; kid?: string; alg?: string; use?: string }
export interface KeyPair { privateKey: Uint8Array; publicJwk: Jwk }

export function generateKeyPair(): KeyPair {
  const privateKey = p256.utils.randomPrivateKey();
  return { privateKey, publicJwk: publicJwkFromPrivate(privateKey) };
}

export function publicJwkFromPrivate(priv: Uint8Array): Jwk {
  const pub = p256.getPublicKey(priv, false);
  return { kty: 'EC', crv: 'P-256', x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)) };
}

export function jwkToPoint(jwk: Jwk): Uint8Array {
  return concat(Uint8Array.of(4), b64u.decode(jwk.x), b64u.decode(jwk.y));
}
export function pointToJwk(pt: Uint8Array): Jwk {
  return { kty: 'EC', crv: 'P-256', x: b64u.encode(pt.slice(1, 33)), y: b64u.encode(pt.slice(33, 65)) };
}

/** RFC 7638 thumbprint */
export function jwkThumbprint(jwk: Jwk): string {
  return b64u.encode(sha256(utf8(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`)));
}

export function es256Sign(data: Uint8Array, priv: Uint8Array): Uint8Array {
  return p256.sign(sha256(data), priv).toCompactRawBytes();
}
export function es256Verify(sig: Uint8Array, data: Uint8Array, point: Uint8Array): boolean {
  try { return p256.verify(sig, sha256(data), point); } catch { return false; }
}

// ---- compact JWS (ES256 only) ----
export function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, priv: Uint8Array): string {
  const h = b64u.encode(utf8(JSON.stringify({ alg: 'ES256', ...header })));
  const p = b64u.encode(utf8(JSON.stringify(payload)));
  const sig = es256Sign(utf8(`${h}.${p}`), priv);
  return `${h}.${p}.${b64u.encode(sig)}`;
}

export interface ParsedJwt { header: any; payload: any; signingInput: string; signature: Uint8Array }
export function parseJwt(jwt: string): ParsedJwt {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const dec = (s: string) => JSON.parse(fromUtf8(b64u.decode(s)));
  return { header: dec(parts[0]), payload: dec(parts[1]), signingInput: `${parts[0]}.${parts[1]}`, signature: b64u.decode(parts[2]) };
}
export function verifyJwtWithJwk(jwt: string, jwk: Jwk): ParsedJwt {
  const p = parseJwt(jwt);
  if (p.header.alg !== 'ES256') throw new Error('unsupported JWT alg ' + p.header.alg);
  if (!es256Verify(p.signature, utf8(p.signingInput), jwkToPoint(jwk))) throw new Error('bad JWT signature');
  return p;
}
