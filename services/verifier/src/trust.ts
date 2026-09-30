import { Cert, parseCert } from '@mosipid/core';

export interface AnchorInfo { id: string; name: string; use: string; pem: string; subject?: string; notAfter?: string; source?: string }

export class TrustService {
  private anchors: AnchorInfo[] = [];
  private fetchedAt = 0;
  constructor(private issuerUrls: string[], private staticPems: Record<string, string> = {}) {}

  async list(force = false): Promise<AnchorInfo[]> {
    if (!force && Date.now() - this.fetchedAt < 5 * 60_000 && this.anchors.length) return this.anchors;
    const merged = new Map<string, AnchorInfo>();
    for (const [id, pem] of Object.entries(this.staticPems)) if (pem) merged.set(id, { id, name: id, use: id === 'iaca' ? 'mdoc-identity' : 'sd-jwt-education', pem });
    for (const url of this.issuerUrls) {
      try {
        const r = await fetch(`${url}/api/trust`, { signal: AbortSignal.timeout(6000) });
        if (r.ok) for (const a of (await r.json()).anchors as AnchorInfo[]) merged.set(a.id, a);
      } catch (e) { console.warn('[trust] could not reach issuer', url, (e as Error).message); }
    }
    if (merged.size) { this.anchors = [...merged.values()]; this.fetchedAt = Date.now(); }
    return this.anchors;
  }

  async certs(id: string): Promise<Cert[]> {
    return (await this.list()).filter((a) => a.id === id).map((a) => parseCert(a.pem));
  }
}
