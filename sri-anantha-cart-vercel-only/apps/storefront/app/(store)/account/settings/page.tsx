'use client';

import { ApiRequestError } from '@sac/api-client';
import { formatPhone } from '@sac/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { safeNextPath } from '@sac/shared';
import { GoogleButton } from '@/components/store/GoogleButton';
import { errorMessage, useStore } from '@/components/store/StoreProvider';
import { api } from '@/lib/api';

export default function SettingsPage() {
  const { user, refreshUser, toast, askSignOut } = useStore();
  const router = useRouter();
  const [onboarding, setOnboarding] = useState(false);
  const [next, setNext] = useState('/');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setName(user?.name ?? ''); setEmail(user?.email ?? ''); }, [user]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setOnboarding(params.get('onboarding') === '1');
    setNext(safeNextPath(params.get('next')));
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setErrors({});
    try {
      if (onboarding && !email.trim()) { setErrors({ email: 'Enter an email address or skip profile setup for now.' }); return; }
      await api.updateProfile({ display_name: name.trim(), email: email.trim() });
      await refreshUser(); toast('Profile updated', 'success');
      if (onboarding) router.replace(next);
    }
    catch (error) { setErrors(error instanceof ApiRequestError ? { ...error.fields, _: error.message } : { _: errorMessage(error) }); }
    finally { setBusy(false); }
  };
  const link = useCallback(async (idToken: string) => {
    try { await api.linkGoogle(idToken); await refreshUser(); toast('Google account linked', 'success'); }
    catch (error) { toast(errorMessage(error), 'error'); }
  }, [refreshUser, toast]);

  return (
    <>
      <div className="account-head"><h1>{onboarding ? 'Complete your profile' : 'Account Settings'}</h1></div>
      {onboarding && <p className="muted" style={{ maxWidth: 560 }}>Your Google details are prefilled when available. Add your name and email for a smoother checkout. You can skip this and complete it later.</p>}
      <form className="box" onSubmit={save} style={{ display: 'grid', gap: 14, maxWidth: 560 }} noValidate>
        <h2>Profile</h2>
        <label className="field"><span>Full name</span><input className="input" value={name} onChange={event => setName(event.target.value)} maxLength={100} autoComplete="name" />{errors.display_name && <span className="field-error">{errors.display_name}</span>}</label>
        <label className="field"><span>Email</span><input className="input" type="email" value={email} onChange={event => setEmail(event.target.value)} maxLength={254} autoComplete="email" />{errors.email && <span className="field-error">{errors.email}</span>}<span className="field-hint">Used for order receipts.</span></label>
        <div className="field"><span>Mobile number</span><input className="input" value={user?.phone ? formatPhone(user.phone) : 'Not added'} disabled /><span className="field-hint">Your mobile number is your sign-in ID.</span></div>
        {errors._ && <p className="alert alert-danger">{errors._}</p>}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><button type="submit" className="btn btn-primary" disabled={busy || name.trim().length === 0 || (onboarding && !email.trim())}>Save and continue</button>{onboarding && <button type="button" className="btn btn-ghost" onClick={() => router.replace(next)}>Skip for now</button>}</div>
      </form>
      <div className="box" style={{ marginTop: 16, maxWidth: 560 }}>
        <h2>Sign-in methods</h2>
        <p className="muted" style={{ marginTop: 0 }}>Mobile OTP {user?.phone ? '✓' : ''}{user?.google_linked ? ' · Google ✓' : ''}</p>
        {!user?.google_linked && process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID && <GoogleButton text="signin_with" onCredential={idToken => void link(idToken)} />}
      </div>
      <div className="box" style={{ marginTop: 16, maxWidth: 560 }}>
        <h2>Sign out</h2>
        <button type="button" className="btn btn-ghost" onClick={askSignOut}>Log out of this device</button>
      </div>
    </>
  );
}
