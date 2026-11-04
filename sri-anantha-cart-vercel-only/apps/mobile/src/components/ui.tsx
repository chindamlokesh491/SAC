import { type OrderDetail, type OrderStatus, type ProductCard as Product, type Quote } from '@sac/contracts';
import { CUSTOMER_STATUS_LABELS, discountPercent, formatRupees, formatTime, ORDER_STATUS_TONES, trackingSteps } from '@sac/shared';
import { useNavigation } from '@react-navigation/native';
import { Check, ChevronLeft, Heart, Minus, Plus, ShoppingCart, Trash2 } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { mediaUrl } from '../config';
import { useSession } from '../session';
import { colors, fonts, radius, shadow, toneColors } from '../theme';

export function Title({ children, style, size = 22 }: { children: ReactNode; style?: StyleProp<TextStyle>; size?: number }) {
  return <Text style={[{ fontFamily: fonts.serif, fontSize: size, color: colors.ink }, style]}>{children}</Text>;
}

export function Body({ children, style, muted = false, weight = 'regular', size = 14 }: { children: ReactNode; style?: StyleProp<TextStyle>; muted?: boolean; weight?: 'regular' | 'medium' | 'semibold' | 'bold'; size?: number }) {
  return <Text style={[{ fontFamily: fonts[weight], fontSize: size, color: muted ? colors.muted : colors.ink, lineHeight: size * 1.45 }, style]}>{children}</Text>;
}

/** Product grid columns for the screen width: phones 2, large phones/landscape 3, tablets 4-5. */
export function productGrid(width: number, padding = 16, gap = 12): { columns: number; tileWidth: number } {
  const columns = width >= 1000 ? 5 : width >= 720 ? 4 : width >= 540 ? 3 : 2;
  return { columns, tileWidth: Math.floor((width - padding * 2 - gap * (columns - 1)) / columns) };
}

export function Button({ title, onPress, variant = 'primary', icon, disabled, loading, style, small }: {
  title: string; onPress: () => void; variant?: 'primary' | 'outline' | 'ghost'; icon?: ReactNode; disabled?: boolean; loading?: boolean; style?: StyleProp<ViewStyle>; small?: boolean;
}) {
  const variantStyle = variant === 'primary' ? styles.btnPrimary : variant === 'outline' ? styles.btnOutline : styles.btnGhost;
  const textColor = variant === 'primary' ? colors.white : variant === 'outline' ? colors.red : colors.ink2;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled || loading) }} disabled={disabled || loading} onPress={onPress}
      style={({ pressed }) => [styles.btn, small && styles.btnSmall, variantStyle, (disabled || loading) && { opacity: 0.55 }, pressed && { opacity: 0.85 }, style]}>
      {loading ? <ActivityIndicator color={textColor} /> : <>{icon}<Text style={[styles.btnText, small && { fontSize: 13 }, { color: textColor }]}>{title}</Text></>}
    </Pressable>
  );
}

export function ScreenHeader({ title, right, onBack }: { title: string; right?: ReactNode; onBack?: () => void }) {
  const navigation = useNavigation();
  return (
    <View style={styles.screenHeader}>
      <Pressable accessibilityRole="button" accessibilityLabel="Go back" hitSlop={12} onPress={onBack ?? (() => navigation.goBack())} style={styles.backBtn}><ChevronLeft size={26} color={colors.ink} /></Pressable>
      <Title size={20} style={{ flex: 1, textAlign: 'center' }}>{title}</Title>
      <View style={{ minWidth: 40, alignItems: 'flex-end' }}>{right}</View>
    </View>
  );
}

export function Badge({ label, tone }: { label: string; tone: keyof typeof toneColors }) {
  return <View style={[styles.badge, { backgroundColor: toneColors[tone].bg }]}><Text style={[styles.badgeText, { color: toneColors[tone].fg }]}>{label}</Text></View>;
}

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <Badge label={CUSTOMER_STATUS_LABELS[status]} tone={ORDER_STATUS_TONES[status]} />;
}

export function QuantityStepper({ value, max, onChange, small }: { value: number; max: number; onChange: (value: number) => void; small?: boolean }) {
  const size = small ? 30 : 44;
  return (
    <View style={[styles.qty, { height: size }]} accessibilityRole="adjustable" accessibilityValue={{ now: value, min: 1, max }}>
      <Pressable accessibilityLabel="Decrease quantity" onPress={() => onChange(value - 1)} disabled={value <= 1} style={[styles.qtyBtn, { width: size, opacity: value <= 1 ? 0.35 : 1 }]}><Minus size={small ? 14 : 18} color={colors.ink2} /></Pressable>
      <Text style={[styles.qtyValue, { minWidth: small ? 28 : 40 }]}>{value}</Text>
      <Pressable accessibilityLabel="Increase quantity" onPress={() => onChange(value + 1)} disabled={value >= max} style={[styles.qtyBtn, { width: size, opacity: value >= max ? 0.35 : 1 }]}><Plus size={small ? 14 : 18} color={colors.ink2} /></Pressable>
    </View>
  );
}

/** Shown once an item is in the cart: − quantity +. Going below 1 removes it. */
export function CartStepper({ productId, variantId = null, name, large = false }: { productId: string; variantId?: string | null; name: string; large?: boolean }) {
  const { lineFor, setQuantity } = useSession();
  const [busy, setBusy] = useState(false);
  const line = lineFor(productId, variantId);
  if (!line) return null;
  const change = async (quantity: number) => { setBusy(true); await setQuantity(productId, variantId, quantity); setBusy(false); };
  const atMax = line.quantity >= Math.max(1, line.max_quantity);
  const height = large ? 48 : 36;
  return (
    <View style={[styles.cartStepper, { height }, busy && { opacity: 0.7 }]} accessibilityLabel={`${name}: ${line.quantity} in cart`}>
      <Pressable onPress={() => void change(line.quantity - 1)} disabled={busy} style={[styles.cartStepBtn, { width: height }]} accessibilityLabel={line.quantity === 1 ? `Remove ${name} from cart` : `One less ${name}`}>
        {line.quantity === 1 ? <Trash2 size={16} color={colors.white} /> : <Minus size={16} color={colors.white} />}
      </Pressable>
      <Text style={[styles.cartStepValue, large && { fontSize: 17 }]}>{line.quantity} <Text style={styles.cartStepIn}>in cart</Text></Text>
      <Pressable onPress={() => void change(line.quantity + 1)} disabled={busy || atMax} style={[styles.cartStepBtn, { width: height, opacity: atMax ? 0.45 : 1 }]} accessibilityLabel={`One more ${name}`}>
        <Plus size={16} color={colors.white} />
      </Pressable>
    </View>
  );
}

export function Stepper({ step }: { step: 1 | 2 | 3 }) {
  return (
    <View style={styles.stepper}>
      {['Address', 'Payment', 'Review'].map((label, index) => {
        const number = index + 1;
        const active = number === step; const done = number < step;
        return (
          <View key={label} style={styles.step}>
            {index > 0 && <View style={[styles.stepLine, (done || active) && { backgroundColor: colors.red }]} />}
            <View style={[styles.stepNum, active && styles.stepNumActive, done && styles.stepNumDone]}>
              {done ? <Check size={16} color={colors.red} /> : <Text style={[styles.stepNumText, active && { color: colors.white }]}>{number}</Text>}
            </View>
            <Text style={[styles.stepLabel, active && { color: colors.red, fontFamily: fonts.semibold }]}>{label}</Text>
          </View>
        );
      })}
    </View>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <View style={styles.empty}>
      {icon}
      <Title size={19} style={{ textAlign: 'center', marginTop: 10 }}>{title}</Title>
      {body && <Body muted style={{ textAlign: 'center', marginTop: 6 }}>{body}</Body>}
      {action && <View style={{ marginTop: 16, alignSelf: 'stretch' }}>{action}</View>}
    </View>
  );
}

export function Price({ paise, mrp, size = 18, from }: { paise: number; mrp?: number; size?: number; from?: boolean }) {
  const off = mrp ? discountPercent(paise, mrp) : 0;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 6 }}>
      <Text style={{ fontFamily: fonts.bold, fontSize: size, color: colors.red }}>{from ? 'From ' : ''}{formatRupees(paise)}</Text>
      {off > 0 && <Text style={{ fontFamily: fonts.regular, fontSize: size * 0.62, color: colors.muted2, textDecorationLine: 'line-through' }}>{formatRupees(mrp!)}</Text>}
    </View>
  );
}

export function ProductTile({ product, onPress, width }: { product: Product; onPress: () => void; width: number }) {
  const { addToCart, wishlist, toggleWishlist, lineFor } = useSession();
  const saved = wishlist.has(product.id);
  const out = product.stock_status === 'out_of_stock';
  const inCart = !product.has_variants && lineFor(product.id);
  return (
    <View style={[styles.productTile, { width }]}>
      <Pressable onPress={onPress} accessibilityRole="link" accessibilityLabel={product.name} style={styles.productMedia}>
        {product.thumb_url && <Image source={{ uri: mediaUrl(product.thumb_url) }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />}
      </Pressable>
      <Pressable accessibilityLabel={saved ? 'Remove from wishlist' : 'Save to wishlist'} onPress={() => void toggleWishlist(product.id)} style={styles.heart} hitSlop={8}>
        <Heart size={16} color={colors.red} fill={saved ? colors.red : 'transparent'} />
      </Pressable>
      <Pressable onPress={onPress} style={{ paddingHorizontal: 4, paddingTop: 8 }}>
        <Text style={styles.productName} numberOfLines={1}>{product.name}</Text>
        <Text style={styles.productSub} numberOfLines={1}>{product.short_description ?? product.category_name ?? ''}</Text>
        <View style={{ marginTop: 6 }}><Price paise={product.price_paise} mrp={product.mrp_paise} size={16} from={product.has_variants} /></View>
      </Pressable>
      {out ? <View style={styles.oos}><Text style={styles.oosText}>Out of stock</Text></View> : inCart ? <View style={{ marginTop: 8, marginHorizontal: 2 }}><CartStepper productId={product.id} name={product.name} /></View> : (
        <Button small variant="outline" title={product.has_variants ? 'Choose' : 'Add to Cart'} icon={<ShoppingCart size={15} color={colors.red} />}
          onPress={() => (product.has_variants ? onPress() : void addToCart(product.id, 1))} style={{ marginTop: 8, marginHorizontal: 2 }} />
      )}
    </View>
  );
}

export function Tracker({ order }: { order: Pick<OrderDetail, 'status' | 'timeline' | 'estimated_delivery_at'> }) {
  if (order.status === 'cancelled') return <View style={[styles.alert, { backgroundColor: colors.redSoft }]}><Body style={{ color: colors.red }}>This order was cancelled.</Body></View>;
  const steps = trackingSteps(order.status, order.timeline, order.estimated_delivery_at);
  return (
    <View style={{ gap: 0 }}>
      {steps.map((step, index) => (
        <View key={step.key} style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ alignItems: 'center' }}>
            <View style={[styles.trackDot, step.state === 'done' && { backgroundColor: colors.green, borderColor: colors.green }, step.state === 'current' && { borderColor: colors.green }]}>
              {step.state === 'done' ? <Check size={12} color={colors.white} /> : step.state === 'current' ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green }} /> : null}
            </View>
            {index < steps.length - 1 && <View style={[styles.trackLine, step.state === 'done' && { backgroundColor: colors.green }]} />}
          </View>
          <View style={{ paddingBottom: 14 }}>
            <Body weight="semibold" size={13.5} style={step.state === 'upcoming' ? { color: colors.muted } : undefined}>{step.label}</Body>
            <Body muted size={12}>{step.at ? formatTime(step.at) : step.expected ? `Expected ${formatTime(step.expected)}` : ''}</Body>
          </View>
        </View>
      ))}
    </View>
  );
}

export function SummaryRows({ quote, deliveryKnown = true }: { quote: Quote; deliveryKnown?: boolean }) {
  return (
    <View style={styles.summary}>
      <Row label="Item Total" value={formatRupees(quote.subtotal_paise)} />
      {!deliveryKnown && quote.amount_to_free_delivery_paise > 0
        ? <Row label="Delivery Fee" value="At checkout" muted />
        : <Row label="Delivery Fee" value={quote.delivery_fee_paise === 0 ? 'FREE' : formatRupees(quote.delivery_fee_paise)} valueColor={quote.delivery_fee_paise === 0 ? colors.green : undefined} />}
      {quote.tax_paise > 0 && <Row label="Includes GST" value={formatRupees(quote.tax_paise)} muted />}
      <View style={styles.summaryDivider} />
      <View style={styles.row}><Body weight="bold" size={16}>Total</Body><Text style={{ fontFamily: fonts.bold, fontSize: 18, color: colors.red }}>{formatRupees(quote.total_paise)}</Text></View>
    </View>
  );
}

export function Row({ label, value, valueColor, muted }: { label: string; value: string; valueColor?: string | undefined; muted?: boolean }) {
  return (
    <View style={styles.row}>
      <Body muted size={muted ? 12.5 : 14}>{label}</Body>
      <Body weight={valueColor ? 'bold' : 'medium'} size={muted ? 12.5 : 14} style={{ color: valueColor ?? (muted ? colors.muted : colors.ink) }}>{value}</Body>
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Loading() {
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 }}><ActivityIndicator color={colors.primary} size="large" /></View>;
}

export const styles = StyleSheet.create({
  btn: { minHeight: 48, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 18 },
  btnSmall: { minHeight: 44, paddingHorizontal: 10, borderRadius: 6 },
  btnPrimary: { backgroundColor: colors.primaryStrong },
  btnOutline: { borderWidth: 1, borderColor: colors.red, backgroundColor: colors.white },
  btnGhost: { borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.white },
  btnText: { fontFamily: fonts.semibold, fontSize: 15.5 },
  screenHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.ivory },
  backBtn: { width: 40, height: 40, alignItems: 'flex-start', justifyContent: 'center' },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, alignSelf: 'flex-start' },
  badgeText: { fontFamily: fonts.semibold, fontSize: 12 },
  qty: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 8, backgroundColor: colors.white },
  qtyBtn: { height: '100%', alignItems: 'center', justifyContent: 'center' },
  qtyValue: { textAlign: 'center', fontFamily: fonts.semibold, fontSize: 15, color: colors.ink },
  stepper: { flexDirection: 'row', justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 10 },
  step: { flex: 1, alignItems: 'center', gap: 6 },
  stepLine: { position: 'absolute', top: 16, left: '-50%', right: '50%', height: 2, backgroundColor: colors.lineStrong, zIndex: 0 },
  stepNum: { zIndex: 1, elevation: 1, width: 34, height: 34, borderRadius: 17, borderWidth: 2, borderColor: colors.lineStrong, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  stepNumActive: { backgroundColor: colors.primaryStrong, borderColor: colors.primaryStrong },
  stepNumDone: { borderColor: colors.red },
  stepNumText: { fontFamily: fonts.bold, color: colors.muted, fontSize: 14 },
  stepLabel: { fontFamily: fonts.regular, color: colors.muted, fontSize: 13 },
  empty: { alignItems: 'center', padding: 32, margin: 16, backgroundColor: colors.white, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  productTile: { backgroundColor: colors.white, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 8, ...shadow },
  productMedia: { backgroundColor: colors.cream, borderRadius: 8, aspectRatio: 1.15, overflow: 'hidden', padding: 6 },
  heart: { position: 'absolute', top: 14, right: 14, width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.95)', alignItems: 'center', justifyContent: 'center' },
  productName: { fontFamily: fonts.bold, fontSize: 14, color: colors.ink },
  productSub: { fontFamily: fonts.regular, fontSize: 12, color: colors.muted, marginTop: 2 },
  oos: { marginTop: 8, backgroundColor: '#f6f1eb', borderRadius: 6, paddingVertical: 9, alignItems: 'center' },
  oosText: { fontFamily: fonts.medium, color: colors.muted, fontSize: 13 },
  alert: { padding: 12, borderRadius: 8 },
  trackDot: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.lineStrong, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  trackLine: { width: 2, flex: 1, minHeight: 18, backgroundColor: colors.lineStrong },
  summary: { gap: 10 },
  summaryDivider: { height: 1, backgroundColor: colors.line, marginVertical: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  card: { backgroundColor: colors.white, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 14 },
  cartStepper: { flexDirection: 'row', alignItems: 'center', borderWidth: 1.5, borderColor: colors.red, borderRadius: 8, backgroundColor: colors.redSoft, overflow: 'hidden' },
  cartStepBtn: { height: '100%', backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center' },
  cartStepValue: { flex: 1, textAlign: 'center', fontFamily: fonts.bold, fontSize: 15, color: colors.red },
  cartStepIn: { fontFamily: fonts.medium, fontSize: 11.5 },
});
