import { type OrderDetail, type OrderSummary } from '@sac/contracts';
import { formatAddressLine, formatDateTime, formatPhone, formatRupees, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from '@sac/shared';
import { useFocusEffect, useNavigation, useRoute, type NavigationProp, type RouteProp } from '@react-navigation/native';
import { Check, ChevronRight, Package, Search } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../api';
import { Body, Button, Card, EmptyState, Loading, Row, ScreenHeader, StatusBadge, Title, Tracker } from '../components/ui';
import { mediaUrl } from '../config';
import { DeliveryCodeCard } from '../components/DeliveryCodeCard';
import type { RootStackParamList } from '../navigation-types';
import { errorMessage, useSession } from '../session';
import { colors, fonts } from '../theme';
import { SignInPrompt } from './SignInPrompt';

const TABS = [['', 'All'], ['processing', 'Processing'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled']] as const;

export function OrdersScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { user } = useSession();
  const [tab, setTab] = useState('');
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => { try { setOrders(await api.orders(tab || undefined)); } catch { setOrders([]); } }, [tab]);
  useFocusEffect(useCallback(() => { if (user) void load(); }, [user, load]));
  if (!user) return <SignInPrompt title="My Orders" message="Sign in to see and track your orders." />;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <View style={{ alignItems: 'center', paddingVertical: 12 }}><Title size={20}>My Orders</Title></View>
      <View style={s.tabs}>
        {TABS.map(([value, label]) => <Pressable key={label} onPress={() => { setOrders(null); setTab(value); }} style={[s.tab, tab === value && s.tabActive]} accessibilityRole="tab" accessibilityState={{ selected: tab === value }}><Text style={[s.tabText, tab === value && { color: colors.red }]}>{label}</Text></Pressable>)}
      </View>
      {orders === null ? <Loading /> : (
        <FlatList data={orders} keyExtractor={item => item.id} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 90 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
          ListEmptyComponent={<EmptyState icon={<Package size={40} color={colors.saffron} />} title="No orders here yet" action={<Button title="Start Shopping" onPress={() => navigation.navigate('Tabs', { screen: 'Home' })} />} />}
          ListHeaderComponent={<Pressable onPress={() => navigation.navigate('TrackOrder')} style={s.track}><Search size={16} color={colors.red} /><Text style={s.trackText}>Track an order by ID</Text></Pressable>}
          renderItem={({ item }) => (
            <Pressable onPress={() => navigation.navigate('OrderDetail', { id: item.id })} style={s.order} accessibilityRole="button" accessibilityLabel={`Order ${item.display_number}`}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View><Body weight="bold">Order #{item.display_number}</Body><Body muted size={12}>{formatDateTime(item.created_at)}</Body></View>
                <StatusBadge status={item.status} />
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
                {item.thumbs.slice(0, 3).map((thumb, index) => thumb ? <Image key={index} source={{ uri: mediaUrl(thumb) }} style={s.thumb} resizeMode="contain" /> : null)}
                <View style={{ flex: 1, alignItems: 'flex-end' }}><Body muted size={12}>{item.item_count} {item.item_count === 1 ? 'item' : 'items'}</Body><Body weight="bold">{formatRupees(item.total_paise)}</Body></View>
                <ChevronRight size={20} color={colors.muted} />
              </View>
            </Pressable>
          )} />
      )}
    </SafeAreaView>
  );
}

export function OrderDetailScreen() {
  const { params } = useRoute<RouteProp<RootStackParamList, 'OrderDetail'>>();
  const { toast } = useSession();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [reason, setReason] = useState('');
  const [selectedReturnItems, setSelectedReturnItems] = useState<Record<string, number>>({});
  const [returning, setReturning] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.order(params.id).then(setOrder).catch(error => toast(errorMessage(error), 'error')), [params.id, toast]);
  useEffect(() => { void load(); }, [load]);
  if (!order) return <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }}><ScreenHeader title="Order Details" /><Loading /></SafeAreaView>;
  const submitReturn = async () => {
    setBusy(true);
    try { const items = Object.entries(selectedReturnItems).filter(([, quantity]) => quantity > 0).map(([order_item_id, quantity]) => ({ order_item_id, quantity })); if (!items.length) { toast('Select at least one item to return.', 'error'); return; } await api.requestReturn(order.id, reason.trim(), items); toast('Return requested', 'success'); setReturning(false); await load(); }
    catch (error) { toast(errorMessage(error), 'error'); } finally { setBusy(false); }
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <ScreenHeader title={`#${order.display_number}`} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
        <Card style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Body muted size={13}>{formatDateTime(order.created_at)}</Body><StatusBadge status={order.status} /></View>
          <Tracker order={order} />
        </Card>
        {order.status === 'dispatched' && <DeliveryCodeCard orderId={order.id} onFinished={() => void load()} />}
        <Card style={{ gap: 10 }}>
          <Body weight="bold">Items</Body>
          {order.items.map((item, index) => (
            <View key={item.order_item_id || index} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              {item.thumb_url && <Image source={{ uri: mediaUrl(item.thumb_url) }} style={s.thumb} resizeMode="contain" />}
              <View style={{ flex: 1 }}><Body size={13.5} weight="medium">{item.name}{item.variant_label ? ` (${item.variant_label})` : ''}</Body><Body muted size={12}>{item.quantity} × {formatRupees(item.unit_price_paise)}</Body></View>
              <Body weight="semibold">{formatRupees(item.line_total_paise)}</Body>
            </View>
          ))}
        </Card>
        <Card style={{ gap: 8 }}>
          <Row label="Item Total" value={formatRupees(order.subtotal_paise)} />
          <Row label="Delivery Fee" value={order.delivery_fee_paise ? formatRupees(order.delivery_fee_paise) : 'FREE'} valueColor={order.delivery_fee_paise ? undefined : colors.green} />
          {order.tax_paise > 0 && <Row label="Includes GST" value={formatRupees(order.tax_paise)} muted />}
          <Row label="Total" value={formatRupees(order.total_paise)} valueColor={colors.red} />
          <Row label="Payment" value={`${order.payment_method ? PAYMENT_METHOD_LABELS[order.payment_method] : '—'} · ${PAYMENT_STATUS_LABELS[order.payment_status]}`} />
        </Card>
        <Card><Body weight="bold">Delivery Address</Body><Body size={13.5}>{order.address.recipient_name} · {formatPhone(order.address.phone_e164)}</Body><Body muted size={13}>{formatAddressLine(order.address)}</Body></Card>
        {order.cancellation_reason && <Card style={{ backgroundColor: colors.redSoft }}><Body style={{ color: colors.red }}>Cancelled: {order.cancellation_reason}</Body></Card>}
        {order.can_request_return && !returning && <Button variant="outline" title="Request Return" onPress={() => { setSelectedReturnItems(Object.fromEntries(order.items.map(item => [item.order_item_id, item.quantity]))); setReturning(true); }} />}
        {returning && (
          <Card style={{ gap: 10 }}>
            <Body weight="semibold">Select items and quantities to return</Body>
            {order.items.map(item => {
              const quantity = selectedReturnItems[item.order_item_id] ?? 0;
              return <View key={item.order_item_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: quantity > 0 }} onPress={() => setSelectedReturnItems(current => {
                  const next = { ...current };
                  if (next[item.order_item_id]) delete next[item.order_item_id];
                  else next[item.order_item_id] = item.quantity;
                  return next;
                })} style={{ width: 28, height: 28, borderRadius: 6, borderWidth: 1, borderColor: colors.lineStrong, alignItems: 'center', justifyContent: 'center', backgroundColor: quantity > 0 ? colors.red : colors.white }}>
                  {quantity > 0 ? <Check size={16} color={colors.white} /> : null}
                </Pressable>
                <View style={{ flex: 1 }}><Body size={13}>{item.name}</Body><Body muted size={11}>Purchased: {item.quantity}</Body></View>
                {quantity > 0 && <TextInput accessibilityLabel={`Return quantity for ${item.name}`} keyboardType="number-pad" value={String(quantity)} onChangeText={value => setSelectedReturnItems(current => ({ ...current, [item.order_item_id]: Math.max(1, Math.min(item.quantity, Number(value) || 1)) }))} style={[s.input, { width: 58, height: 40, textAlign: 'center' }]} />}
              </View>;
            })}
            <Body weight="semibold">What went wrong?</Body>
            <TextInput style={s.textarea} multiline value={reason} onChangeText={setReason} maxLength={500} placeholder="Describe the issue (damaged, wrong item…)" placeholderTextColor={colors.muted2} />
            <Button title="Submit return request" loading={busy} disabled={reason.trim().length < 3 || Object.values(selectedReturnItems).every(quantity => quantity < 1)} onPress={() => void submitReturn()} />
            <Button variant="ghost" title="Cancel" onPress={() => setReturning(false)} />
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

export function OrderSuccessScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { params } = useRoute<RouteProp<RootStackParamList, 'OrderSuccess'>>();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  useEffect(() => { api.order(params.orderId).then(setOrder).catch(() => undefined); }, [params.orderId]);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }}>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 14, alignItems: 'stretch' }}>
        <View style={s.check}><Check size={48} color={colors.white} strokeWidth={3} /></View>
        <Title size={24} style={{ color: colors.green, textAlign: 'center' }}>Order Placed Successfully!</Title>
        <Body muted style={{ textAlign: 'center' }}>{order?.delivery_mode === 'scheduled' ? 'Your order will be delivered in your selected slot.' : 'Your pooja items are on the way and will be delivered in 15-30 minutes.'}{order?.payment_method === 'cod' ? ` Please keep ${formatRupees(order.total_paise)} ready (Cash on Delivery).` : ''}</Body>
        {order ? (
          <Card style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><View><Body weight="bold" size={16}>Order #{order.display_number}</Body><Body muted size={12}>{formatDateTime(order.created_at)}</Body></View><StatusBadge status={order.status} /></View>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              {order.items.slice(0, 3).map((item, index) => item.thumb_url ? <Image key={index} source={{ uri: mediaUrl(item.thumb_url) }} style={s.thumb} resizeMode="contain" /> : null)}
              <View style={{ flex: 1, alignItems: 'flex-end' }}><Body muted size={12}>{order.items.reduce((sum, item) => sum + item.quantity, 0)} items</Body><Body weight="bold">{formatRupees(order.total_paise)}</Body></View>
            </View>
            <Tracker order={order} />
          </Card>
        ) : <Loading />}
        <Button title="Track Order" onPress={() => navigation.navigate('OrderDetail', { id: params.orderId })} />
        <Button variant="outline" title="Continue Shopping" onPress={() => navigation.navigate('Tabs', { screen: 'Home' })} />
      </ScrollView>
    </SafeAreaView>
  );
}

export function TrackOrderScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const track = async () => {
    setBusy(true); setError('');
    try { const { order_id } = await api.trackOrder(reference.trim()); navigation.navigate('OrderDetail', { id: order_id }); }
    catch (err) { setError(errorMessage(err, 'We could not find that order')); } finally { setBusy(false); }
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <ScreenHeader title="Track Order" />
      <View style={{ padding: 16, gap: 12 }}>
        <Body muted>Enter your order ID to track your order</Body>
        <TextInput style={s.input} value={reference} onChangeText={value => setReference(value.toUpperCase())} placeholder="Order ID (e.g. SA12345)" placeholderTextColor={colors.muted2} autoCapitalize="characters" maxLength={20} onSubmitEditing={() => void track()} />
        {error ? <Body style={{ color: colors.red }} size={13}>{error}</Body> : null}
        <Button title="Track Order" loading={busy} disabled={reference.trim().length < 5} onPress={() => void track()} />
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.line, paddingHorizontal: 8 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: colors.red },
  tabText: { fontFamily: fonts.semibold, fontSize: 13, color: colors.ink2 },
  order: { backgroundColor: colors.white, borderRadius: 10, borderWidth: 1, borderColor: colors.line, padding: 14 },
  thumb: { width: 44, height: 44, backgroundColor: colors.cream, borderRadius: 8 },
  track: { flexDirection: 'row', gap: 8, alignItems: 'center', alignSelf: 'flex-end' },
  trackText: { color: colors.red, fontFamily: fonts.semibold, fontSize: 13 },
  check: { width: 90, height: 90, borderRadius: 45, backgroundColor: '#1f9a45', alignSelf: 'center', alignItems: 'center', justifyContent: 'center', marginTop: 20 },
  textarea: { minHeight: 90, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 8, padding: 10, textAlignVertical: 'top', fontFamily: fonts.regular, color: colors.ink, backgroundColor: colors.white },
  input: { height: 48, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 8, backgroundColor: colors.white, paddingHorizontal: 14, fontFamily: fonts.medium, fontSize: 15, color: colors.ink },
});
