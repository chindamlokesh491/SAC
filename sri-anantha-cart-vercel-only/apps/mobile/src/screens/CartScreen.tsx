import { type QuoteLine } from '@sac/contracts';
import { formatRupees } from '@sac/shared';
import { useFocusEffect, useNavigation, type NavigationProp } from '@react-navigation/native';
import { ShoppingCart, Trash2 } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Body, Button, EmptyState, Loading, QuantityStepper, Title } from '../components/ui';
import { mediaUrl } from '../config';
import type { RootStackParamList } from '../navigation-types';
import { useSession } from '../session';
import { colors, fonts } from '../theme';

const ISSUES: Record<NonNullable<QuoteLine['issue']>, string> = { unavailable: 'No longer available — remove it', insufficient_stock: 'Not enough stock for this quantity', choose_variant: 'Choose a pack size on the product page' };

export function CartScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { user, cart, setQuantity, clearCart, refreshCart, requireLogin, toast } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  useFocusEffect(useCallback(() => { void refreshCart(); }, [refreshCart]));

  if (!cart) return <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }}><Loading /></SafeAreaView>;

  const update = async (line: QuoteLine, quantity: number) => {
    setBusy(line.cart_item_id);
    await setQuantity(line.product_id, line.variant_id, quantity);
    setBusy(null);
  };
  const remove = async (line: QuoteLine) => {
    setBusy(line.cart_item_id);
    if (await setQuantity(line.product_id, line.variant_id, 0)) toast('Removed from cart');
    setBusy(null);
  };
  const clear = () => Alert.alert('Clear cart', 'Remove all items from your cart?', [{ text: 'Cancel', style: 'cancel' }, { text: 'Clear', style: 'destructive', onPress: () => void clearCart() }]);
  const hasIssues = cart.lines.some(line => !line.available);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <View style={s.head}>
        <View style={{ width: 60 }} />
        <View style={{ alignItems: 'center' }}><Title size={20}>My Cart</Title><Body muted size={12}>{cart.item_count} {cart.item_count === 1 ? 'item' : 'items'}</Body></View>
        {cart.lines.length > 0 ? <Pressable onPress={clear} style={{ width: 60, alignItems: 'flex-end' }}><Text style={s.clear}>Clear All</Text></Pressable> : <View style={{ width: 60 }} />}
      </View>
      {cart.lines.length === 0 ? (
        <EmptyState icon={<ShoppingCart size={44} color={colors.saffron} />} title="Your cart is empty" body="Add pooja essentials to get started." action={<Button title="Start Shopping" onPress={() => navigation.navigate('Tabs', { screen: 'Home' })} />} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 100 }}>
          {cart.lines.map(line => (
            <View key={line.cart_item_id} style={[s.line, busy === line.cart_item_id && { opacity: 0.6 }]}>
              <View style={s.lineMain}>
                <Pressable onPress={() => navigation.navigate('Product', { slug: line.slug })}>{line.thumb_url && <Image source={{ uri: mediaUrl(line.thumb_url) }} style={s.img} resizeMode="contain" />}</Pressable>
                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                  <Body weight="semibold" size={14.5}>{line.name}</Body>
                  {line.variant_label && <Body muted size={12}>{line.variant_label}</Body>}
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 3 }}>
                    <Body weight="semibold" size={13}>{formatRupees(line.unit_price_paise)}</Body>
                    {line.mrp_paise > line.unit_price_paise && <><Body muted size={11} style={{ textDecorationLine: 'line-through' }}>{formatRupees(line.mrp_paise)}</Body><Body size={11} style={{ color: colors.green }}>Save {formatRupees(line.mrp_paise - line.unit_price_paise)} / item</Body></>}
                  </View>
                  <Body muted size={11}>Line total: {formatRupees(line.line_total_paise)}</Body>
                  {line.issue && <Body size={12} style={{ color: colors.red }}>{ISSUES[line.issue]}</Body>}
                </View>
              </View>
              <View style={s.lineActions}>
                <QuantityStepper small value={line.quantity} max={Math.max(line.quantity, line.max_quantity)} onChange={value => void update(line, value)} />
                <Pressable accessibilityLabel={`Remove ${line.name}`} onPress={() => void remove(line)} hitSlop={10} style={{ padding: 8 }}><Trash2 size={20} color={colors.red} /></Pressable>
              </View>
            </View>
          ))}
          <View style={{ backgroundColor: colors.white, borderRadius: 12, borderWidth: 1, borderColor: colors.line, padding: 14, gap: 9 }}>
            <Body weight="semibold" size={15}>Price Details</Body>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Body muted size={13}>Item subtotal</Body><Body size={13}>{formatRupees(cart.subtotal_paise)}</Body></View>
            {cart.savings_paise > 0 && <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Body muted size={13}>You save</Body><Body size={13} style={{ color: colors.green }}>− {formatRupees(cart.savings_paise)}</Body></View>}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Body muted size={13}>Delivery fee</Body><Body muted size={12}>Calculated at checkout</Body></View>
            {cart.tax_paise > 0 && <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Body muted size={12}>Includes GST</Body><Body muted size={12}>{formatRupees(cart.tax_paise)}</Body></View>}
            <View style={{ height: 1, backgroundColor: colors.line }} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Body weight="semibold">Current total</Body><Body weight="semibold" size={17}>{formatRupees(cart.total_paise)}</Body></View>
            <Body muted size={11}>Final delivery fee and payable amount are confirmed after selecting your delivery address. GST is included in item prices.</Body>
          </View>
          <Button title={user ? 'Proceed to Checkout' : 'Sign in to Checkout'} disabled={hasIssues} icon={null} onPress={() => { if (requireLogin('Checkout')) navigation.navigate('Checkout'); }} style={{ marginTop: 4 }} />
          {!user && <Body muted size={12} style={{ textAlign: 'center' }}>Your cart is saved on this phone and moves to your account when you sign in.</Body>}
          {hasIssues && <Body size={12.5} style={{ color: colors.red, textAlign: 'center' }}>Fix the highlighted items to continue.</Body>}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  clear: { color: colors.red, fontFamily: fonts.semibold, fontSize: 13 },
  line: { gap: 10, backgroundColor: colors.white, borderRadius: 12, borderWidth: 1, borderColor: colors.line, padding: 12 },
  lineMain: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  lineActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 72 },
  img: { width: 60, height: 60, backgroundColor: colors.cream, borderRadius: 8 },
});
