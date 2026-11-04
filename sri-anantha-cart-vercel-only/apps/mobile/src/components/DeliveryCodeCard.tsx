import { ApiRequestError } from '@sac/api-client';
import type { CustomerDeliveryOtp } from '@sac/contracts';
import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text } from 'react-native';
import { api } from '../api';
import { errorMessage } from '../session';
import { colors, fonts } from '../theme';
import { Body, Button, Card } from './ui';

/**
 * The customer's one-time delivery code, shown only while their self-delivery order is out for delivery.
 * Fetched from an owner-only endpoint and kept in memory only (never written to device storage).
 */
export function DeliveryCodeCard({ orderId, onFinished }: { orderId: string; onFinished: () => void }) {
  const [otp, setOtp] = useState<CustomerDeliveryOtp | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const shown = useRef(false);

  const load = useCallback(async () => {
    try { setOtp(await api.deliveryOtp(orderId)); shown.current = true; }
    catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        setOtp(null);
        if (shown.current) { shown.current = false; onFinished(); }
      }
    }
  }, [orderId, onFinished]);

  useFocusEffect(useCallback(() => {
    void load();
    const poll = setInterval(() => { if (AppState.currentState === 'active') void load(); }, 20_000);
    return () => clearInterval(poll);
  }, [load]));
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  if (!otp) return null;
  const secondsLeft = otp.expires_at ? Math.max(0, Math.floor((new Date(otp.expires_at).getTime() - now) / 1000)) : 0;
  const active = otp.status === 'active' && otp.otp && secondsLeft > 0;
  const requestNew = async () => {
    setBusy(true); setError('');
    try { await api.resendDeliveryOtp(orderId); await load(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <Card style={styles.card}>
      <Body weight="bold">Your delivery code</Body>
      {active ? (
        <>
          <Text style={styles.code} accessibilityLabel={`Delivery code ${otp.otp?.split('').join(' ')}`} selectable={false}>{otp.otp}</Text>
          <Body muted size={13}>Tell this code to the delivery partner only when they hand over your order. It works once and expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}.</Body>
        </>
      ) : (
        <>
          <Body muted size={13}>Your delivery code has expired.</Body>
          {otp.can_request_new
            ? <Button title="Get a new code" onPress={() => void requestNew()} loading={busy} />
            : <Body muted size={13}>Please ask the delivery partner or call the store for a new code.</Body>}
        </>
      )}
      {error ? <Body size={13} style={{ color: colors.red }}>{error}</Body> : null}
      <Body muted size={12}>The store never asks for this code by phone.</Body>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: 8, borderColor: colors.gold, borderWidth: 1 },
  code: { fontFamily: fonts.serif, fontSize: 38, letterSpacing: 10, color: colors.primary, textAlign: 'center' },
});
