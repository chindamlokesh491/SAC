'use client';

import { ApiRequestError } from '@sac/api-client';
import type { PartnerProfile } from '@sac/contracts';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';

type Toast = { id: number; message: string; tone: 'success' | 'error' | 'info' };
type PartnerContextValue = {
  profile: PartnerProfile | null;
  refreshProfile: () => Promise<void>;
  toast: (message: string, tone?: Toast['tone']) => void;
  signOut: () => Promise<void>;
};

const PartnerContext = createContext<PartnerContextValue | null>(null);

export function usePartner(): PartnerContextValue {
  const value = useContext(PartnerContext);
  if (!value) throw new Error('usePartner must be used inside PartnerProvider');
  return value;
}

export function partnerError(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (error instanceof ApiRequestError) return error.message || fallback;
  if (error instanceof TypeError) return 'No connection. Check your internet and try again.';
  return fallback;
}

/** Loads the signed-in delivery partner; any other session (or none) is sent to the partner sign-in page. */
export function PartnerProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const onLogin = pathname === '/partner/login';
  const [profile, setProfile] = useState<PartnerProfile | null>(null);
  const [checked, setChecked] = useState(onLogin);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current;
    setToasts(list => [...list, { id, message, tone }]);
    window.setTimeout(() => setToasts(list => list.filter(item => item.id !== id)), 4500);
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      setProfile(await api.partner.me());
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
        setProfile(null);
        router.replace(`/partner/login?next=${encodeURIComponent(pathname ?? '/partner')}`);
        return;
      }
      throw error;
    } finally { setChecked(true); }
  }, [router, pathname]);

  useEffect(() => { if (!onLogin) void refreshProfile().catch(() => undefined); }, [onLogin, refreshProfile]);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || process.env.NODE_ENV !== 'production') return;
    void navigator.serviceWorker.register('/partner-sw.js', { scope: '/partner' }).catch(() => undefined);
  }, []);

  const signOut = useCallback(async () => {
    try { await api.partner.logout(); } catch { /* the session may already be gone */ }
    setProfile(null);
    router.replace('/partner/login');
  }, [router]);

  const value = useMemo(() => ({ profile, refreshProfile, toast, signOut }), [profile, refreshProfile, toast, signOut]);

  return (
    <PartnerContext.Provider value={value}>
      {checked || onLogin ? children : <div className="partner"><p className="empty-state" role="status">Loading…</p></div>}
      <div className="partner-toast" aria-live="polite">
        {toasts.map(item => (
          <div key={item.id} className={`alert ${item.tone === 'error' ? 'alert-danger' : item.tone === 'success' ? 'alert-info' : 'alert-warning'}`} role={item.tone === 'error' ? 'alert' : 'status'} style={{ marginTop: 8, boxShadow: 'var(--shadow)' }}>
            {item.message}
          </div>
        ))}
      </div>
    </PartnerContext.Provider>
  );
}
