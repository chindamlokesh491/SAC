'use client';

import { formatPhone } from '@sac/shared';
import Script from 'next/script';
import { useEffect, useRef, useState } from 'react';
import { useAdmin } from '@/components/admin/AdminProvider';
import { ChangePasswordForm, ChangePhoneForm } from '@/components/admin/PasswordForms';

declare global { interface Window { google?: { accounts: { id: { initialize: (options: { client_id: string; callback: (response: { credential: string }) => void }) => void; renderButton: (element: HTMLElement, options: { theme: string; size: string; width: number; text: string }) => void } } } } }

export default function AdminAccountPage() {
  const { user, isAdmin, toast, refreshUser } = useAdmin();
  const googleButton = useRef<HTMLDivElement>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  const linkGoogle = async (credential: string) => {
    setGoogleBusy(true);
    try {
      const response = await fetch('/api/v1/auth/staff/google/link', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-sac-csrf': '1', 'x-sac-client': 'web' }, body: JSON.stringify({ id_token: credential }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? 'Could not link Google account');
      toast('Google account linked. You can use it next time you sign in.', 'success');
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not link Google account', 'error'); }
    finally { setGoogleBusy(false); }
  };
  const initializeGoogle = () => {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId || !googleButton.current || !window.google) return;
    window.google.accounts.id.initialize({ client_id: clientId, callback: response => void linkGoogle(response.credential) });
    googleButton.current.innerHTML = '';
    window.google.accounts.id.renderButton(googleButton.current, { theme: 'outline', size: 'large', width: 260, text: 'continue_with' });
  };
  useEffect(() => { if (window.google) initializeGoogle(); }, []);
  return (
    <>
      {process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID && <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onLoad={initializeGoogle} />}
      <div className="admin-page-head"><div><h1>My Account</h1><p>Your staff sign-in details.</p></div></div>
      <div className="form-layout">
        <div className="admin-form">
          <section className="form-section">
            <h2>Change password <small>Other devices are signed out when the password changes</small></h2>
            <ChangePasswordForm phone={user?.phone ?? null} onDone={() => toast('Password changed. Other devices were signed out.', 'success')} />
          </section>
          <section className="form-section">
            <h2>Change mobile number <small>Use the new number next time you sign in</small></h2>
            <ChangePhoneForm onDone={phone => { toast(`Sign-in number changed to ${formatPhone(phone)}`, 'success'); void refreshUser(); }} />
          </section>
        </div>
        <aside className="admin-form">
          <section className="form-section">
            <h2>Signed in as</h2>
            <p style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{formatPhone(user?.phone)}</p>
            <span className="badge badge-neutral" style={{ justifySelf: 'start' }}>{isAdmin ? 'Admin' : 'Operator'}</span>
            <h2>Google sign-in</h2>
            <p className="field-hint" style={{ margin: 0 }}>Link your verified Google account after signing in with your staff password. Google sign-in will then be available on the staff login page.</p>
            <div ref={googleButton} aria-label="Link Google account" />
            {googleBusy && <p className="field-hint">Verifying Google account…</p>}
            {!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID && <p className="field-hint">Configure NEXT_PUBLIC_GOOGLE_CLIENT_ID to enable Google linking.</p>}
            <p className="field-hint" style={{ margin: 0 }}>Forgot your password? The store owner can issue a new temporary password from the server console. Staff accounts sign in only with a password, never by SMS code.</p>
          </section>
        </aside>
      </div>
    </>
  );
}
