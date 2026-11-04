import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';

/**
 * Offline catalogue cache: the last successfully loaded catalogue responses are kept on
 * the device so customers can browse without a connection. Prices/stock shown from the
 * cache are flagged as possibly outdated, and ordering always requires the live API.
 */
const directory = Platform.OS === 'web' ? null : `${FileSystem.documentDirectory ?? ''}catalogue-cache/`;
const memory = new Map<string, string>();

function fileFor(key: string) { return `${directory}${key.replace(/[^a-z0-9_-]/gi, '_')}.json`; }

export async function writeCache(key: string, value: unknown) {
  const text = JSON.stringify({ savedAt: Date.now(), value });
  if (!directory) { memory.set(key, text); return; }
  try {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true }).catch(() => undefined);
    await FileSystem.writeAsStringAsync(fileFor(key), text);
  } catch { /* caching is best-effort */ }
}

export async function readCache<T>(key: string): Promise<{ value: T; savedAt: number } | null> {
  try {
    const text = directory ? await FileSystem.readAsStringAsync(fileFor(key)) : memory.get(key);
    return text ? (JSON.parse(text) as { value: T; savedAt: number }) : null;
  } catch { return null; }
}

/** Live request first; on network failure fall back to the cached copy. */
export async function cached<T>(key: string, load: () => Promise<T>): Promise<{ data: T; offline: boolean }> {
  try {
    const data = await load();
    void writeCache(key, data);
    return { data, offline: false };
  } catch (error) {
    const hit = await readCache<T>(key);
    if (hit) return { data: hit.value, offline: true };
    throw error;
  }
}
