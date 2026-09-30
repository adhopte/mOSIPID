// Credentials (including their holder-binding private keys) are AES-256-GCM encrypted at rest.
// The vault key lives in the platform keystore (Keychain / Android Keystore via expo-secure-store).
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { gcm } from '@noble/ciphers/aes';
import { fromBase64, toBase64, randomBytes, utf8, fromUtf8, StoredCredential } from '@mosipid/core';

const KEY_NAME = 'vault.key.v1';
const DATA = 'vault.data.v1';

async function vaultKey(): Promise<Uint8Array> {
  const existing = await SecureStore.getItemAsync(KEY_NAME);
  if (existing) return fromBase64(existing);
  const k = randomBytes(32);
  await SecureStore.setItemAsync(KEY_NAME, toBase64(k), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  return k;
}

export async function loadCredentials(): Promise<StoredCredential[]> {
  const raw = await AsyncStorage.getItem(DATA);
  if (!raw) return [];
  try {
    const buf = fromBase64(raw);
    const plain = gcm(await vaultKey(), buf.subarray(0, 12)).decrypt(buf.subarray(12));
    return JSON.parse(fromUtf8(plain));
  } catch { return []; }
}

export async function saveCredentials(list: StoredCredential[]) {
  const nonce = randomBytes(12);
  const ct = gcm(await vaultKey(), nonce).encrypt(utf8(JSON.stringify(list)));
  const out = new Uint8Array(12 + ct.length); out.set(nonce); out.set(ct, 12);
  await AsyncStorage.setItem(DATA, toBase64(out));
}

/** Generic encrypted-at-rest JSON blob (same AES-256-GCM vault key) – used for the activity history. */
export async function loadSealed<T>(name: string, fallback: T): Promise<T> {
  const raw = await AsyncStorage.getItem(name);
  if (!raw) return fallback;
  try {
    const buf = fromBase64(raw);
    return JSON.parse(fromUtf8(gcm(await vaultKey(), buf.subarray(0, 12)).decrypt(buf.subarray(12))));
  } catch { return fallback; }
}
export async function saveSealed(name: string, value: unknown) {
  const nonce = randomBytes(12);
  const ct = gcm(await vaultKey(), nonce).encrypt(utf8(JSON.stringify(value)));
  const out = new Uint8Array(12 + ct.length); out.set(nonce); out.set(ct, 12);
  await AsyncStorage.setItem(name, toBase64(out));
}
