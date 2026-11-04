import { type DeliveryAvailability } from '@sac/contracts';
import { isValidPostalCode } from '@sac/shared';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { CircleCheck, CircleX, Heart, LocateFixed, MapPin, Search, ShieldCheck, ShoppingCart } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api } from '../api';
import { Body, Button, Title } from '../components/ui';
import { writeFlag } from '../guest';
import { useDeviceLocation } from '../location';
import type { RootStackParamList } from '../navigation-types';
import { useSession } from '../session';
import { colors, fonts, radius } from '../theme';

const STEPS = [
  { icon: Search, title: 'Find what you need', body: 'Browse by category or search for any pooja item, such as “diya” or “kumkum”. Exact matches come first, then a few similar items.' },
  { icon: ShoppingCart, title: 'Add to cart, no account needed', body: 'Tap Add to Cart, then use − and + to change the quantity. Tap the heart to save items for later. Both stay on this phone while you browse.' },
  { icon: MapPin, title: 'Check delivery to your area', body: 'Enter your PIN code or use your current location. We deliver across Tirupati in 15–30 minutes, or at a time slot you choose.' },
  { icon: ShieldCheck, title: 'Sign in only at checkout', body: 'When you are ready to order, sign in with your mobile number and a one-time code. Your cart and wishlist move to your account.' },
];

/** Delivery PIN check with optional location detection; never blocks browsing. */
export function PincodeChecker({ onChecked }: { onChecked?: (result: DeliveryAvailability) => void }) {
  const { pincode, setPincode } = useSession();
  const [value, setValue] = useState(pincode);
  const [result, setResult] = useState<DeliveryAvailability | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const location = useDeviceLocation();

  const check = async (pin: string) => {
    setError(''); setResult(null);
    if (!isValidPostalCode(pin)) { setError('Enter a valid 6-digit PIN code'); return; }
    setChecking(true);
    try { const availability = await api.deliveryAvailability(pin); setResult(availability); await setPincode(pin); onChecked?.(availability); }
    catch { setError('Could not check this PIN code right now'); } finally { setChecking(false); }
  };
  const detect = async () => {
    const found = await location.detect();
    if (!found) return;
    if (!found.postal_code) { setError('We found your area but not its PIN code. Please type it.'); return; }
    setValue(found.postal_code);
    void check(found.postal_code);
  };
  const message = error || location.error;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput style={s.input} value={value} onChangeText={text => setValue(text.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" placeholder="Enter 6-digit PIN code" placeholderTextColor={colors.muted2} accessibilityLabel="PIN code" maxLength={6} />
        <Button title={checking ? 'Checking…' : 'Check'} onPress={() => void check(value)} disabled={checking} style={{ paddingHorizontal: 18, flexShrink: 0 }} />
      </View>
      <Pressable onPress={() => void detect()} disabled={location.busy} style={s.locate} accessibilityRole="button">
        <LocateFixed size={17} color={colors.red} /><Text style={s.locateText}>{location.busy ? 'Finding your location…' : 'Use my current location'}</Text>
      </Pressable>
      {message ? <View style={s.result}><CircleX size={17} color={colors.red} /><Body size={13} style={{ color: colors.red, flex: 1 }}>{message}</Body></View> : null}
      {result && (result.serviceable
        ? <View style={s.result}><CircleCheck size={17} color={colors.green} /><Body size={13} style={{ color: colors.green, flex: 1 }}>Delivery is available to {result.postal_code}{result.express?.available ? ` in ${result.zone?.estimated_minutes ?? 30} minutes` : ' in scheduled slots'}.</Body></View>
        : <View style={s.result}><CircleX size={17} color={colors.red} /><Body size={13} style={{ color: colors.red, flex: 1 }}>Sorry, we don&apos;t deliver to {result.postal_code} yet. You can still browse the store.</Body></View>)}
    </View>
  );
}

/** First launch: a four-step introduction, then (for guests) a delivery PIN check. Reopened from Profile. */
export function WelcomeScreen() {
  const navigation = useNavigation();
  const { params } = useRoute<RouteProp<RootStackParamList, 'Welcome'>>();
  const { user, pincode } = useSession();
  const [stage, setStage] = useState<'tour' | 'pin'>(params?.start ?? 'tour');
  const [step, setStep] = useState(0);
  const close = () => { void writeFlag('pin-asked'); navigation.goBack(); };
  // After the introduction, guests without a PIN code are asked for one; everyone else returns to the app.
  const finishTour = () => { void writeFlag('tour-done'); if (!user && !pincode) setStage('pin'); else navigation.goBack(); };

  if (stage === 'pin') {
    return (
      <View style={s.backdrop}>
        <View style={s.card}>
          <Title size={20}>Check delivery to your area</Title>
          <Body muted>Enter your PIN code or let us detect it. You can keep browsing either way.</Body>
          <PincodeChecker onChecked={() => void writeFlag('pin-asked')} />
          <Button title="Continue shopping" onPress={close} />
        </View>
      </View>
    );
  }
  const current = STEPS[step]!;
  const Icon = current.icon;
  const last = step === STEPS.length - 1;
  return (
    <View style={s.backdrop}>
      <View style={[s.card, { alignItems: 'center' }]}>
        <View style={s.art}><Icon size={38} color={colors.red} />{step === 1 && <Heart size={18} color={colors.red} fill={colors.red} style={{ position: 'absolute', top: 10, right: 8 }} />}</View>
        <Text style={s.count}>STEP {step + 1} OF {STEPS.length}</Text>
        <Title size={21} style={{ textAlign: 'center' }}>{current.title}</Title>
        <Body muted style={{ textAlign: 'center' }}>{current.body}</Body>
        <View style={s.dots}>{STEPS.map((item, index) => <View key={item.title} style={[s.dot, index === step && s.dotOn]} />)}</View>
        <View style={{ flexDirection: 'row', gap: 10, alignSelf: 'stretch' }}>
          <Button variant="ghost" title={step === 0 ? 'Skip' : 'Back'} onPress={() => (step === 0 ? finishTour() : setStep(step - 1))} style={{ flex: 1 }} />
          <Button title={last ? 'Start shopping' : 'Next'} onPress={() => (last ? finishTour() : setStep(step + 1))} style={{ flex: 1 }} />
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(29,12,4,0.5)', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: colors.white, borderRadius: radius.lg, padding: 22, gap: 12 },
  art: { width: 80, height: 80, borderRadius: 40, backgroundColor: colors.saffronSoft, alignItems: 'center', justifyContent: 'center' },
  count: { fontFamily: fonts.bold, fontSize: 11.5, letterSpacing: 1, color: colors.saffron },
  dots: { flexDirection: 'row', gap: 6, marginVertical: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.lineStrong },
  dotOn: { width: 22, backgroundColor: colors.red },
  input: { flex: 1, minWidth: 0, width: '100%', height: 46, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 8, paddingHorizontal: 12, fontFamily: fonts.medium, fontSize: 15, color: colors.ink, letterSpacing: 1, backgroundColor: colors.white },
  locate: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 4 },
  locateText: { fontFamily: fonts.semibold, fontSize: 14, color: colors.red },
  result: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
});
