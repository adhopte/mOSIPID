import { encode, decode, Tagged } from './cbor';
import { es256Sign, es256Verify, Jwk, jwkToPoint, pointToJwk } from './keys';
import { b64u } from './bytes';

export const coseKeyFromJwk = (jwk: Jwk) =>
  new Map<number, unknown>([[1, 2], [-1, 1], [-2, b64u.decode(jwk.x)], [-3, b64u.decode(jwk.y)]]);

export function jwkFromCoseKey(k: unknown): Jwk {
  const m = k as Map<number, Uint8Array>;
  const x = m.get(-2)!, y = m.get(-3)!;
  return pointToJwk(new Uint8Array([4, ...x, ...y]));
}

const sigStructure = (protectedBytes: Uint8Array, payload: Uint8Array) =>
  encode(['Signature1', protectedBytes, new Uint8Array(0), payload]);

/** COSE_Sign1 with ES256. `detached` omits the payload from the message. */
export function sign1(payload: Uint8Array, priv: Uint8Array, unprotected: Map<number, unknown> = new Map(), detached = false): unknown[] {
  const prot = encode(new Map([[1, -7]]));
  const sig = es256Sign(sigStructure(prot, payload), priv);
  return [prot, unprotected, detached ? null : payload, sig];
}

export function verify1(msg: unknown, pubPoint: Uint8Array, detachedPayload?: Uint8Array): boolean {
  if (!Array.isArray(msg) || msg.length !== 4) return false;
  const [prot, , payload, sig] = msg as [Uint8Array, unknown, Uint8Array | null, Uint8Array];
  const p = payload ?? detachedPayload;
  if (!p) return false;
  const alg = (decode(prot) as Map<number, number>).get(1);
  if (alg !== -7) return false;
  return es256Verify(sig, sigStructure(prot, p), pubPoint);
}
export { jwkToPoint, Tagged };
