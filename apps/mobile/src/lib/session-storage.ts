import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const INSTANCE_URL_KEY = 'tavern.mobile.instanceUrl';
const REFRESH_TOKEN_KEY = 'tavern.mobile.refreshToken';
const ACCESS_EXP_KEY = 'tavern.mobile.accessExpiresAt';
const SECRET_FALLBACK_PREFIX = 'tavern.mobile.insecureSecret.';

let secureStoreAvailable: Promise<boolean> | null = null;

export interface StoredSession {
  instanceUrl: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: string | null;
}

export async function readStoredSession(): Promise<StoredSession> {
  const [instanceUrl, refreshToken, accessTokenExpiresAt] = await Promise.all([
    AsyncStorage.getItem(INSTANCE_URL_KEY),
    readSecret(REFRESH_TOKEN_KEY),
    AsyncStorage.getItem(ACCESS_EXP_KEY),
  ]);
  return { instanceUrl, refreshToken, accessTokenExpiresAt };
}

export async function writeInstanceUrl(instanceUrl: string): Promise<void> {
  await AsyncStorage.setItem(INSTANCE_URL_KEY, instanceUrl);
}

export async function writeRefreshToken(refreshToken: string): Promise<void> {
  await writeSecret(REFRESH_TOKEN_KEY, refreshToken);
}

export async function writeAccessExpiry(accessTokenExpiresAt: string): Promise<void> {
  await AsyncStorage.setItem(ACCESS_EXP_KEY, accessTokenExpiresAt);
}

export async function clearStoredSession(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(INSTANCE_URL_KEY),
    AsyncStorage.removeItem(ACCESS_EXP_KEY),
    deleteSecret(REFRESH_TOKEN_KEY),
  ]);
}

export async function clearStoredTokens(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(ACCESS_EXP_KEY),
    deleteSecret(REFRESH_TOKEN_KEY),
  ]);
}

async function isSecureStoreAvailable(): Promise<boolean> {
  secureStoreAvailable ??= SecureStore.isAvailableAsync().catch(() => false);
  return secureStoreAvailable;
}

async function readSecret(key: string): Promise<string | null> {
  if (await isSecureStoreAvailable()) return SecureStore.getItemAsync(key);
  return AsyncStorage.getItem(`${SECRET_FALLBACK_PREFIX}${key}`);
}

async function writeSecret(key: string, value: string): Promise<void> {
  if (await isSecureStoreAvailable()) {
    await SecureStore.setItemAsync(key, value);
    return;
  }
  await AsyncStorage.setItem(`${SECRET_FALLBACK_PREFIX}${key}`, value);
}

async function deleteSecret(key: string): Promise<void> {
  if (await isSecureStoreAvailable()) {
    await SecureStore.deleteItemAsync(key);
    return;
  }
  await AsyncStorage.removeItem(`${SECRET_FALLBACK_PREFIX}${key}`);
}
