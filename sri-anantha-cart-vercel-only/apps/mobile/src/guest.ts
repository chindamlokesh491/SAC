import type { GuestCartItem } from '@sac/contracts';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';

/**
 * Guest cart, wishlist, PIN code and first-launch flags, kept in the app's private storage
 * until sign-in moves the cart and wishlist into the account. Nothing here is secret: prices
 * are never stored, and every line is re-priced by the server.
 */
const directory = Platform.OS === 'web' ? null : `${FileSystem.documentDirectory ?? ''}guest/`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function read(key: string): Promise<unknown> {
  try {
    if (!directory) { const text = globalThis.localStorage?.getItem(`sac.${key}`); return text ? JSON.parse(text) : null; }
    const info = await FileSystem.getInfoAsync(`${directory}${key}.json`);
    return info.exists ? JSON.parse(await FileSystem.readAsStringAsync(`${directory}${key}.json`)) : null;
  } catch { return null; }
}
async function write(key: string, value: unknown) {
  try {
    if (!directory) { if (value === null) globalThis.localStorage?.removeItem(`sac.${key}`); else globalThis.localStorage?.setItem(`sac.${key}`, JSON.stringify(value)); return; }
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true }).catch(() => undefined);
    if (value === null) await FileSystem.deleteAsync(`${directory}${key}.json`, { idempotent: true });
    else await FileSystem.writeAsStringAsync(`${directory}${key}.json`, JSON.stringify(value));
  } catch { /* best effort */ }
}

export async function readGuestCart(): Promise<GuestCartItem[]> {
  const raw = await read('cart');
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    const line = item as Partial<GuestCartItem>;
    if (typeof line.product_id !== 'string' || !UUID.test(line.product_id)) return [];
    if (line.variant_id != null && (typeof line.variant_id !== 'string' || !UUID.test(line.variant_id))) return [];
    const quantity = Math.floor(Number(line.quantity));
    return Number.isFinite(quantity) && quantity >= 1 ? [{ product_id: line.product_id, variant_id: line.variant_id ?? null, quantity: Math.min(quantity, 99) }] : [];
  }).slice(0, 50);
}
export const writeGuestCart = (items: GuestCartItem[] | null) => write('cart', items?.length ? items : null);

export async function readGuestWishlist(): Promise<string[]> {
  const raw = await read('wishlist');
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && UUID.test(id)).slice(0, 200) : [];
}
export const writeGuestWishlist = (ids: string[] | null) => write('wishlist', ids?.length ? ids : null);

export async function readPincode(): Promise<string> {
  const raw = await read('pincode');
  return typeof raw === 'string' && /^[1-9][0-9]{5}$/.test(raw) ? raw : '';
}
export const writePincode = (pin: string) => write('pincode', pin || null);

export async function readFlag(name: 'tour-done' | 'pin-asked'): Promise<boolean> { return (await read(name)) === true; }
export const writeFlag = (name: 'tour-done' | 'pin-asked') => write(name, true);
