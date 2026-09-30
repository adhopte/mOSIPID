// Proximity presentation (ISO 18013-5 flow) over a pluggable transport.
// The default RelayTransport moves the *encrypted* SessionEstablishment/SessionData messages through a
// mailbox on the verifier backend; a BLE transport can implement the same interface for true offline use.
import { b64u, toBase64 } from './bytes';
import { encode, decode, mget, Tagged, encodeTag24 } from './cbor';
import { buildDeviceEngagement, parseDeviceEngagement, SecureSession, DeviceEngagement } from './session';
import { generateKeyPair, KeyPair, Jwk } from './keys';
import { coseKeyFromJwk, jwkFromCoseKey } from './cose';
import { buildDeviceRequest, parseDeviceRequest, buildDeviceResponse, proximityTranscript, verifyDeviceResponse, RequestedItems, VerifyResult } from './mdoc';
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
  async waitForRequest(timeoutMs = 120_000): Promise<RequestedItems> {
    const msg = await this.transport.receive(timeoutMs);
    if (!msg) throw new ProtocolError('timed out waiting for verifier', 'timeout');
    const m = decode(msg);
    this.readerKey = jwkFromCoseKey(decode((mget(m, 'eReaderKey') as Tagged).value as Uint8Array));
    this.transcript = proximityTranscript(this.engagement.bytes, this.readerKey);
    this.session = new SecureSession(this.eDevice.privateKey, this.readerKey, this.transcript, 'device');
    return parseDeviceRequest(this.session.decrypt(mget(m, 'data') as Uint8Array));
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
  static async request(engagementQr: string, wanted: RequestedItems, opts: { f?: FetchLike; timeoutMs?: number; trustAnchors: Cert[]; now?: Date; requireDsEku?: boolean }): Promise<VerifyResult> {
    const eng = engagementFromQr(engagementQr);
    if (!eng.relay) throw new ProtocolError('engagement has no supported retrieval method', 'unsupported_transport');
    const eReader = generateKeyPair();
    const transcript = proximityTranscript(eng.bytes, eReader.publicJwk);
    const session = new SecureSession(eReader.privateKey, eng.eDeviceKey, transcript, 'reader');
    const transport = new RelayTransport(eng.relay.url, eng.relay.sessionId, 'toDevice', 'toReader', opts.f);
    await transport.send(encode(new Map<string, unknown>([
      ['eReaderKey', encodeTag24(coseKeyFromJwk(eReader.publicJwk))],
      ['data', session.encrypt(buildDeviceRequest(wanted))],
    ])));
    const msg = await transport.receive(opts.timeoutMs ?? 120_000);
    if (!msg) return { ok: false, error: 'holder did not respond' };
    const data = mget<Uint8Array>(decode(msg), 'data');
    if (!data) return { ok: false, error: 'holder declined the request' };
    return verifyDeviceResponse(session.decrypt(data), { sessionTranscript: transcript, trustAnchors: opts.trustAnchors, now: opts.now, requireDsEku: opts.requireDsEku });
  }
}
void toBase64;
