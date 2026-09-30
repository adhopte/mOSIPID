import { Jwk, KeyPair } from '../keys';

export type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string>; headers?: any }>;
export const defaultFetch: FetchLike = (u, i) => (globalThis as any).fetch(u, i);

export class ProtocolError extends Error {
  constructor(message: string, public code = 'protocol_error', public status?: number, public body?: unknown) { super(message); }
}

export const FORMAT_MDOC = 'mso_mdoc';
export const FORMAT_SDJWT = 'dc+sd-jwt';

export interface StoredCredential {
  id: string;
  format: typeof FORMAT_MDOC | typeof FORMAT_SDJWT;
  configId: string;
  docType?: string;
  vct?: string;
  /** mdoc: base64url IssuerSigned CBOR; sd-jwt: compact SD-JWT */
  raw: string;
  /** hex of the holder binding private key (the wallet vault encrypts the whole record at rest) */
  devicePrivateKeyHex: string;
  devicePublicJwk: Jwk;
  issuer: string;
  issuerName?: string;
  brandingTenant?: string;
  title: string;
  addedAt: string;
  expiresAt?: string;
}

export const asKeyPair = (c: StoredCredential): KeyPair => ({
  privateKey: Uint8Array.from((c.devicePrivateKeyHex.match(/../g) ?? []).map((h) => parseInt(h, 16))),
  publicJwk: c.devicePublicJwk,
});

export function parseQuery(qs: string): Record<string, string> {
  const out: Record<string, string> = {};
  const q = qs.includes('?') ? qs.slice(qs.indexOf('?') + 1) : qs;
  for (const part of q.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, ' '));
    out[k] = i < 0 ? '' : decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
  }
  return out;
}

export const formBody = (o: Record<string, string | undefined>) =>
  Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`).join('&');
