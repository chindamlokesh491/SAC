import { type Address, type DeliverySelection, type PaymentMethod, type Quote } from '@sac/contracts';
import { ApiRequestError, newIdempotencyKey } from '@sac/api-client';
import { formatAddressLine, formatDate, formatPhone, formatRupees, PAYMENT_METHOD_LABELS } from '@sac/shared';
import { useFocusEffect, useNavigation, useRoute, type NavigationProp, type RouteProp } from '@react-navigation/native';
import { StackActions } from '@react-navigation/native';
import { ArrowRight, Clock, House, Lock, Truck } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../api';
import { Body, Button, Card, Loading, ScreenHeader, Stepper, SummaryRows, Title } from '../components/ui';
import { ONLINE_PAYMENTS_IN_APP } from '../config';
import type { RootStackParamList } from '../navigation-types';
import { errorMessage, useSession } from '../session';
import { colors, fonts, radius } from '../theme';

const METHODS: PaymentMethod[] = ['upi', 'card', 'net_banking', 'cod'];
const METHOD_TITLES: Record<PaymentMethod, string> = { upi: 'UPI (Google Pay, PhonePe, Paytm)', card: 'Credit / Debit Card', net_banking: 'Net Banking', wallet: 'Wallet', cod: 'Cash on Delivery (COD)' };
const PROBLEMS: Record<string, string> = {
  DELIVERY_UNAVAILABLE: 'We do not deliver to this PIN code yet. Choose another address.',
  MINIMUM_ORDER_NOT_MET: 'Your order is below the minimum for this area.',
  NO_DELIVERY_SLOTS: 'No delivery slots are available right now.',
  CART_HAS_UNAVAILABLE_ITEMS: 'Some cart items are unavailable. Please review your cart.',
};

function Radio({ selected }: { selected: boolean }) {
  return <View style={[s.radio, selected && { borderColor: colors.red }]}>{selected && <View style={s.radioDot} />}</View>;
}

export function CheckoutScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { toast, user, ready } = useSession();
  // Checkout is the one step that needs an account: swap this screen for sign-in, which returns here.
  useEffect(() => { if (ready && !user) navigation.dispatch(StackActions.replace('Login', { next: 'Checkout' })); }, [ready, user, navigation]);
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [delivery, setDelivery] = useState<DeliverySelection | null>(null);

  const load = useCallback(async (preferred?: string | null) => {
    try {
      const list = await api.addresses();
      setAddresses(list);
      const chosen = list.find(item => item.id === preferred) ?? list.find(item => item.is_default) ?? list[0] ?? null;
      setAddressId(chosen?.id ?? null);
      setQuote(await api.cart(chosen?.id));
    } catch (error) { toast(errorMessage(error), 'error'); }
  }, [toast]);
  // Returning from the address book re-reads addresses so a new/changed selection applies.
  useFocusEffect(useCallback(() => { void load(addressId); }, [load])); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!quote) return;
    if (delivery?.mode === 'express' && !quote.delivery.express.available) setDelivery(null);
    if (!delivery) {
      if (quote.delivery.express.available) setDelivery({ mode: 'express' });
      else if (quote.delivery.scheduled[0]) setDelivery({ mode: 'scheduled', slot_id: quote.delivery.scheduled[0].slot_id, date: quote.delivery.scheduled[0].date });
    }
  }, [quote, delivery]);

  const groups = useMemo(() => {
    const map = new Map<string, Quote['delivery']['scheduled']>();
    for (const option of quote?.delivery.scheduled ?? []) map.set(option.date, [...(map.get(option.date) ?? []), option]);
    return [...map.entries()];
  }, [quote]);

  if (!addresses || !quote) return <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }}><ScreenHeader title="Checkout" /><Loading /></SafeAreaView>;
  const address = addresses.find(item => item.id === addressId) ?? null;
  const problem = quote.problems.find(item => PROBLEMS[item]);
  const fee = quote.delivery_fee_paise === 0 ? 'FREE' : formatRupees(quote.delivery_fee_paise);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <ScreenHeader title="Checkout" />
      <Stepper step={1} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
        <View style={s.sectionHead}><Title size={18}>Delivery Address</Title><Pressable onPress={() => navigation.navigate('Addresses', { selectMode: true })}><Text style={s.link}>{address ? 'Change' : 'Add'}</Text></Pressable></View>
        {address ? (
          <Card style={{ flexDirection: 'row', gap: 14 }}>
            <View style={s.homeIcon}><House size={26} color={colors.red} /></View>
            <View style={{ flex: 1 }}>
              <Body weight="semibold">{address.recipient_name}</Body>
              <Body muted size={13}>{formatAddressLine(address)}</Body>
              <Body muted size={13}>{formatPhone(address.phone_e164)}</Body>
            </View>
          </Card>
        ) : <Button variant="outline" title="Add a delivery address" onPress={() => navigation.navigate('AddressForm')} />}
        {address && (
          <>
            <Title size={18} style={{ marginTop: 6 }}>Delivery Option</Title>
            {problem ? <View style={s.warn}><Body size={13} style={{ color: colors.amber }}>{PROBLEMS[problem]}</Body></View> : (
              <>
                <Pressable disabled={!quote.delivery.express.available} onPress={() => setDelivery({ mode: 'express' })} style={[s.option, delivery?.mode === 'express' && s.optionSelected, !quote.delivery.express.available && { opacity: 0.55 }]}>
                  <Truck size={30} color={colors.red} />
                  <View style={{ flex: 1 }}>
                    <Body weight="semibold">15-{quote.delivery.express.estimated_minutes ?? 30} Minutes Delivery</Body>
                    {quote.delivery.express.available ? <Text style={[s.fee, quote.delivery_fee_paise === 0 && { color: colors.red }]}>{fee}</Text> : <Body muted size={12.5}>{quote.delivery.express.reason}</Body>}
                  </View>
                  <Radio selected={delivery?.mode === 'express'} />
                </Pressable>
                {groups.length > 0 && (
                  <View style={[s.option, { flexDirection: 'column', alignItems: 'stretch' }, delivery?.mode === 'scheduled' && s.optionSelected]}>
                    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}><Clock size={26} color={colors.red} /><View style={{ flex: 1 }}><Body weight="semibold">Scheduled Delivery</Body><Body muted size={12.5}>Pick a time slot · {fee}</Body></View></View>
                    {groups.map(([date, options]) => (
                      <View key={date} style={{ marginTop: 10 }}>
                        <Body weight="semibold" size={12.5}>{formatDate(`${date}T12:00:00+05:30`)}</Body>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                          {options.map(option => {
                            const selected = delivery?.mode === 'scheduled' && delivery.slot_id === option.slot_id && delivery.date === date;
                            return <Pressable key={`${option.slot_id}-${date}`} onPress={() => setDelivery({ mode: 'scheduled', slot_id: option.slot_id, date })} style={[s.slot, selected && s.slotSelected]}><Text style={[s.slotText, selected && { color: colors.red }]}>{option.label}</Text></Pressable>;
                          })}
                        </View>
                      </View>
                    ))}
                  </View>
                )}
              </>
            )}
          </>
        )}
        <Card><SummaryRows quote={quote} /></Card>
        <Button title="Continue to Payment" icon={<ArrowRight size={18} color={colors.white} />} disabled={!address || !delivery || Boolean(problem)}
          onPress={() => navigation.navigate('Payment', { addressId: address!.id, delivery: delivery! })} />
      </ScrollView>
    </SafeAreaView>
  );
}

export function PaymentScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { params } = useRoute<RouteProp<RootStackParamList, 'Payment'>>();
  const { user, toast } = useSession();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [email, setEmail] = useState(user?.email ?? '');
  useEffect(() => {
    api.cart(params.addressId).then(next => {
      // Online methods stay off in the app until the native Razorpay SDK is integrated and verified for this build.
      const methods = Object.fromEntries(Object.entries(next.payment_methods).map(([key, value]) => [key, key !== 'cod' && !ONLINE_PAYMENTS_IN_APP && value.available ? { available: false, reason: 'Online payment in the app is coming soon. Please choose Cash on Delivery.' } : value])) as Quote['payment_methods'];
      setQuote({ ...next, payment_methods: methods });
      setMethod(METHODS.find(item => methods[item].available) ?? null);
    }).catch(error => toast(errorMessage(error), 'error'));
  }, [params.addressId, toast]);
  if (!quote) return <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }}><ScreenHeader title="Payment Method" /><Loading /></SafeAreaView>;
  const online = method !== null && method !== 'cod';
  const emailOk = !online || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <ScreenHeader title="Payment Method" />
      <Stepper step={2} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 40 }}>
        {!METHODS.some(item => item !== 'cod' && quote.payment_methods[item].available) && <View style={[s.warn, { backgroundColor: colors.blueSoft }]}><Body size={13} style={{ color: colors.blue }}>Online payments are being set up. Cash on Delivery is available for your order.</Body></View>}
        {METHODS.map(item => {
          const availability = quote.payment_methods[item];
          return (
            <Pressable key={item} disabled={!availability.available} onPress={() => setMethod(item)} style={[s.option, method === item && s.optionSelected, !availability.available && { opacity: 0.55 }]} accessibilityRole="radio" accessibilityState={{ checked: method === item, disabled: !availability.available }}>
              <Radio selected={method === item} />
              <View style={{ flex: 1 }}>
                <Body weight="semibold" size={14}>{METHOD_TITLES[item]}</Body>
                {!availability.available && availability.reason ? <Body muted size={12}>{availability.reason}</Body> : item === 'cod' ? <Body muted size={12}>Pay in cash when your order arrives</Body> : null}
              </View>
            </Pressable>
          );
        })}
        {online && (
          <View style={{ gap: 6 }}>
            <Body weight="semibold" size={13}>Email for payment receipt</Body>
            <TextInput style={s.input} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" maxLength={254} />
          </View>
        )}
        <Button title="Continue" icon={<ArrowRight size={18} color={colors.white} />} disabled={!method || !emailOk} style={{ marginTop: 10 }}
          onPress={() => navigation.navigate('Review', { ...params, method: method!, ...(online ? { email: email.trim() } : {}) })} />
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 6 }}><Lock size={14} color={colors.amber} /><Body muted size={12}>Secure and encrypted payments</Body></View>
      </ScrollView>
    </SafeAreaView>
  );
}

export function ReviewScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { params } = useRoute<RouteProp<RootStackParamList, 'Review'>>();
  const { refreshCart, toast } = useSession();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [address, setAddress] = useState<Address | null>(null);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(newIdempotencyKey());
  useEffect(() => {
    Promise.all([api.cart(params.addressId), api.addresses()]).then(([next, list]) => { setQuote(next); setAddress(list.find(item => item.id === params.addressId) ?? null); }).catch(err => toast(errorMessage(err), 'error'));
  }, [params.addressId, toast]);
  if (!quote) return <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }}><ScreenHeader title="Review" /><Loading /></SafeAreaView>;
  const slot = params.delivery.mode === 'scheduled' ? quote.delivery.scheduled.find(item => params.delivery.mode === 'scheduled' && item.slot_id === params.delivery.slot_id && item.date === params.delivery.date) : null;

  const place = async () => {
    setPlacing(true); setError('');
    try {
      const result = await api.checkout({ address_id: params.addressId, delivery: params.delivery, payment_method: params.method, expected_total_paise: quote.total_paise, ...(params.email ? { email: params.email } : {}) }, key.current);
      if (result.checkout) {
        // Reached only when ONLINE_PAYMENTS_IN_APP is enabled; the native Razorpay checkout hand-off is not part of this build yet.
        setError('Online payment is not available in the app yet. Your order is awaiting payment; please choose Cash on Delivery.');
        return;
      }
      await refreshCart();
      navigation.reset({ index: 1, routes: [{ name: 'Tabs' }, { name: 'OrderSuccess', params: { orderId: result.order_id } }] });
    } catch (err) {
      if (err instanceof ApiRequestError && err.body.quote) { setQuote(err.body.quote as Quote); key.current = newIdempotencyKey(); }
      setError(errorMessage(err, 'We could not place your order. Nothing was charged.'));
    } finally { setPlacing(false); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <ScreenHeader title="Review" />
      <Stepper step={3} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
        {error ? <View style={[s.warn, { backgroundColor: colors.redSoft }]}><Body size={13} style={{ color: colors.red }}>{error}</Body></View> : null}
        <Card><Body muted size={12}>Delivering to</Body><Body weight="semibold">{address?.recipient_name} · {formatPhone(address?.phone_e164)}</Body>{address && <Body muted size={13}>{formatAddressLine(address)}</Body>}</Card>
        <Card><Body muted size={12}>Delivery</Body><Body weight="semibold">{params.delivery.mode === 'express' ? `Deliver Now · ${quote.delivery.express.estimated_minutes ?? 30} minutes` : `${slot ? `${formatDate(`${slot.date}T12:00:00+05:30`)} · ${slot.label}` : 'Scheduled slot'}`}</Body></Card>
        <Card><Body muted size={12}>Payment</Body><Body weight="semibold">{PAYMENT_METHOD_LABELS[params.method]}</Body></Card>
        <Card style={{ gap: 8 }}>
          {quote.lines.filter(line => line.available).map(line => <View key={line.cart_item_id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Body size={13.5} style={{ flex: 1 }}>{line.name}{line.variant_label ? ` (${line.variant_label})` : ''} × {line.quantity}</Body><Body weight="semibold" size={13.5}>{formatRupees(line.line_total_paise)}</Body></View>)}
          <View style={{ height: 1, backgroundColor: colors.line, marginVertical: 4 }} />
          <SummaryRows quote={quote} />
        </Card>
        <Button title={params.method === 'cod' ? `Place Order · ${formatRupees(quote.total_paise)}` : `Pay ${formatRupees(quote.total_paise)}`} loading={placing} icon={<ArrowRight size={18} color={colors.white} />} onPress={() => void place()} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  link: { color: colors.red, fontFamily: fonts.semibold, fontSize: 14 },
  homeIcon: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.redSoft, alignItems: 'center', justifyContent: 'center' },
  option: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: colors.white, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 14 },
  optionSelected: { borderColor: 'rgba(200,22,29,0.55)', backgroundColor: '#fff8f7' },
  fee: { fontFamily: fonts.bold, fontSize: 13, color: colors.ink, marginTop: 2 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.lineStrong, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: colors.red },
  slot: { borderWidth: 1.5, borderColor: colors.lineStrong, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  slotSelected: { borderColor: colors.red, backgroundColor: colors.redSoft },
  slotText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.ink2 },
  warn: { backgroundColor: colors.amberSoft, padding: 12, borderRadius: 8 },
  input: { height: 46, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 8, backgroundColor: colors.white, paddingHorizontal: 12, fontFamily: fonts.regular, fontSize: 15, color: colors.ink },
});
