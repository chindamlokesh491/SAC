'use client';

import { type GuestCartItem, type Quote, type QuoteLine, type User } from '@sac/contracts';
import { ApiRequestError } from '@sac/api-client';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { Modal } from '@sac/ui-web';

type Toast = { id: number; message: string; tone: 'info' | 'success' | 'error' };

type StoreContextValue = {
  user: User | null;
  ready: boolean;
  /** Priced by the server for both signed-in customers and guests. */
  cart: Quote | null;
  wishlist: Set<string>;
  pincode: string;
  setPincode: (value: string) => void;
  refreshUser: () => Promise<User | null>;
  refreshCart: () => Promise<void>;
  setCart: (quote: Quote) => void;
  lineFor: (productId: string, variantId?: string | null) => QuoteLine | undefined;
  addToCart: (productId: string, quantity?: number, variantId?: string | null) => Promise<boolean>;
  setQuantity: (productId: string, variantId: string | null, quantity: number) => Promise<boolean>;
  clearCart: () => Promise<void>;
  toggleWishlist: (productId: string) => Promise<void>;
  requireLogin: (next?: string) => boolean;
  /** Asks "Would you like to log out?" before signing out. */
  askSignOut: () => void;
  signOut: () => Promise<void>;
  toast: (message: string, tone?: Toast['tone']) => void;
};

const StoreContext = createContext<StoreContextValue | null>(null);

export function useStore() {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside <StoreProvider>');
  return value;
}

export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.') {
  if (error instanceof ApiRequestError) return error.message || fallback;
  return fallback;
}

// Guest cart and wishlist live in this browser only, until sign-in moves them to the account.
const GUEST_CART_KEY = 'sac-guest-cart';
const GUEST_WISHLIST_KEY = 'sac-guest-wishlist';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readJson<T>(key: string, fallback: T): T {
  try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}
function writeJson(key: string, value: unknown) {
  try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
/** Never trust what is in storage: keep only well-formed lines with sane quantities. */
function readGuestCart(): GuestCartItem[] {
  const raw = readJson<unknown>(GUEST_CART_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    const line = item as Partial<GuestCartItem>;
    if (typeof line.product_id !== 'string' || !UUID.test(line.product_id)) return [];
    if (line.variant_id != null && (typeof line.variant_id !== 'string' || !UUID.test(line.variant_id))) return [];
    const quantity = Math.floor(Number(line.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) return [];
    return [{ product_id: line.product_id, variant_id: line.variant_id ?? null, quantity: Math.min(quantity, 99) }];
  }).slice(0, 50);
}
function readGuestWishlist(): string[] {
  const raw = readJson<unknown>(GUEST_WISHLIST_KEY, []);
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && UUID.test(id)).slice(0, 200) : [];
}
const sameLine = (a: { product_id: string; variant_id?: string | null }, productId: string, variantId: string | null) => a.product_id === productId && (a.variant_id ?? null) === variantId;

export function StoreProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [cart, setCart] = useState<Quote | null>(null);
  const [wishlist, setWishlist] = useState<Set<string>>(new Set());
  const [pincode, setPincodeState] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const guestItems = useRef<GuestCartItem[]>([]);
  const userRef = useRef<User | null>(null);
  const pincodeRef = useRef('');
  const toastId = useRef(0);

  const toast = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current;
    setToasts(current => [...current.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts(current => current.filter(item => item.id !== id)), 3600);
  }, []);

  /** Prices the guest cart; drops lines for products that no longer exist. */
  const priceGuest = useCallback(async (items: GuestCartItem[]) => {
    const quote = await api.previewCart(items, /^[1-9][0-9]{5}$/.test(pincodeRef.current) ? pincodeRef.current : undefined);
    const known = new Set(quote.lines.map(line => `${line.product_id}:${line.variant_id ?? ''}`));
    const kept = items.filter(item => known.has(`${item.product_id}:${item.variant_id ?? ''}`));
    if (kept.length !== items.length) { guestItems.current = kept; writeJson(GUEST_CART_KEY, kept); }
    return quote;
  }, []);

  const refreshCart = useCallback(async () => {
    try { setCart(userRef.current ? await api.cart() : await priceGuest(guestItems.current)); } catch { setCart(null); }
  }, [priceGuest]);

  /** Moves anything collected as a guest into the account, once, right after sign-in. */
  const mergeGuest = useCallback(async () => {
    const items = readGuestCart();
    const saved = readGuestWishlist();
    let merged: Quote | null = null;
    if (items.length) {
      try {
        const result = await api.mergeCart(items);
        merged = result.data;
        writeJson(GUEST_CART_KEY, null); guestItems.current = [];
        if (result.adjusted.length) toast(`${result.adjusted.length} item${result.adjusted.length === 1 ? ' in your cart was' : 's in your cart were'} updated: ${result.adjusted[0]!.reason}`, 'info');
      } catch { /* keep the guest cart; it will be retried on the next visit */ }
    }
    if (saved.length) {
      try { await api.mergeWishlist(saved); writeJson(GUEST_WISHLIST_KEY, null); } catch { /* retried later */ }
    }
    return merged;
  }, [toast]);

  const refreshUser = useCallback(async () => {
    try {
      const me = await api.session();
      userRef.current = me;
      setUser(me);
      if (!me) {
        guestItems.current = readGuestCart();
        setWishlist(new Set(readGuestWishlist()));
        setCart(await priceGuest(guestItems.current).catch(() => null));
        return null;
      }
      const merged = await mergeGuest();
      const [quote, wish] = await Promise.all([merged ? Promise.resolve(merged) : api.cart().catch(() => null), api.wishlist().catch(() => null)]);
      setCart(quote);
      setWishlist(new Set(wish?.product_ids ?? []));
      return me;
    } catch {
      userRef.current = null;
      setUser(null);
      setCart(null);
      return null;
    } finally {
      setReady(true);
    }
  }, [mergeGuest, priceGuest]);

  useEffect(() => {
    try { pincodeRef.current = window.localStorage.getItem('sac-pincode') ?? ''; setPincodeState(pincodeRef.current); } catch { /* storage unavailable */ }
    void refreshUser();
  }, [refreshUser]);

  const setPincode = useCallback((value: string) => {
    setPincodeState(value);
    pincodeRef.current = value;
    try { window.localStorage.setItem('sac-pincode', value); } catch { /* storage unavailable */ }
    if (!userRef.current) void priceGuest(guestItems.current).then(setCart).catch(() => undefined);
  }, [priceGuest]);

  const requireLogin = useCallback((next?: string) => {
    if (user) return true;
    router.push(`/login?next=${encodeURIComponent(next ?? pathname ?? '/')}`);
    return false;
  }, [user, router, pathname]);

  const lineFor = useCallback((productId: string, variantId: string | null = null) => cart?.lines.find(line => sameLine(line, productId, variantId)), [cart]);

  /** Applies a guest change only if the server confirms the item can be sold in that quantity. */
  const tryGuest = useCallback(async (next: GuestCartItem[], productId: string, variantId: string | null) => {
    const quote = await priceGuest(next);
    const line = quote.lines.find(item => sameLine(item, productId, variantId));
    if (line?.issue === 'insufficient_stock') { toast(line.max_quantity > 0 ? `Only ${line.max_quantity} available` : 'This item is out of stock', 'error'); return false; }
    if (line?.issue === 'unavailable') { toast('This product is unavailable', 'error'); return false; }
    if (line?.issue === 'choose_variant') { toast('Please choose a pack size first', 'info'); return false; }
    guestItems.current = next;
    writeJson(GUEST_CART_KEY, next);
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
      const others = guestItems.current.filter(item => !sameLine(item, productId, variantId));
      const next = quantity <= 0 ? others : [...guestItems.current.map(item => sameLine(item, productId, variantId) ? { ...item, quantity } : item),
        ...(guestItems.current.some(item => sameLine(item, productId, variantId)) ? [] : [{ product_id: productId, variant_id: variantId, quantity }])];
      return await tryGuest(next, productId, variantId);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) { await refreshUser(); return false; }
      toast(errorMessage(error), 'error');
      await refreshCart();
      return false;
    }
  }, [cart, tryGuest, toast, refreshCart, refreshUser]);

  const addToCart = useCallback(async (productId: string, quantity = 1, variantId: string | null = null) => {
    try {
      if (userRef.current) {
        setCart(await api.addToCart(productId, quantity, variantId));
      } else {
        const current = guestItems.current.find(item => sameLine(item, productId, variantId))?.quantity ?? 0;
        const next = current
          ? guestItems.current.map(item => sameLine(item, productId, variantId) ? { ...item, quantity: current + quantity } : item)
          : [...guestItems.current, { product_id: productId, variant_id: variantId, quantity }];
        if (!(await tryGuest(next, productId, variantId))) return false;
      }
      toast('Added to cart', 'success');
      return true;
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) { await refreshUser(); return false; }
      toast(errorMessage(error), 'error');
      return false;
    }
  }, [tryGuest, toast, refreshUser]);

  const clearCart = useCallback(async () => {
    try {
      if (userRef.current) setCart(await api.clearCart());
      else { guestItems.current = []; writeJson(GUEST_CART_KEY, null); setCart(await priceGuest([])); }
    } catch (error) { toast(errorMessage(error), 'error'); }
  }, [priceGuest, toast]);

  const toggleWishlist = useCallback(async (productId: string) => {
    const saved = wishlist.has(productId);
    const next = new Set(wishlist);
    if (saved) next.delete(productId); else next.add(productId);
    setWishlist(next);
    if (!userRef.current) {
      writeJson(GUEST_WISHLIST_KEY, [...next]);
      toast(saved ? 'Removed from wishlist' : 'Saved to wishlist', 'success');
      return;
    }
    try {
      if (saved) await api.removeFromWishlist(productId); else await api.addToWishlist(productId);
      toast(saved ? 'Removed from wishlist' : 'Saved to wishlist', 'success');
    } catch (error) {
      setWishlist(wishlist);
      toast(errorMessage(error), 'error');
    }
  }, [wishlist, toast]);

  const signOut = useCallback(async () => {
    try { await api.logout(); } catch { /* session may already be gone */ }
    userRef.current = null;
    setUser(null);
    guestItems.current = [];
    setWishlist(new Set());
    setCart(await priceGuest([]).catch(() => null));
    router.replace('/login');
    router.refresh();
  }, [router, priceGuest]);
  const askSignOut = useCallback(() => setConfirmingSignOut(true), []);

  const value = useMemo<StoreContextValue>(() => ({
    user, ready, cart, wishlist, pincode, setPincode, refreshUser, refreshCart, setCart, lineFor, addToCart, setQuantity, clearCart, toggleWishlist, requireLogin, askSignOut, signOut, toast,
  }), [user, ready, cart, wishlist, pincode, setPincode, refreshUser, refreshCart, lineFor, addToCart, setQuantity, clearCart, toggleWishlist, requireLogin, askSignOut, signOut, toast]);

  return (
    <StoreContext.Provider value={value}>
      {children}
      {confirmingSignOut && (
        <Modal title="Log out?" onClose={() => setConfirmingSignOut(false)} footer={<>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirmingSignOut(false)}>Stay signed in</button>
          <button type="button" className="btn btn-primary" onClick={() => { setConfirmingSignOut(false); void signOut(); }}>Log out</button>
        </>}>
          <div className="modal-body"><p style={{ margin: 0 }}>Would you like to log out? Your cart and wishlist stay saved in your account.</p></div>
        </Modal>
      )}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map(item => (
          <div key={item.id} className={`toast ${item.tone}`}>
            {item.tone === 'error' ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
            {item.message}
          </div>
        ))}
      </div>
    </StoreContext.Provider>
  );
}
