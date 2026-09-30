// Trust anchors are synced when online and cached, so verification itself works offline afterwards.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Cert, parseCert } from '@mosipid/core';

interface Anchor { id: string; name: string; use: string; pem: string }
const KEY = 'trust.anchors.v1';

export async function syncTrust(verifierUrl: string): Promise<{ anchors: Anchor[]; syncedAt: string }> {
  const r = await fetch(`${verifierUrl}/api/trust`);
  if (!r.ok) throw new Error('trust list unavailable');
  const anchors = (await r.json()).anchors as Anchor[];
  const rec = { anchors, syncedAt: new Date().toISOString() };
  await AsyncStorage.setItem(KEY, JSON.stringify(rec));
  return rec;
}
export async function cachedTrust(): Promise<{ anchors: Anchor[]; syncedAt: string } | null> {
  try { const raw = await AsyncStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export const identityAnchors = (anchors: Anchor[]): Cert[] => anchors.filter((a) => a.use === 'mdoc-identity').map((a) => parseCert(a.pem));
