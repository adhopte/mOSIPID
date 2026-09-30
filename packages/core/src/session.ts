// ISO 18013-5 device engagement + session encryption (ECDH P-256 / HKDF / AES-256-GCM).
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';
import { hkdf } from '@noble/hashes/hkdf';
import { gcm } from '@noble/ciphers/aes';
import { concat, utf8, randomBytes } from './bytes';
import { encode, decode, mget, Tagged, encodeTag24 } from './cbor';
import { coseKeyFromJwk, jwkFromCoseKey } from './cose';
import { Jwk, jwkToPoint, generateKeyPair, KeyPair } from './keys';

/** Vendor-specific retrieval method used by this project's relay transport. */
export const RETRIEVAL_RELAY = -1;

export interface DeviceEngagement { bytes: Uint8Array; eDeviceKey: Jwk; relay?: { url: string; sessionId: string }; }

export function buildDeviceEngagement(eDevice: KeyPair, relay?: { url: string; sessionId: string }): DeviceEngagement {
  const security = [1, encodeTag24(coseKeyFromJwk(eDevice.publicJwk))];
  const m = new Map<number, unknown>([[0, '1.0'], [1, security]]);
  if (relay) m.set(2, [[RETRIEVAL_RELAY, 1, new Map<number, unknown>([[0, relay.url], [1, relay.sessionId]])]]);
  return { bytes: encode(m), eDeviceKey: eDevice.publicJwk, relay };
}

export function parseDeviceEngagement(bytes: Uint8Array): DeviceEngagement {
  const m = decode(bytes) as Map<number, any>;
  const sec = m.get(1) as [number, Tagged];
  const eDeviceKey = jwkFromCoseKey(decode(sec[1].value as Uint8Array));
  const ret = (m.get(2) as any[] | undefined)?.find((r) => r[0] === RETRIEVAL_RELAY);
  return { bytes, eDeviceKey, relay: ret ? { url: ret[2].get(0), sessionId: ret[2].get(1) } : undefined };
}

export type Role = 'reader' | 'device';

export class SecureSession {
  private skReader: Uint8Array; private skDevice: Uint8Array;
  private counters = { reader: 0, device: 0 };
  constructor(myPriv: Uint8Array, theirPublic: Jwk, sessionTranscript: unknown, public role: Role) {
    const shared = p256.getSharedSecret(myPriv, jwkToPoint(theirPublic), true).slice(1);
    const salt = sha256(encode(encodeTag24(sessionTranscript)));
    this.skReader = hkdf(sha256, shared, salt, utf8('SKReader'), 32);
    this.skDevice = hkdf(sha256, shared, salt, utf8('SKDevice'), 32);
  }
  private iv(sender: Role, counter: number) {
    const iv = new Uint8Array(12);
    // identifier: reader = 0x00000000 00000000, device = 0x00000000 00000001 (ISO 18013-5 9.1.1.5)
    iv[7] = sender === 'device' ? 1 : 0;
    new DataView(iv.buffer).setUint32(8, counter);
    return iv;
  }
  encrypt(plain: Uint8Array): Uint8Array {
    const key = this.role === 'reader' ? this.skReader : this.skDevice;
    const c = ++this.counters[this.role];
    return gcm(key, this.iv(this.role, c)).encrypt(plain);
  }
  decrypt(cipher: Uint8Array): Uint8Array {
    const other: Role = this.role === 'reader' ? 'device' : 'reader';
    const key = other === 'reader' ? this.skReader : this.skDevice;
    const c = ++this.counters[other];
    return gcm(key, this.iv(other, c)).decrypt(cipher);
  }
}

export { generateKeyPair, concat, randomBytes, mget };
