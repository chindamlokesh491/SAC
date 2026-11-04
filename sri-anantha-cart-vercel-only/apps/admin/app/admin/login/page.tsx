'use client';

import { normalizeIndianMobile } from '@sac/shared';
import { Eye, EyeOff } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import Script from 'next/script';
import { adminError } from '@/components/admin/AdminProvider';
import { api } from '@/lib/api';
import { safeNextPath } from '@sac/shared';

declare global { interface Window { google?: { accounts: { id: { initialize: (options: { client_id: string; callback: (response: { credential: string }) => void }) => void; renderButton: (element: HTMLElement, options: { theme: string; size: string; width: number; text: string }) => void } } } } }

function AdminLogin() {
  const router = useRouter();
  const next = safeNextPath(useSearchParams().get('next'), '/admin');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const googleButton = useRef<HTMLDivElement>(null);
  const handleGoogleCredential = async (credential: string) => {
    setError(''); setGoogleBusy(true);
    try {
      const response = await fetch('/api/v1/auth/staff/google', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-sac-client': 'web' }, body: JSON.stringify({ id_token: credential }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message ?? 'Google sign-in failed');
      router.replace(next.startsWith('/admin') && next !== '/admin/login' ? next : '/admin');
    } catch (err) { setError(err instanceof Error ? err.message : 'Google sign-in failed'); }
    finally { setGoogleBusy(false); }
  };
  const initializeGoogle = () => {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId || !googleButton.current || !window.google) return;
    window.google.accounts.id.initialize({ client_id: clientId, callback: response => void handleGoogleCredential(response.credential) });
    googleButton.current.innerHTML = '';
    window.google.accounts.id.renderButton(googleButton.current, { theme: 'outline', size: 'large', width: 320, text: 'continue_with' });
  };
  useEffect(() => { if (window.google) initializeGoogle(); }, []);

  const signIn = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    const normalized = normalizeIndianMobile(phone);
    if (!normalized) { setError('Enter a valid 10-digit mobile number'); return; }
    if (!password) { setError('Enter your password'); return; }
    setBusy(true);
    try {
      await api.staffLogin(normalized, password);
      // A temporary password is handled by the change-password screen in the admin layout.
      router.replace(next.startsWith('/admin') && next !== '/admin/login' ? next : '/admin');
    } catch (err) {
      setError(adminError(err, 'Mobile number or password is incorrect'));
      setPassword('');
    } finally { setBusy(false); }
  };

  return (
    <div className="admin-login">
      {process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID && <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onLoad={initializeGoogle} />}
      <div className="card">
        <img src="/brand/logo-full.webp" alt="Sri Anantha Cart" width={230} height={54} />
        <h1 style={{ fontSize: 24, textAlign: 'center' }}>Staff Sign In</h1>
        <form onSubmit={signIn} style={{ display: 'grid', gap: 14 }}>
          <label className="field"><span>Mobile number</span>
            <div className="phone-field"><span>+91</span><input id="staff-phone" type="tel" inputMode="numeric" autoComplete="username" maxLength={10} value={phone} onChange={event => setPhone(event.target.value.replace(/\D/g, ''))} autoFocus /></div>
          </label>
          <label className="field"><span>Password</span>
            <div className="password-field">
              <input id="staff-password" className="input" type={showPassword ? 'text' : 'password'} autoComplete="current-password" maxLength={128} value={password} onChange={event => setPassword(event.target.value)} />
              <button type="button" className="icon-btn" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button>
            </div>
          </label>
          {error && <p className="field-error" role="alert">{error}</p>}
          <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Signing in…' : 'Sign In'}</button>
        </form>
        <div style={{ display: 'grid', justifyItems: 'center', gap: 8, marginTop: 18 }}>
          <span className="field-hint">Or sign in with Google</span>
          <div ref={googleButton} aria-label="Continue with Google" />
          {googleBusy && <span className="field-hint">Verifying Google account…</span>}
          {!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID && <span className="field-hint">Google sign-in appears after the OAuth client ID is configured.</span>}
        </div>
        <p className="field-hint" style={{ textAlign: 'center' }}>Forgot your password? Ask the store owner to issue a new temporary password. Sessions expire after 12 hours.</p>
      </div>
    </div>
  );
}

export default function AdminLoginPage() { return <Suspense fallback={null}><AdminLogin /></Suspense>; }
