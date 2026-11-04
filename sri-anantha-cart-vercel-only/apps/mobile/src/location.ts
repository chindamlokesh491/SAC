import type { ReverseAddress } from '@sac/contracts';
import * as Location from 'expo-location';
import { useCallback, useState } from 'react';
import { api } from './api';
import { errorMessage } from './session';

/** Asks for foreground location permission, then turns the position into an editable address. */
export function useDeviceLocation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const detect = useCallback(async (): Promise<ReverseAddress | null> => {
    setError('');
    setBusy(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') { setError('Location permission was not given. Please type your PIN code instead.'); return null; }
      const position = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15_000)),
      ]);
      return await api.reverseGeocode(position.coords.latitude, position.coords.longitude);
    } catch (failure) {
      setError(failure instanceof Error && failure.message === 'timeout' ? 'Finding your location took too long. Please try again or type your PIN code.' : errorMessage(failure, 'Could not find your location. Please type your PIN code instead.'));
      return null;
    } finally { setBusy(false); }
  }, []);
  return { detect, busy, error };
}
