import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Session token storage. On Android the token lives in the Keystore-backed SecureStore.
 * The web build exists only for design previews/QA and keeps the token in sessionStorage.
 */
const isNative = Platform.OS !== 'web';
const memory = {
  get: (key: string) => { try { return globalThis.sessionStorage?.getItem(key) ?? undefined; } catch { return undefined; } },
  set: (key: string, value: string) => { try { globalThis.sessionStorage?.setItem(key, value); } catch { /* preview only */ } },
  delete: (key: string) => { try { globalThis.sessionStorage?.removeItem(key); } catch { /* preview only */ } },
};

export const secureStorage = {
  async get(key: string): Promise<string | null> {
    return isNative ? SecureStore.getItemAsync(key) : memory.get(key) ?? null;
  },
  async set(key: string, value: string): Promise<void> {
    if (isNative) await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    else memory.set(key, value);
  },
  async remove(key: string): Promise<void> {
    if (isNative) await SecureStore.deleteItemAsync(key);
    else memory.delete(key);
  },
};

export const TOKEN_KEY = 'sac.session.token';
export const BIOMETRIC_KEY = 'sac.biometric.enabled';
