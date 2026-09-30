import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const isLockEnabled = async () => (await AsyncStorage.getItem('appLock')) === '1';
export const setLockEnabled = (on: boolean) => AsyncStorage.setItem('appLock', on ? '1' : '0');

/** Biometric / device-PIN confirmation. Falls back to allowing the action if the device has no security enrolled. */
export async function authenticate(prompt: string): Promise<boolean> {
  try {
    if (!(await LocalAuthentication.hasHardwareAsync()) || !(await LocalAuthentication.isEnrolledAsync())) return true;
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: prompt, disableDeviceFallback: false });
    return r.success;
  } catch { return false; }
}
