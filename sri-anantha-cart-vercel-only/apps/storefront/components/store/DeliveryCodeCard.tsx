'use client';

import { ApiRequestError } from '@sac/api-client';
import type { CustomerDeliveryOtp } from '@sac/contracts';
import { KeyRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { errorMessage } from './StoreProvider';

/**
 * Shows the customer's one-time delivery code while their self-delivery order is out for delivery.
 * The code comes from an owner-only, no-store endpoint and is never cached on the device.
 */
export function DeliveryCodeCard({ orderId, onFinished }: { orderId: string; onFinished: () => void }) {
  const [otp, setOtp] = useState<CustomerDeliveryOtp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const shown = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await api.deliveryOtp(orderId);
      setOtp(next); shown.current = true;
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        setOtp(null);
        // The code disappears once it has been used: the order has moved on, so refresh it.
        if (shown.current) { shown.current = false; onFinished(); }
      }
    }
  }, [orderId, onFinished]);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 20_000);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearInterval(poll); window.clearInterval(tick); };
  }, [load]);

  if (!otp) return null;
  const secondsLeft = otp.expires_at ? Math.max(0, Math.floor((new Date(otp.expires_at).getTime() - now) / 1000)) : 0;
  const active = otp.status === 'active' && otp.otp && secondsLeft > 0;

  const requestNew = async () => {
    setBusy(true); setError('');
    try { await api.resendDeliveryOtp(orderId); await load(); }
    catch (err) { setError(errorMessage(err, 'Could not send a new code.')); }
    finally { setBusy(false); }
  };

  return (
    <div className="box delivery-code" aria-label="Delivery code">
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><KeyRound size={20} /> Your delivery code</h2>
      {active ? (
        <>
          <p className="delivery-code-value" data-testid="delivery-otp">{otp.otp}</p>
          <p className="muted" style={{ margin: 0 }}>Tell this code to the delivery partner only when they hand over your order. It works once and expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}.</p>
        </>
      ) : (
        <>
          <p className="muted" style={{ margin: 0 }}>Your delivery code has expired.</p>
          {otp.can_request_new
            ? <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void requestNew()}>{busy ? 'Sending…' : 'Get a new code'}</button>
            : <p className="muted" style={{ margin: 0 }}>Please ask the delivery partner or call the store for a new code.</p>}
        </>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      <p className="field-hint" style={{ margin: 0 }}>The store never asks for this code by phone.</p>
    </div>
  );
}
