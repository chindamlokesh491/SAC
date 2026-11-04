'use client';

import { type DeliveryAvailability, type ReverseAddress } from '@sac/contracts';
import { isValidPostalCode } from '@sac/shared';
import { CheckCircle2, LocateFixed, XCircle } from 'lucide-react';
import { useCallback, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { errorMessage, useStore } from './StoreProvider';

function positionError(error: GeolocationPositionError | Error) {
  if ('code' in error) {
    if (error.code === error.PERMISSION_DENIED) return 'Location permission was denied. Please type your PIN code instead.';
    if (error.code === error.TIMEOUT) return 'Finding your location took too long. Please try again or type your PIN code.';
  }
  return 'Could not find your location. Please type your PIN code instead.';
}

/** Asks the browser for the device's position (with permission) and turns it into an editable address. */
export function useDeviceLocation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator;
  const detect = useCallback(async (): Promise<ReverseAddress | null> => {
    setError('');
    if (!supported) { setError('This browser cannot share its location. Please type your PIN code.'); return null; }
    setBusy(true);
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12_000, maximumAge: 300_000 }));
      return await api.reverseGeocode(position.coords.latitude, position.coords.longitude);
    } catch (failure) {
      setError(failure instanceof Error && 'status' in failure ? errorMessage(failure) : positionError(failure as GeolocationPositionError));
      return null;
    } finally { setBusy(false); }
  }, [supported]);
  return { detect, busy, error, supported };
}

/** PIN code check with optional location detection. Shows whether delivery is available; never blocks browsing. */
export function PincodeChecker({ autoFocus = false, onChecked }: { autoFocus?: boolean; onChecked?: (result: DeliveryAvailability) => void }) {
  const { pincode, setPincode } = useStore();
  const [value, setValue] = useState(pincode);
  const [result, setResult] = useState<DeliveryAvailability | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const location = useDeviceLocation();

  const check = async (pin: string) => {
    setError(''); setResult(null);
    if (!isValidPostalCode(pin)) { setError('Enter a valid 6-digit PIN code'); return; }
    setChecking(true);
    try {
      const availability = await api.deliveryAvailability(pin);
      setResult(availability);
      setPincode(pin);
      onChecked?.(availability);
    } catch { setError('Could not check this PIN code right now'); }
    finally { setChecking(false); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void check(value.trim()); };
  const useLocation = async () => {
    const found = await location.detect();
    if (!found) return;
    if (!found.postal_code) { setError('We found your area but not its PIN code. Please type it.'); return; }
    setValue(found.postal_code);
    void check(found.postal_code);
  };

  return (
    <div className="pin-checker">
      <form onSubmit={submit}>
        <input id="pin-check-input" className="input" inputMode="numeric" autoComplete="postal-code" maxLength={6} placeholder="Enter 6-digit PIN code" value={value}
          onChange={event => setValue(event.target.value.replace(/\D/g, ''))} aria-label="PIN code" autoFocus={autoFocus} />
        <button className="btn btn-primary" type="submit" disabled={checking}>{checking ? 'Checking…' : 'Check'}</button>
      </form>
      <button type="button" className="locate-btn" onClick={() => void useLocation()} disabled={location.busy}>
        <LocateFixed size={17} /> {location.busy ? 'Finding your location…' : 'Use my current location'}
      </button>
      {(error || location.error) && <p className="pin-result no" role="alert"><XCircle size={17} /> {error || location.error}</p>}
      {result && (result.serviceable
        ? <p className="pin-result ok" role="status"><CheckCircle2 size={17} /> Delivery is available to {result.postal_code}{result.express?.available ? ` in ${result.zone?.estimated_minutes ?? 30} minutes` : ' in scheduled slots'}.</p>
        : <p className="pin-result no" role="status"><XCircle size={17} /> Sorry, we don&apos;t deliver to {result.postal_code} yet. You can still browse the store.</p>)}
    </div>
  );
}
