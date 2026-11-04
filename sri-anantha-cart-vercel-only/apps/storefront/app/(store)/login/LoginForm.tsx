'use client';

import { normalizeIndianMobile, formatPhone } from '@sac/shared';
import { ArrowRight } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { GoogleButton } from '@/components/store/GoogleButton';
import { errorMessage, useStore } from '@/components/store/StoreProvider';
import { api } from '@/lib/api';
import { safeNextPath } from '@sac/shared';

export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = safeNextPath(search.get('next'));
  const { user, ready, refreshUser, toast } = useStore();
  const didAuthenticate = useRef(false);
  const [phone, setPhone] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => { if (ready && user && !didAuthenticate.current) router.replace(next); }, [ready, user, next, router]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const finish = useCallback(async () => {
    didAuthenticate.current = true;
    const signedInUser = await refreshUser();
    toast('Signed in successfully', 'success');
    if (signedInUser && (!signedInUser.name?.trim() || !signedInUser.email?.trim())) {
      router.replace(`/account/settings?onboarding=1&next=${encodeURIComponent(next)}`);
      return;
    }
    router.replace(next);
  }, [refreshUser, toast, router, next]);

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    setError('');
    const normalized = normalizeIndianMobile(phone);
    if (!normalized) { setError('Enter a valid 10-digit mobile number'); return; }
    setBusy(true);
    try {
      const result = await api.requestOtp(normalized);
      setSentTo(normalized); setCode(''); setCooldown(result.resendAfterSeconds ?? 60);
    } catch (err) { setError(errorMessage(err, 'Could not send the code. Please try again.')); }
    finally { setBusy(false); }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (!sentTo) return;
    if (!/^\d{6}$/.test(code)) { setError('Enter the 6-digit code'); return; }
    setBusy(true); setError('');
    try { await api.verifyOtp(sentTo, code); await finish(); }
    catch (err) { setError(errorMessage(err, 'The code is invalid or expired')); }
    finally { setBusy(false); }
  };

  const google = useCallback(async (idToken: string) => {
    setError('');
    try { await api.googleSignIn(idToken); await finish(); }
    catch (err) { setError(errorMessage(err, 'Google sign-in failed')); }
  }, [finish]);

  return (
    <div className="auth-form">
      <div>
        <h1>{sentTo ? 'Verify your number' : 'Sign in or create account'}</h1>
        <p className="muted" style={{ margin: '6px 0 0' }}>{sentTo ? `Enter the 6-digit code sent to ${formatPhone(sentTo)}` : 'We will send a one-time code to your mobile number.'}</p>
      </div>
      {!sentTo ? (
        <form onSubmit={send} style={{ display: 'grid', gap: 14 }} noValidate>
          <label className="field">
            <span>Mobile number</span>
            <div className="phone-field">
              <span>+91</span>
              <input type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={10} placeholder="98765 43210" value={phone}
                onChange={event => setPhone(event.target.value.replace(/\D/g, '').slice(0, 10))} aria-invalid={Boolean(error)} autoFocus />
            </div>
          </label>
          {error && <p className="field-error" role="alert">{error}</p>}
          <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>{busy ? <span className="spinner" /> : <>Send OTP <ArrowRight size={18} /></>}</button>
        </form>
      ) : (
        <form onSubmit={verify} style={{ display: 'grid', gap: 14 }} noValidate>
          <label className="field">
            <span>One-time code</span>
            <input className="input otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
              onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} aria-invalid={Boolean(error)} autoFocus />
          </label>
          {error && <p className="field-error" role="alert">{error}</p>}
          <button className="btn btn-primary btn-lg" type="submit" disabled={busy || code.length !== 6}>{busy ? <span className="spinner" /> : 'Verify & Continue'}</button>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
            <button type="button" className="link-red" style={{ background: 'none', border: 0 }} onClick={() => { setSentTo(null); setError(''); }}>Change number</button>
            <button type="button" className="link-red" style={{ background: 'none', border: 0, opacity: cooldown > 0 ? .5 : 1 }} disabled={cooldown > 0 || busy} onClick={() => void send()}>
              {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
            </button>
          </div>
        </form>
      )}
      {process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID && !sentTo && (<><div className="divider">or</div><GoogleButton onCredential={idToken => void google(idToken)} /></>)}
      <p className="field-hint">By continuing you agree to our <a className="link-red" href="/terms">Terms</a> and <a className="link-red" href="/privacy">Privacy Policy</a>.</p>
    </div>
  );
}
