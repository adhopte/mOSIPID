// noble needs crypto.getRandomValues; Expo SDK 57 provides it via expo-crypto (added below when not present natively).
import * as Crypto from 'expo-crypto';
const g: any = globalThis;
if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) g.crypto.getRandomValues = (a: Uint8Array) => Crypto.getRandomValues(a as any);
