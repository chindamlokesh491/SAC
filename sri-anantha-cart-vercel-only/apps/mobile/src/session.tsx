import { type GuestCartItem, type Quote, type QuoteLine, type User } from '@sac/contracts';
import { ApiRequestError } from '@sac/api-client';
import { createNavigationContainerRef } from '@react-navigation/native';
import * as LocalAuthentication from 'expo-local-authentication';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { api, onUnauthorized } from './api';
import { colors, fonts } from './theme';
import { readGuestCart, readGuestWishlist, readPincode, writeGuestCart, writeGuestWishlist, writePincode } from './guest';
import { BIOMETRIC_KEY, secureStorage, TOKEN_KEY } from './storage';
import type { RootStackParamList } from './navigation-types';

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

type SessionValue = {
  ready: boolean;
  locked: boolean;
  user: User | null;
  /** Priced by the server for both signed-in customers and guests. */
  cart: Quote | null;
  wishlist: Set<string>;
  pincode: string;
  setPincode: (pin: string) => Promise<void>;
  biometricEnabled: boolean;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
  unlock: () => Promise<boolean>;
  setBiometric: (enabled: boolean) => Promise<boolean>;
  refreshUser: () => Promise<void>;
  refreshCart: () => Promise<void>;
  setCart: (quote: Quote) => void;
  lineFor: (productId: string, variantId?: string | null) => QuoteLine | undefined;
  addToCart: (productId: string, quantity?: number, variantId?: string | null) => Promise<boolean>;
  setQuantity: (productId: string, variantId: string | null, quantity: number) => Promise<boolean>;
  clearCart: () => Promise<void>;
  toggleWishlist: (productId: string) => Promise<void>;
  /** Sign-in is needed only to check out; opens the sign-in screen (then `next`) when signed out. */
  requireLogin: (next?: 'Checkout') => boolean;
  toast: (message: string, tone?: 'success' | 'error' | 'info') => void;
};

const SessionContext = createContext<SessionValue | null>(null);
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.') {
  if (error instanceof ApiRequestError) return error.message || fallback;
  if (error instanceof TypeError) return 'Cannot reach Sri Anantha Cart. Check your internet connection.';
  return fallback;
}

const sameLine = (a: { product_id: string; variant_id?: string | null }, productId: string, variantId: string | null) => a.product_id === productId && (a.variant_id ?? null) === variantId;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [cart, setCart] = useState<Quote | null>(null);
  const [wishlist, setWishlist] = useState<Set<string>>(new Set());
  const [pincode, setPincodeState] = useState('');
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [toastState, setToastState] = useState<{ message: string; tone: 'success' | 'error' | 'info' } | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userRef = useRef<User | null>(null);
  const guestItems = useRef<GuestCartItem[]>([]);
  const pincodeRef = useRef('');

  const toast = useCallback((message: string, tone: 'success' | 'error' | 'info' = 'info') => {
    setToastState({ message, tone });
    Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => setToastState(null)), 2600);
  }, [opacity]);

  /** Prices the guest cart on the server; lines for products that no longer exist are dropped. */
  const priceGuest = useCallback(async (items: GuestCartItem[]) => {
    const quote = await api.previewCart(items, pincodeRef.current || undefined);
    const known = new Set(quote.lines.map(line => `${line.product_id}:${line.variant_id ?? ''}`));
    const kept = items.filter(item => known.has(`${item.product_id}:${item.variant_id ?? ''}`));
    if (kept.length !== items.length) { guestItems.current = kept; void writeGuestCart(kept); }
    return quote;
  }, []);

  const loadGuest = useCallback(async () => {
    userRef.current = null;
    setUser(null);
    guestItems.current = await readGuestCart();
    setWishlist(new Set(await readGuestWishlist()));
    setCart(await priceGuest(guestItems.current).catch(() => null));
  }, [priceGuest]);

  /** Moves the guest cart and wishlist into the account right after sign-in. */
  const mergeGuest = useCallback(async () => {
    const items = await readGuestCart();
    const saved = await readGuestWishlist();
    let merged: Quote | null = null;
    if (items.length) {
      try {
        const result = await api.mergeCart(items);
        merged = result.data;
        guestItems.current = [];
        await writeGuestCart(null);
        if (result.adjusted.length) toast(`${result.adjusted.length} cart item${result.adjusted.length === 1 ? ' was' : 's were'} updated: ${result.adjusted[0]!.reason}`, 'info');
      } catch { /* kept on the device; retried next time */ }
    }
    if (saved.length) { try { await api.mergeWishlist(saved); await writeGuestWishlist(null); } catch { /* retried later */ } }
    return merged;
  }, [toast]);

  const loadSession = useCallback(async () => {
    try {
      const me = await api.me();
      userRef.current = me;
      setUser(me);
      const merged = await mergeGuest();
      const [quote, wish] = await Promise.all([merged ? Promise.resolve(merged) : api.cart().catch(() => null), api.wishlist().catch(() => null)]);
      setCart(quote);
      setWishlist(new Set(wish?.product_ids ?? []));
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) { await secureStorage.remove(TOKEN_KEY); await loadGuest(); }
    }
  }, [mergeGuest, loadGuest]);

  useEffect(() => {
    onUnauthorized(() => { void secureStorage.remove(TOKEN_KEY); void loadGuest(); });
    void (async () => {
      const [token, biometric, pin] = await Promise.all([secureStorage.get(TOKEN_KEY), secureStorage.get(BIOMETRIC_KEY), readPincode()]);
      pincodeRef.current = pin;
      setPincodeState(pin);
      const useBiometric = biometric === 'true';
      setBiometricEnabled(useBiometric);
      if (token && useBiometric) setLocked(true);
      else if (token) await loadSession();
      else await loadGuest();
      setReady(true);
    })();
  }, [loadSession, loadGuest]);

  const unlock = useCallback(async () => {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Sri Anantha Cart', cancelLabel: 'Use another way', disableDeviceFallback: false });
    if (!result.success) return false;
    setLocked(false);
    await loadSession();
    return true;
  }, [loadSession]);

  const setBiometric = useCallback(async (enabled: boolean) => {
    if (enabled) {
      const [hardware, enrolled] = await Promise.all([LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync()]);
      if (!hardware || !enrolled) { toast('Set up a fingerprint in your phone settings first', 'error'); return false; }
      const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Confirm fingerprint to enable' });
      if (!result.success) return false;
    }
    await secureStorage.set(BIOMETRIC_KEY, enabled ? 'true' : 'false');
    setBiometricEnabled(enabled);
    toast(enabled ? 'Fingerprint unlock enabled' : 'Fingerprint unlock turned off', 'success');
    return true;
  }, [toast]);

  const signIn = useCallback(async (token: string) => {
    await secureStorage.set(TOKEN_KEY, token);
    setLocked(false);
    await loadSession();
  }, [loadSession]);

  const signOut = useCallback(async () => {
    try { await api.logout(); } catch { /* local sign-out still proceeds */ }
    await secureStorage.remove(TOKEN_KEY);
    await secureStorage.remove(BIOMETRIC_KEY);
    setBiometricEnabled(false);
    setLocked(false);
    await loadGuest();
  }, [loadGuest]);

  const requireLogin = useCallback((next?: 'Checkout') => {
    if (userRef.current) return true;
    if (navigationRef.isReady()) navigationRef.navigate('Login', next ? { next } : undefined);
    return false;
  }, []);

  const setPincode = useCallback(async (pin: string) => {
    pincodeRef.current = pin;
    setPincodeState(pin);
    await writePincode(pin);
    if (!userRef.current) setCart(await priceGuest(guestItems.current).catch(() => null));
  }, [priceGuest]);

  const refreshCart = useCallback(async () => {
    try { setCart(userRef.current ? await api.cart() : await priceGuest(guestItems.current)); } catch { /* keep the last cart */ }
  }, [priceGuest]);
  const refreshUser = useCallback(async () => { await loadSession(); }, [loadSession]);

  const lineFor = useCallback((productId: string, variantId: string | null = null) => cart?.lines.find(line => sameLine(line, productId, variantId)), [cart]);

  /** Applies a guest change only when the server confirms the item can be sold in that quantity. */
  const tryGuest = useCallback(async (next: GuestCartItem[], productId: string, variantId: string | null) => {
    const quote = await priceGuest(next);
    const line = quote.lines.find(item => sameLine(item, productId, variantId));
    if (line?.issue === 'insufficient_stock') { toast(line.max_quantity > 0 ? `Only ${line.max_quantity} available` : 'This item is out of stock', 'error'); return false; }
    if (line?.issue === 'unavailable') { toast('This product is unavailable', 'error'); return false; }
    if (line?.issue === 'choose_variant') { toast('Please choose a pack size first', 'info'); return false; }
    guestItems.current = next;
    await writeGuestCart(next);
    setCart(quote);
    return true;
  }, [priceGuest, toast]);

  const setQuantity = useCallback(async (productId: string, variantId: string | null, quantity: number) => {
    try {
      if (userRef.current) {
        const line = cart?.lines.find(item => sameLine(item, productId, variantId));
        if (quantity <= 0) { if (line) setCart(await api.removeCartItem(line.cart_item_id)); }
        else setCart(await api.setCartQuantity(productId, quantity, variantId));
        return true;
      }
      const exists = guestItems.current.some(item => sameLine(item, productId, variantId));
      const next = quantity <= 0
        ? guestItems.current.filter(item => !sameLine(item, productId, variantId))
        : exists ? guestItems.current.map(item => (sameLine(item, productId, variantId) ? { ...item, quantity } : item)) : [...guestItems.current, { product_id: productId, variant_id: variantId, quantity }];
      return await tryGuest(next, productId, variantId);
    } catch (error) { toast(errorMessage(error), 'error'); await refreshCart(); return false; }
  }, [cart, tryGuest, toast, refreshCart]);

  const addToCart = useCallback(async (productId: string, quantity = 1, variantId: string | null = null) => {
    try {
      if (userRef.current) setCart(await api.addToCart(productId, quantity, variantId));
      else {
        const current = guestItems.current.find(item => sameLine(item, productId, variantId))?.quantity ?? 0;
        const next = current ? guestItems.current.map(item => (sameLine(item, productId, variantId) ? { ...item, quantity: current + quantity } : item)) : [...guestItems.current, { product_id: productId, variant_id: variantId, quantity }];
        if (!(await tryGuest(next, productId, variantId))) return false;
      }
      toast('Added to cart', 'success');
      return true;
    } catch (error) { toast(errorMessage(error), 'error'); return false; }
  }, [tryGuest, toast]);

  const clearCart = useCallback(async () => {
    try {
      if (userRef.current) setCart(await api.clearCart());
      else { guestItems.current = []; await writeGuestCart(null); setCart(await priceGuest([])); }
    } catch (error) { toast(errorMessage(error), 'error'); }
  }, [priceGuest, toast]);

  const toggleWishlist = useCallback(async (productId: string) => {
    const saved = wishlist.has(productId);
    const next = new Set(wishlist);
    if (saved) next.delete(productId); else next.add(productId);
    setWishlist(next);
    if (!userRef.current) { await writeGuestWishlist([...next]); toast(saved ? 'Removed from wishlist' : 'Saved to wishlist', 'success'); return; }
    try { if (saved) await api.removeFromWishlist(productId); else await api.addToWishlist(productId); }
    catch (error) { setWishlist(wishlist); toast(errorMessage(error), 'error'); }
  }, [wishlist, toast]);

  const value = useMemo<SessionValue>(() => ({
    ready, locked, user, cart, wishlist, pincode, setPincode, biometricEnabled, signIn, signOut, unlock, setBiometric, refreshUser, refreshCart, setCart,
    lineFor, addToCart, setQuantity, clearCart, toggleWishlist, requireLogin, toast,
  }), [ready, locked, user, cart, wishlist, pincode, setPincode, biometricEnabled, signIn, signOut, unlock, setBiometric, refreshUser, refreshCart,
    lineFor, addToCart, setQuantity, clearCart, toggleWishlist, requireLogin, toast]);

  return (
    <SessionContext.Provider value={value}>
      {children}
      {toastState && (
        <Animated.View pointerEvents="none" style={[styles.toast, { opacity, backgroundColor: toastState.tone === 'error' ? '#8f1d16' : toastState.tone === 'success' ? '#145c2a' : colors.ink }]} accessibilityLiveRegion="polite">
          <Text style={styles.toastText}>{toastState.message}</Text>
        </Animated.View>
      )}
    </SessionContext.Provider>
  );
}

const styles = StyleSheet.create({
  toast: { position: 'absolute', left: 20, right: 20, bottom: 96, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16 },
  toastText: { color: colors.white, fontFamily: fonts.medium, fontSize: 14, textAlign: 'center' },
});
