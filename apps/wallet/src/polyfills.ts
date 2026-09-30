// Must be imported before anything from @mosipid/core: noble needs crypto.getRandomValues.
import * as Crypto from 'expo-crypto';
const g: any = globalThis;
if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) g.crypto.getRandomValues = (a: Uint8Array) => Crypto.getRandomValues(a as any);
