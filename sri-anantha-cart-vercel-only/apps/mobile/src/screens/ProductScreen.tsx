import { type ProductDetail } from '@sac/contracts';
import { formatRupees } from '@sac/shared';
import { useNavigation, useRoute, type NavigationProp, type RouteProp } from '@react-navigation/native';
import { ChevronLeft, Clock, Flower2, Heart, Leaf, Share2, ShieldCheck, ShoppingCart, Sparkles } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, Share, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../api';
import { cached } from '../cache';
import { Badge, Body, Button, CartStepper, EmptyState, Loading, Price, ProductTile, QuantityStepper, Title, productGrid } from '../components/ui';
import { mediaUrl, WEB_URL } from '../config';
import type { RootStackParamList } from '../navigation-types';
import { errorMessage, useSession } from '../session';
import { colors, fonts, radius } from '../theme';

const ICONS = [ShieldCheck, Flower2, Clock, Sparkles, Leaf];

export function ProductScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { params } = useRoute<RouteProp<RootStackParamList, 'Product'>>();
  const { width, height } = useWindowDimensions();
  // Landscape and tablets: cap the photo so the price and Add to Cart stay on screen.
  const imageHeight = Math.min(width * 0.78, height * 0.5);
  const { addToCart, wishlist, toggleWishlist, lineFor } = useSession();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [error, setError] = useState('');
  const [image, setImage] = useState(0);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await cached(`product-${params.slug}`, () => api.product(params.slug));
      setProduct(result.data);
      setVariantId((result.data.variants.find(item => item.max_quantity > 0) ?? result.data.variants[0])?.id ?? null);
    } catch (err) { setError(errorMessage(err, 'This product is unavailable')); }
  }, [params.slug]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }}><EmptyState title="Product unavailable" body={error} action={<Button title="Go back" onPress={() => navigation.goBack()} />} /></SafeAreaView>;
  if (!product) return <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }}><Loading /></SafeAreaView>;

  const variant = product.variants.find(item => item.id === variantId) ?? null;
  const price = variant?.price_paise ?? product.price_paise;
  const mrp = variant?.mrp_paise ?? product.mrp_paise;
  const max = variant ? variant.max_quantity : product.max_quantity;
  const stock = variant?.stock_status ?? product.stock_status;
  const saved = wishlist.has(product.id);
  const { tileWidth } = productGrid(width);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ backgroundColor: colors.cream }}>
          <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} onMomentumScrollEnd={event => setImage(Math.round(event.nativeEvent.contentOffset.x / width))}>
            {product.images.map(item => <Image key={item.url} source={{ uri: mediaUrl(item.url) }} style={{ width, height: imageHeight }} resizeMode="contain" accessibilityLabel={item.alt_text ?? product.name} />)}
          </ScrollView>
          <View style={s.overlay}>
            <Pressable style={s.round} onPress={() => navigation.goBack()} accessibilityLabel="Go back"><ChevronLeft size={24} color={colors.ink} /></Pressable>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable style={s.round} onPress={() => void toggleWishlist(product.id)} accessibilityLabel={saved ? 'Remove from wishlist' : 'Save to wishlist'}><Heart size={21} color={colors.red} fill={saved ? colors.red : 'transparent'} /></Pressable>
              <Pressable style={s.round} onPress={() => void Share.share({ message: `${product.name} — ${formatRupees(price)} on Sri Anantha Cart\n${WEB_URL}/products/${product.slug}` })} accessibilityLabel="Share"><Share2 size={20} color={colors.red} /></Pressable>
            </View>
          </View>
          {product.images.length > 1 && <View style={s.dots}>{product.images.map((_, index) => <View key={index} style={[s.dot, index === image && { backgroundColor: colors.red, width: 8 }]} />)}</View>}
        </View>
        <View style={{ padding: 16, gap: 10 }}>
          <Title size={24}>{product.name}</Title>
          {product.short_description && <Body muted size={15}>{product.short_description}</Body>}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Price paise={price} mrp={mrp} size={26} />
            <Badge label={stock === 'out_of_stock' ? 'Out of Stock' : stock === 'low_stock' ? 'Only a few left' : 'In Stock'} tone={stock === 'out_of_stock' ? 'danger' : stock === 'low_stock' ? 'warning' : 'success'} />
          </View>
          <Body muted size={12}>{product.gst_rate_basis_points ? `Inclusive of ${product.gst_rate_basis_points / 100}% GST` : 'Inclusive of all taxes'}</Body>
          {product.variants.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {product.variants.map(item => (
                <Pressable key={item.id} disabled={item.max_quantity === 0} onPress={() => { setVariantId(item.id); setQuantity(1); }} style={[s.variant, item.id === variantId && s.variantActive, item.max_quantity === 0 && { opacity: 0.45 }]} accessibilityState={{ selected: item.id === variantId }}>
                  <Text style={s.variantLabel}>{item.label}</Text><Text style={s.variantPrice}>{item.max_quantity === 0 ? 'Out of stock' : formatRupees(item.price_paise)}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {lineFor(product.id, variantId) ? (
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 4 }}>
              <View style={{ flex: 1 }}><CartStepper productId={product.id} variantId={variantId} name={product.name} large /></View>
              <Button title="Go to Cart" icon={<ShoppingCart size={19} color={colors.white} />} style={{ flex: 1 }} onPress={() => navigation.navigate('Tabs', { screen: 'Cart' })} />
            </View>
          ) : (
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 4 }}>
              <QuantityStepper value={quantity} max={Math.max(1, max)} onChange={value => setQuantity(Math.min(Math.max(1, value), Math.max(1, max)))} />
              <Button title={max === 0 ? 'Out of Stock' : 'Add to Cart'} disabled={max === 0} loading={busy} icon={<ShoppingCart size={19} color={colors.white} />} style={{ flex: 1 }}
                onPress={async () => { setBusy(true); await addToCart(product.id, quantity, variantId); setBusy(false); }} />
            </View>
          )}
          <Text style={s.h3}>Product Description</Text>
          <Body muted style={{ color: colors.ink2 }}>{product.description}</Body>
          {product.highlights.length > 0 && (
            <View style={s.highlights}>
              {product.highlights.map((text, index) => { const Icon = ICONS[index % ICONS.length]!; return <View key={text} style={s.highlight}><Icon size={22} color={colors.saffron} /><Text style={s.highlightText}>{text}</Text></View>; })}
            </View>
          )}
        </View>
        {product.related.length > 0 && (
          <View style={{ paddingHorizontal: 16 }}>
            <Title size={19} style={{ marginBottom: 10 }}>You may also like</Title>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>{product.related.slice(0, 4).map(item => <ProductTile key={item.id} product={item} width={tileWidth} onPress={() => navigation.navigate('Product', { slug: item.slug })} />)}</View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  overlay: { position: 'absolute', top: 10, left: 12, right: 12, flexDirection: 'row', justifyContent: 'space-between' },
  round: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, paddingVertical: 10 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.lineStrong },
  variant: { borderWidth: 1.5, borderColor: colors.lineStrong, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.white },
  variantActive: { borderColor: colors.red, backgroundColor: colors.redSoft },
  variantLabel: { fontFamily: fonts.semibold, fontSize: 14, color: colors.ink },
  variantPrice: { fontFamily: fonts.regular, fontSize: 12, color: colors.muted },
  h3: { fontFamily: fonts.bold, fontSize: 16, color: colors.ink, marginTop: 10 },
  highlights: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  highlight: { width: '23%', minWidth: 76, flexGrow: 1, alignItems: 'center', gap: 6, paddingVertical: 12, paddingHorizontal: 4, backgroundColor: colors.white, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  highlightText: { fontFamily: fonts.medium, fontSize: 11.5, textAlign: 'center', color: colors.ink2 },
});
