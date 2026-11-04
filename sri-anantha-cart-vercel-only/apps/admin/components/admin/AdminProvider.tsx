'use client';

import { type User } from '@sac/contracts';
import { ApiRequestError } from '@sac/api-client';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { ChangePasswordForm } from './PasswordForms';

export type Notifications = { pending_orders: number; return_requests: number; low_stock: number; payments_need_review: number; open_refunds: number };
type Toast = { id: number; message: string; tone: 'info' | 'success' | 'error' };

type AdminContextValue = {
  user: User | null;
  isAdmin: boolean;
  notifications: Notifications | null;
  refreshNotifications: () => Promise<void>;
  request: <T>(path: string, init?: Parameters<typeof api.request>[1]) => Promise<T>;
  toast: (message: string, tone?: Toast['tone']) => void;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
};

const AdminContext = createContext<AdminContextValue | null>(null);
export function useAdmin() {
  const value = useContext(AdminContext);
  if (!value) throw new Error('useAdmin must be used inside <AdminProvider>');
  return value;
}

export function adminError(error: unknown, fallback = 'Something went wrong') {
  if (error instanceof ApiRequestError) return error.message || fallback;
  return fallback;
}

export function AdminProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [checked, setChecked] = useState(false);
  const [notifications, setNotifications] = useState<Notifications | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const onLogin = pathname === '/admin/login';

  const toast = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current;
    setToasts(current => [...current.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts(current => current.filter(item => item.id !== id)), 3800);
  }, []);

  const request = useCallback(async <T,>(path: string, init?: Parameters<typeof api.request>[1]) => {
    try {
      return await api.request<T>(path, init);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'PASSWORD_CHANGE_REQUIRED') {
        setUser(current => current && { ...current, must_change_password: true });
        throw error;
      }
      if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403) && !onLogin) {
        setUser(null);
        router.replace(`/admin/login?next=${encodeURIComponent(pathname)}`);
      }
      throw error;
    }
  }, [router, pathname, onLogin]);

  const refreshNotifications = useCallback(async () => {
    try { setNotifications((await api.request<{ data: Notifications }>('/api/v1/admin/notifications')).data); } catch { /* shown elsewhere */ }
  }, []);

  useEffect(() => {
    void (async () => {
      const session = await api.session().catch(() => null);
      const staff = session && (session.role === 'admin' || session.role === 'operator') ? session : null;
      setUser(staff);
      setChecked(true);
      if (!staff && !onLogin) router.replace(`/admin/login?next=${encodeURIComponent(pathname)}`);
    })();
  // Re-check on every navigation into the admin area.
  }, [pathname, onLogin, router]);

  useEffect(() => {
    if (!user || user.must_change_password) return;
    void refreshNotifications();
    const timer = window.setInterval(() => void refreshNotifications(), 60_000);
    return () => window.clearInterval(timer);
  }, [user, refreshNotifications]);

  const refreshUser = useCallback(async () => {
    const session = await api.session().catch(() => null);
    setUser(session && (session.role === 'admin' || session.role === 'operator') ? session : null);
  }, []);

  const signOut = useCallback(async () => {
    try { await api.logout(); } catch { /* already signed out */ }
    setUser(null);
    router.replace('/admin/login');
  }, [router]);

  const value = useMemo<AdminContextValue>(() => ({ user, isAdmin: user?.role === 'admin', notifications, refreshNotifications, request, toast, signOut, refreshUser }),
    [user, notifications, refreshNotifications, request, toast, signOut, refreshUser]);

  return (
    <AdminContext.Provider value={value}>
      {onLogin ? children
        : checked && user?.must_change_password ? (
          <div className="admin-login">
            <div className="card">
              <img src="/brand/logo-full.webp" alt="Sri Anantha Cart" width={230} height={54} />
              <h1 style={{ fontSize: 24, textAlign: 'center' }}>Choose your password</h1>
              <p className="field-hint" style={{ textAlign: 'center', margin: 0 }}>You signed in with a temporary password. Set your own password to continue.</p>
              <ChangePasswordForm phone={user.phone} submitLabel="Save and continue" onDone={() => { toast('Password changed', 'success'); void refreshUser(); }} />
              <button type="button" className="btn btn-ghost" onClick={() => void signOut()}>Sign out</button>
            </div>
          </div>
        )
        : checked && user ? children
        : <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}><span className="spinner" style={{ color: 'var(--primary)' }} /></div>}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map(item => <div key={item.id} className={`toast ${item.tone}`}>{item.tone === 'error' ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}{item.message}</div>)}
      </div>
    </AdminContext.Provider>
  );
}
