import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface ServerConfig { adminUrl: string; issuerUrl: string; verifierUrl: string }
const extra = (Constants.expoConfig?.extra ?? {}) as Partial<ServerConfig>;

export const DEFAULT_SERVERS: ServerConfig = {
  adminUrl: process.env.EXPO_PUBLIC_ADMIN_URL ?? extra.adminUrl ?? 'http://10.0.2.2:3001',
  issuerUrl: process.env.EXPO_PUBLIC_ISSUER_URL ?? extra.issuerUrl ?? 'http://10.0.2.2:3002',
  verifierUrl: process.env.EXPO_PUBLIC_VERIFIER_URL ?? extra.verifierUrl ?? 'http://10.0.2.2:3003',
};

const KEY = 'config.servers';
export async function loadServers(): Promise<ServerConfig> {
  try { const raw = await AsyncStorage.getItem(KEY); if (raw) return { ...DEFAULT_SERVERS, ...JSON.parse(raw) }; } catch { /* defaults */ }
  return DEFAULT_SERVERS;
}
export async function saveServers(s: ServerConfig) { await AsyncStorage.setItem(KEY, JSON.stringify(s)); }
