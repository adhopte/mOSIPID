import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { fromBase64, toBase64, randomBytes, utf8 } from '@mosipid/core';

export const PIN_LENGTH = 6;
const PIN_KEY = 'wallet.pin.v1';
const FAIL_KEY = 'wallet.pin.fail.v1';
const ITER = 30_000;

export interface SecuritySettings { pin: boolean; bio: boolean; lockOnStart: boolean; bioAvailable: boolean }

const opt = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const derive = (pin: string, salt: Uint8Array) => pbkdf2(sha256, utf8(pin), salt, { c: ITER, dkLen: 32 });
const same = (a: Uint8Array, b: Uint8Array) => { let d = a.length ^ b.length; for (let i = 0; i < a.length; i++) d |= a[i] ^ (b[i] ?? 0); return d === 0; };

export async function bioAvailable(): Promise<boolean> {
  try { return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync()); } catch { return false; }
}

export async function loadSecurity(): Promise<SecuritySettings> {
  const [pin, bio, lock, avail] = await Promise.all([SecureStore.getItemAsync(PIN_KEY), AsyncStorage.getItem('lock.bio'), AsyncStorage.getItem('appLock'), bioAvailable()]);
  return { pin: !!pin, bio: bio === '1' && avail, lockOnStart: lock === '1', bioAvailable: avail };
}
export const setBioEnabled = (on: boolean) => AsyncStorage.setItem('lock.bio', on ? '1' : '0');
export const setLockOnStart = (on: boolean) => AsyncStorage.setItem('appLock', on ? '1' : '0');

export async function setPin(pin: string) {
  const salt = randomBytes(16);
  await SecureStore.setItemAsync(PIN_KEY, JSON.stringify({ s: toBase64(salt), h: toBase64(derive(pin, salt)), c: ITER }), opt);
  await SecureStore.deleteItemAsync(FAIL_KEY);
}
export async function clearPin() { await SecureStore.deleteItemAsync(PIN_KEY); await SecureStore.deleteItemAsync(FAIL_KEY); }

/** Milliseconds the PIN pad stays locked after repeated wrong entries (30 s doubling from the 5th miss, max 1 h). */
export async function lockedForMs(): Promise<number> {
  try { const f = JSON.parse((await SecureStore.getItemAsync(FAIL_KEY)) ?? 'null'); return f?.until ? Math.max(0, f.until - Date.now()) : 0; } catch { return 0; }
}

export type PinResult = { ok: true } | { ok: false; left: number; lockedMs: number };
export async function verifyPin(pin: string): Promise<PinResult> {
  const wait = await lockedForMs();
  if (wait > 0) return { ok: false, left: 0, lockedMs: wait };
  const raw = await SecureStore.getItemAsync(PIN_KEY);
  if (!raw) return { ok: true };
  const r = JSON.parse(raw);
  const good = same(derive(pin, fromBase64(r.s)), fromBase64(r.h));
  if (good) { await SecureStore.deleteItemAsync(FAIL_KEY); return { ok: true }; }
  let count = 1;
  try { count = (JSON.parse((await SecureStore.getItemAsync(FAIL_KEY)) ?? 'null')?.count ?? 0) + 1; } catch { /* first miss */ }
  const lockedMs = count >= 5 ? Math.min(3_600_000, 30_000 * 2 ** (count - 5)) : 0;
  await SecureStore.setItemAsync(FAIL_KEY, JSON.stringify({ count, until: lockedMs ? Date.now() + lockedMs : 0 }), opt);
  return { ok: false, left: Math.max(0, 5 - count), lockedMs };
}

/** Phone biometrics (fingerprint / face – whatever the manufacturer enrolled). With a wallet PIN the device PIN is NOT accepted as a bypass. */
export async function biometricPrompt(prompt: string, cancelLabel: string, allowDeviceFallback: boolean): Promise<boolean> {
  try {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: prompt, cancelLabel, disableDeviceFallback: !allowDeviceFallback });
    return r.success;
  } catch { return false; }
}
