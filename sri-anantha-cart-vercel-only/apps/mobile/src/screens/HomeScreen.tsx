import type { HomeData } from '@sac/contracts';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { ArrowRight, Bell, Leaf, MessageCircle, Search, ShieldCheck, Truck, WifiOff } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Image, ImageBackground, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../api';
import { cached } from '../cache';
import { Body, Button, EmptyState, Loading, ProductTile, Title, productGrid } from '../components/ui';
import { mediaUrl } from '../config';
import type { RootStackParamList } from '../navigation-types';
import { errorMessage, useSession } from '../session';
import { colors, fonts, radius } from '../theme';

export function HomeScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { width } = useWindowDimensions();
  const { user } = useSession();
  const [data, setData] = useState<HomeData | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [activeOrders, setActiveOrders] = useState(0);

  const load = useCallback(async () => {
    try {
      const result = await cached('home', () => api.home());
      setData(result.data); setOffline(result.offline); setError('');
    } catch (err) { setError(errorMessage(err)); }
    if (user) api.orders('processing').then(list => setActiveOrders(list.length)).catch(() => undefined);
  }, [user]);
  useEffect(() => { void load(); }, [load]);

  const { tileWidth } = productGrid(width);
  const catColumns = width >= 720 ? 6 : 3;
  const catWidth = (width - 16 * 2 - 10 * (catColumns - 1)) / catColumns;
  if (!data && !error) return <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }}><Loading /></SafeAreaView>;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <View style={s.header}>
        <Image source={require('../../assets/logo-full.png')} style={s.logo} resizeMode="contain" accessibilityLabel="Sri Anantha Cart" />
        <View style={s.headerIcons}>
          {/* The assistant lives in the header: a floating button would cover products and Add to Cart. */}
          <Pressable style={s.headerIcon} onPress={() => navigation.navigate('Assistant')} accessibilityRole="button" accessibilityLabel="Open shopping assistant">
            <MessageCircle size={25} color={colors.ink} />
          </Pressable>
          <Pressable style={s.headerIcon} accessibilityLabel={`Orders in progress: ${activeOrders}`} onPress={() => navigation.navigate('Tabs', { screen: 'Orders' })}>
            <Bell size={26} color={colors.ink} />
            {activeOrders > 0 && <View style={s.dot}><Text style={s.dotText}>{activeOrders}</Text></View>}
          </Pressable>
        </View>
      </View>
      <Pressable style={s.search} onPress={() => navigation.navigate('Search')} accessibilityRole="search">
        <Search size={18} color={colors.ink} /><Text style={s.searchText}>Search for pooja items, brands, or occasions...</Text>
      </Pressable>
      <ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />} contentContainerStyle={{ paddingBottom: 90 }}>
        {offline && <View style={s.offline}><WifiOff size={16} color={colors.amber} /><Body size={12.5} style={{ color: colors.amber, flex: 1 }}>Offline — showing your saved catalogue. Prices and stock may have changed.</Body></View>}
        {error ? <EmptyState title="Cannot load the store" body={error} action={<Button title="Try again" onPress={() => void load()} />} /> : null}
        <ImageBackground source={require('../../assets/hero-temple.jpg')} style={s.hero} imageStyle={{ opacity: 1 }}>
          <View style={s.heroShade} />
          <Text style={s.heroTitle}>Everything{'\n'}for your Pooja,{'\n'}Now at Your{'\n'}Doorstep</Text>
          <Text style={s.heroSub}>Pure. Traditional. Authentic.{'\n'}Delivered in 15-30 minutes{'\n'}in Tirupati.</Text>
          <Button title="Shop Now" icon={null} onPress={() => navigation.navigate('Tabs', { screen: 'Categories' })} style={{ alignSelf: 'flex-start', marginTop: 12, paddingHorizontal: 20 }} />
        </ImageBackground>
        <View style={s.features}>
          {[[Truck, '15-30 Min\nDelivery'], [ShieldCheck, 'Authentic\nProducts'], [Leaf, 'Pure &\nTraditional'], [ShieldCheck, 'Trusted in\nTirupati']].map(([Icon, label], index) => {
            const I = Icon as typeof Truck;
            return <View key={index} style={s.feature}><I size={24} color={colors.red} /><Text style={s.featureText}>{label as string}</Text></View>;
          })}
        </View>
        {data && (
          <>
            <View style={s.sectionHead}><Title size={20}>Shop by Category</Title><Pressable onPress={() => navigation.navigate('Tabs', { screen: 'Categories' })} style={s.viewAll}><Text style={s.viewAllText}>View All</Text><ArrowRight size={16} color={colors.red} /></Pressable></View>
            <View style={s.catGrid}>
              {(data.featured_categories?.length ? data.featured_categories : data.categories).map(category => (
                <Pressable key={category.id} style={[s.catTile, { width: catWidth }]} onPress={() => navigation.navigate('CategoryProducts', { slug: category.slug, title: category.name })} accessibilityRole="button" accessibilityLabel={category.name}>
                  {category.thumb_url && <Image source={{ uri: mediaUrl(category.thumb_url) }} style={{ width: catWidth - 24, height: catWidth - 34 }} resizeMode="contain" />}
                  <Text style={s.catText} numberOfLines={1}>{category.name}</Text>
                </Pressable>
              ))}
            </View>
            <View style={s.sectionHead}><Title size={20}>Popular Products</Title><Pressable onPress={() => navigation.navigate('Search', {})} style={s.viewAll}><Text style={s.viewAllText}>View All</Text><ArrowRight size={16} color={colors.red} /></Pressable></View>
            <View style={s.grid}>{data.popular.map(product => <ProductTile key={product.id} product={product} width={tileWidth} onPress={() => navigation.navigate('Product', { slug: product.slug })} />)}</View>
            {data.kits.length > 0 && (
              <>
                <View style={s.sectionHead}><Title size={20}>Best Selling Pooja Kits</Title><Pressable onPress={() => navigation.navigate('CategoryProducts', { slug: 'pooja-kits', title: 'Pooja Kits' })} style={s.viewAll}><Text style={s.viewAllText}>View All</Text><ArrowRight size={16} color={colors.red} /></Pressable></View>
                <View style={s.grid}>{data.kits.map(product => <ProductTile key={product.id} product={product} width={tileWidth} onPress={() => navigation.navigate('Product', { slug: product.slug })} />)}</View>
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  headerIcons: { flexDirection: 'row', alignItems: 'center' },
  headerIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 6, paddingBottom: 8 },
  logo: { width: 200, height: 46 },
  dot: { position: 'absolute', top: -6, right: -6, backgroundColor: colors.red, borderRadius: 10, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  dotText: { color: colors.white, fontFamily: fonts.bold, fontSize: 11 },
  search: { marginHorizontal: 16, marginBottom: 10, height: 44, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.white, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 },
  searchText: { color: colors.muted2, fontFamily: fonts.regular, fontSize: 13 },
  offline: { flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: colors.amberSoft, marginHorizontal: 16, marginBottom: 10, padding: 10, borderRadius: 8 },
  hero: { minHeight: 300, paddingHorizontal: 18, paddingVertical: 22, justifyContent: 'center', overflow: 'hidden' },
  heroShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(253, 232, 196, 0.32)' },
  heroTitle: { fontFamily: fonts.serif, fontSize: 28, lineHeight: 33, color: colors.primary },
  heroSub: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 20, color: colors.ink, marginTop: 10 },
  features: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  feature: { flex: 1, alignItems: 'center', backgroundColor: colors.cream, borderRadius: radius.md, paddingVertical: 12, gap: 6 },
  featureText: { textAlign: 'center', fontFamily: fonts.medium, fontSize: 11, color: colors.ink2, lineHeight: 14 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, marginTop: 14, marginBottom: 10 },
  viewAll: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  viewAllText: { color: colors.red, fontFamily: fonts.semibold, fontSize: 13.5 },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 16 },
  catTile: { backgroundColor: colors.cream, borderRadius: radius.md, alignItems: 'center', paddingVertical: 10, gap: 6 },
  catText: { fontFamily: fonts.medium, fontSize: 11.5, color: colors.ink, paddingHorizontal: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: 16 },
});
