'use client';

import { normalizeIndianMobile, safeNextPath } from '@sac/shared';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { partnerError } from '@/components/partner/PartnerProvider';
import { api } from '@/lib/api';

function PartnerLogin() {
  const router = useRouter();
  const requested = safeNextPath(useSearchParams().get('next'), '/partner');
  const next = requested.startsWith('/partner') && requested !== '/partner/login' ? requested : '/partner';
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn(value => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  const sendCode = async (event?: FormEvent) => {
    event?.preventDefault(); setError('');
    const normalized = normalizeIndianMobile(phone);
    if (!normalized) { setError('Enter your 10-digit mobile number.'); return; }
    setBusy(true);
    try {
      const sent = await api.partner.requestOtp(normalized);
      setStage('code'); setCode(''); setResendIn(sent.resendAfterSeconds ?? 60);
    } catch (err) { setError(partnerError(err, 'Could not send the code.')); }
    finally { setBusy(false); }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (!/^\d{6}$/.test(code)) { setError('Enter the 6-digit code.'); return; }
    setBusy(true);
    try {
      await api.partner.verifyOtp(normalizeIndianMobile(phone) ?? phone, code);
      router.replace(next);
    } catch (err) { setError(partnerError(err, 'The code is invalid or expired.')); setCode(''); }
    finally { setBusy(false); }
  };

  return (
    <div className="partner-login">
      <div className="card">
        <img src="/brand/logo-full.webp" alt="Sri Anantha Cart" width={210} height={49} />
        <h1>Delivery partner sign in</h1>
        {stage === 'phone' ? (
          <form onSubmit={sendCode} style={{ display: 'grid', gap: 14 }}>
            <label className="field"><span>Registered mobile number</span>
              <div className="phone-field"><span>+91</span><input id="partner-phone" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={10} value={phone} onChange={event => setPhone(event.target.value.replace(/\D/g, ''))} autoFocus /></div>
            </label>
            {error && <p className="field-error" role="alert">{error}</p>}
            <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Sending…' : 'Send code'}</button>
            <p className="field-hint" style={{ margin: 0, textAlign: 'center' }}>Only numbers registered by the store as delivery partners receive a code.</p>
          </form>
        ) : (
          <form onSubmit={verify} style={{ display: 'grid', gap: 14 }}>
            <p className="muted" style={{ margin: 0, textAlign: 'center' }}>If +91 {phone} is registered, we sent it a 6-digit code.</p>
            <label className="field"><span>Verification code</span>
              <input id="partner-code" className="input otp-entry" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} autoFocus />
            </label>
            {error && <p className="field-error" role="alert">{error}</p>}
            <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Verifying…' : 'Verify and continue'}</button>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setStage('phone'); setError(''); }}>Change number</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy || resendIn > 0} onClick={() => void sendCode()}>{resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function PartnerLoginPage() { return <Suspense fallback={null}><PartnerLogin /></Suspense>; }
