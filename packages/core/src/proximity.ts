// Proximity presentation (ISO 18013-5 flow) over a pluggable transport.
// The default RelayTransport moves the *encrypted* SessionEstablishment/SessionData messages through a
// mailbox on the verifier backend; a BLE transport can implement the same interface for true offline use.
import { b64u, toBase64 } from './bytes';
import { encode, decode, mget, Tagged, encodeTag24 } from './cbor';
import { buildDeviceEngagement, parseDeviceEngagement, SecureSession, DeviceEngagement } from './session';
import { generateKeyPair, KeyPair, Jwk } from './keys';
import { coseKeyFromJwk, jwkFromCoseKey } from './cose';
import { buildDeviceRequest, parseDeviceRequest, buildDeviceResponse, proximityTranscript, verifyDeviceResponse, RequestedItems, VerifyResult } from './mdoc';
import { presentSdJwt, verifySdJwtPresentation, SdJwtResult } from './sdjwt';
import { randomId } from './bytes';
import { Cert } from './x509';
import { FetchLike, defaultFetch, ProtocolError, StoredCredential } from './wallet/common';

export interface Transport {
  send(msg: Uint8Array): Promise<void>;
  receive(timeoutMs: number): Promise<Uint8Array | null>;
  close?(): Promise<void>;
}

export class RelayTransport implements Transport {
  constructor(private base: string, private mailbox: string, private sendQueue: 'toDevice' | 'toReader', private recvQueue: 'toDevice' | 'toReader', private f: FetchLike = defaultFetch) {}
  async send(msg: Uint8Array) {
    const r = await this.f(`${this.base}/api/relay/${this.mailbox}/${this.sendQueue}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: b64u.encode(msg) }) });
    if (!r.ok) throw new ProtocolError('relay send failed', 'relay_failed', r.status);
  }
  async receive(timeoutMs: number) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = await this.f(`${this.base}/api/relay/${this.mailbox}/${this.recvQueue}?wait=20`);
      if (r.status === 404) throw new ProtocolError('mailbox expired', 'relay_expired', 404);
      if (r.ok) { const j = await r.json(); if (j.data) return b64u.decode(j.data); }
    }
    return null;
  }
}

export async function createMailbox(base: string, f: FetchLike = defaultFetch): Promise<string> {
  const r = await f(`${base}/api/relay`, { method: 'POST' });
  if (!r.ok) throw new ProtocolError('relay unavailable', 'relay_failed', r.status);
  return (await r.json()).id;
}

export const ENGAGEMENT_PREFIX = 'mdoc:';
export const engagementToQr = (e: DeviceEngagement) => ENGAGEMENT_PREFIX + b64u.encode(e.bytes);
export const engagementFromQr = (s: string) => parseDeviceEngagement(b64u.decode(s.replace(/^mdoc:/i, '')));

/**
 * Project extension (not in ISO 18013-5): an SD-JWT VC can be requested/presented over the same encrypted session.
 * The DeviceRequest map carries `x_sdjwt` = {vct, claims[], nonce, aud}; the holder answers with `{x_sdjwt: <sd-jwt+kb>}`.
 */
export interface SdJwtRequest { vct: string; claims: string[]; nonce: string; aud: string }
export interface ProximityRequest { mdoc: RequestedItems; sdjwt?: SdJwtRequest }

// -------------------------------------------------------------- holder (wallet) side
export class HolderProximity {
  private eDevice: KeyPair = generateKeyPair();
  engagement!: DeviceEngagement;
  private transport!: Transport;
  private session?: SecureSession;
  private transcript?: unknown;
  private readerKey?: Jwk;
  readonly deviceEngagementBytes!: Uint8Array;

  static async start(relayBase: string, f: FetchLike = defaultFetch) {
    const h = new HolderProximity();
    const mailbox = await createMailbox(relayBase, f);
    h.engagement = buildDeviceEngagement(h.eDevice, { url: relayBase, sessionId: mailbox });
    (h as any).deviceEngagementBytes = h.engagement.bytes;
    h.transport = new RelayTransport(relayBase, mailbox, 'toReader', 'toDevice', f);
    return h;
  }
  get qr() { return engagementToQr(this.engagement); }

  /** Wait for the reader's encrypted DeviceRequest */
  async waitForRequest(timeoutMs = 120_000): Promise<ProximityRequest> {
    const msg = await this.transport.receive(timeoutMs);
    if (!msg) throw new ProtocolError('timed out waiting for verifier', 'timeout');
    const m = decode(msg);
    this.readerKey = jwkFromCoseKey(decode((mget(m, 'eReaderKey') as Tagged).value as Uint8Array));
    this.transcript = proximityTranscript(this.engagement.bytes, this.readerKey);
    this.session = new SecureSession(this.eDevice.privateKey, this.readerKey, this.transcript, 'device');
    const bytes = this.session.decrypt(mget(m, 'data') as Uint8Array);
    const x = mget<any>(decode(bytes), 'x_sdjwt');
    return {
      mdoc: parseDeviceRequest(bytes),
      sdjwt: x ? { vct: mget<string>(x, 'vct')!, claims: mget<string[]>(x, 'claims') ?? [], nonce: mget<string>(x, 'nonce')!, aud: mget<string>(x, 'aud')! } : undefined,
    };
  }

  /** Answer an `x_sdjwt` request with a key-bound SD-JWT presentation. */
  async respondSdJwt(credential: StoredCredential, req: SdJwtRequest) {
    if (!this.session) throw new Error('no session');
    const { asKeyPair } = await import('./wallet/common');
    const pres = presentSdJwt(credential.raw, req.claims, asKeyPair(credential).privateKey, req.aud, req.nonce);
    await this.transport.send(encode(new Map<string, unknown>([['data', this.session.encrypt(encode(new Map([['x_sdjwt', pres]])))], ['status', 20]])));
  }

  async respond(matches: { credential: StoredCredential; requested: Record<string, string[]> }[]) {
    if (!this.session) throw new Error('no session');
    const { asKeyPair } = await import('./wallet/common');
    const resp = buildDeviceResponse({
      documents: matches.map((m) => ({ issuerSigned: b64u.decode(m.credential.raw), deviceKeyPriv: asKeyPair(m.credential).privateKey, requested: m.requested })),
      sessionTranscript: this.transcript,
    });
    await this.transport.send(encode(new Map<string, unknown>([['data', this.session.encrypt(resp)], ['status', 20]])));
  }
  async decline() {
    await this.transport.send(encode(new Map<string, unknown>([['status', 20]])));
  }
}

// -------------------------------------------------------------- reader (proximity verifier) side
export class ReaderProximity {
  private static async exchange(engagementQr: string, extra: { mdoc: RequestedItems; sdjwt?: Omit<SdJwtRequest, 'nonce' | 'aud'> }, o: { f?: FetchLike; timeoutMs?: number; relayBase?: string }) {
    const eng = engagementFromQr(engagementQr);
    if (!eng.relay) throw new ProtocolError('engagement has no supported retrieval method', 'unsupported_transport');
    const eReader = generateKeyPair();
    const transcript = proximityTranscript(eng.bytes, eReader.publicJwk);
    const session = new SecureSession(eReader.privateKey, eng.eDeviceKey, transcript, 'reader');
    const transport = new RelayTransport(o.relayBase ?? eng.relay.url, eng.relay.sessionId, 'toDevice', 'toReader', o.f);
    const req = decode(buildDeviceRequest(extra.mdoc)) as Map<string, unknown>;
    let sd: SdJwtRequest | undefined;
    if (extra.sdjwt) {
      sd = { ...extra.sdjwt, nonce: randomId(18), aud: 'proximity:' + randomId(9) };
      req.set('x_sdjwt', new Map<string, unknown>([['vct', sd.vct], ['claims', sd.claims], ['nonce', sd.nonce], ['aud', sd.aud]]));
    }
    await transport.send(encode(new Map<string, unknown>([
      ['eReaderKey', encodeTag24(coseKeyFromJwk(eReader.publicJwk))],
      ['data', session.encrypt(encode(req))],
    ])));
    const msg = await transport.receive(o.timeoutMs ?? 120_000);
    if (!msg) return { ok: false as const, error: 'holder did not respond' };
    const data = mget<Uint8Array>(decode(msg), 'data');
    if (!data) return { ok: false as const, error: 'holder declined the request' };
    return { ok: true as const, plain: session.decrypt(data), transcript, sd };
  }

  /** ISO 18013-5 mdoc request; verifies the DeviceResponse locally. */
  static async request(engagementQr: string, wanted: RequestedItems, opts: { f?: FetchLike; timeoutMs?: number; trustAnchors: Cert[]; now?: Date; requireDsEku?: boolean; relayBase?: string }): Promise<VerifyResult> {
    const x = await ReaderProximity.exchange(engagementQr, { mdoc: wanted }, opts);
    if (!x.ok) return { ok: false, error: x.error };
    return verifyDeviceResponse(x.plain, { sessionTranscript: x.transcript, trustAnchors: opts.trustAnchors, now: opts.now, requireDsEku: opts.requireDsEku });
  }

  /** Extension: request an SD-JWT VC (e.g. a degree) over the same encrypted session. */
  static async requestSdJwt(engagementQr: string, want: { vct: string; claims: string[] }, opts: { f?: FetchLike; timeoutMs?: number; trustAnchors: Cert[]; now?: Date; relayBase?: string }): Promise<SdJwtResult> {
    const x = await ReaderProximity.exchange(engagementQr, { mdoc: {}, sdjwt: want }, opts);
    if (!x.ok) return { ok: false, error: x.error };
    const pres = mget<string>(decode(x.plain), 'x_sdjwt');
    if (!pres || !x.sd) return { ok: false, error: 'holder has no matching credential' };
    return verifySdJwtPresentation(pres, { trustAnchors: opts.trustAnchors, aud: x.sd.aud, nonce: x.sd.nonce, now: opts.now, expectedVct: want.vct });
  }
}
void toBase64;
