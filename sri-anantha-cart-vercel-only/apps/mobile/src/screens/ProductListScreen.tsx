import type { CategoryNode, ProductCard, ProductFilterFacets } from '@sac/contracts';
import { useNavigation, useRoute, type NavigationProp, type RouteProp } from '@react-navigation/native';
import { Search as SearchIcon, SlidersHorizontal, WifiOff, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../api';
import { cached } from '../cache';
import { Body, Button, EmptyState, productGrid, ProductTile, ScreenHeader, Title } from '../components/ui';
import type { RootStackParamList } from '../navigation-types';
import { errorMessage } from '../session';
import { colors, fonts, radius } from '../theme';

const SORTS = [['relevance', 'Best match'], ['popular', 'Popular'], ['price_asc', 'Price ↑'], ['price_desc', 'Price ↓'], ['newest', 'Newest']] as const;
const PAGE = 12;

/** Category listing (with subcategory chips) and full-text search share one screen. */
export function ProductListScreen({ mode }: { mode: 'category' | 'search' }) {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, 'CategoryProducts' | 'Search'>>();
  const params = (route.params ?? {}) as { slug?: string; title?: string; q?: string };
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState(params.q ?? '');
  const [submitted, setSubmitted] = useState(params.q ?? '');
  const [slug, setSlug] = useState(params.slug);
  const [sort, setSort] = useState(mode === 'search' ? 'relevance' : 'popular');
  const [filterOpen, setFilterOpen] = useState(false);
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [inStock, setInStock] = useState(false);
  const [featured, setFeatured] = useState(false);
  const [discountOnly, setDiscountOnly] = useState(false);
  const [draftMinPrice, setDraftMinPrice] = useState('');
  const [draftMaxPrice, setDraftMaxPrice] = useState('');
  const [draftInStock, setDraftInStock] = useState(false);
  const [draftFeatured, setDraftFeatured] = useState(false);
  const [draftDiscountOnly, setDraftDiscountOnly] = useState(false);
  const [filterError, setFilterError] = useState('');
  const [similar, setSimilar] = useState<ProductCard[]>([]);
  const [items, setItems] = useState<ProductCard[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState('');
  const [parent, setParent] = useState<CategoryNode | null>(null);
  const [facets, setFacets] = useState<ProductFilterFacets | null>(null);

  useEffect(() => {
    if (mode !== 'category' || !params.slug) return;
    void cached('categories', () => api.categories()).then(result => {
      setParent(result.data.find(item => item.slug === params.slug || item.children.some(child => child.slug === params.slug)) ?? null);
    }).catch(() => undefined);
  }, [mode, params.slug]);

  useEffect(() => { void api.productFilters(mode === 'category' ? slug : undefined, mode === 'search' ? submitted || undefined : undefined).then(setFacets).catch(() => setFacets(null)); }, [mode, slug, submitted]);

  const load = useCallback(async (offset = 0) => {
    const request = () => api.products({ ...(mode === 'category' ? { category: slug } : { q: submitted || undefined }), sort, limit: PAGE, offset, min_price: minPrice ? Number(minPrice) * 100 : undefined, max_price: maxPrice ? Number(maxPrice) * 100 : undefined, in_stock: inStock || undefined, featured: featured || undefined, discount_only: discountOnly || undefined });
    try {
      const key = `list-${mode}-${slug ?? submitted}-${sort}-${minPrice}-${maxPrice}-${inStock}-${featured}-${discountOnly}-${offset}`;
      const result = await cached(key, request);
      setOffline(result.offline);
      setTotal(result.data.pagination.total);
      setItems(current => (offset === 0 ? result.data.data : [...(current ?? []), ...result.data.data]));
      if (offset === 0) setSimilar(mode === 'search' ? result.data.similar ?? [] : []);
      setError('');
    } catch (err) { setError(errorMessage(err)); if (offset === 0) setItems([]); }
  }, [mode, slug, submitted, sort, minPrice, maxPrice, inStock, featured, discountOnly]);
  useEffect(() => { setItems(null); void load(0); }, [load]);

  const chips = useMemo(() => parent && parent.children.length ? [{ slug: parent.slug, name: 'All' }, ...parent.children.map(child => ({ slug: child.slug, name: child.name }))] : [], [parent]);
  const { columns, tileWidth } = productGrid(width);
  const title = mode === 'search' ? 'Search' : parent && slug !== parent.slug ? parent.name : params.title ?? 'Products';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <ScreenHeader title={title} right={mode === 'category' ? <Pressable accessibilityLabel="Search" onPress={() => navigation.navigate('Search')}><SearchIcon size={22} color={colors.ink} /></Pressable> : undefined} />
      {mode === 'search' && (
        <View style={s.searchBox}>
          <SearchIcon size={18} color={colors.muted} />
          <TextInput style={s.input} value={query} onChangeText={setQuery} placeholder="Search pooja items…" placeholderTextColor={colors.muted2} autoFocus returnKeyType="search" onSubmitEditing={() => setSubmitted(query.trim())} maxLength={100} accessibilityLabel="Search products" />
          {query ? <Pressable accessibilityLabel="Clear search" onPress={() => { setQuery(''); setSubmitted(''); }}><X size={18} color={colors.muted} /></Pressable> : null}
        </View>
      )}
      {chips.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips} style={{ flexGrow: 0 }}>
          {chips.map(chip => <Pressable key={chip.slug} onPress={() => setSlug(chip.slug)} style={[s.chip, chip.slug === slug && s.chipActive]}><Text style={[s.chipText, chip.slug === slug && { color: colors.white }]}>{chip.name}</Text></Pressable>)}
        </ScrollView>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
        <Pressable onPress={() => { setDraftMinPrice(minPrice); setDraftMaxPrice(maxPrice); setDraftInStock(inStock); setDraftFeatured(featured); setDraftDiscountOnly(discountOnly); setFilterError(''); setFilterOpen(true); }} style={s.filterButton}><SlidersHorizontal size={16} color={colors.red}/><Text style={{ color: colors.red, fontFamily: fonts.semibold, fontSize: 12.5 }}>Filters{[minPrice,maxPrice,inStock,featured,discountOnly].filter(Boolean).length ? ` • ${[minPrice,maxPrice,inStock,featured,discountOnly].filter(Boolean).length}` : ''}</Text></Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {SORTS.filter(([value]) => value !== 'relevance' || mode === 'search').map(([value, label]) => <Pressable key={value} onPress={() => setSort(value)} style={[s.sort, sort === value && s.sortActive]}><Text style={[s.sortText, sort === value && { color: colors.red }]}>{label}</Text></Pressable>)}
        </ScrollView>
      </View>
      {offline && <View style={s.offline}><WifiOff size={15} color={colors.amber} /><Body size={12} style={{ color: colors.amber }}>Offline — saved results; prices may have changed.</Body></View>}
      {items === null ? <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} /> : error && !items.length ? (
        <EmptyState title="Something went wrong" body={error} action={<Button title="Try again" onPress={() => void load(0)} />} />
      ) : (
        <FlatList key={`grid-${columns}`} data={items} numColumns={columns} keyExtractor={item => item.id} columnWrapperStyle={{ gap: 12, paddingHorizontal: 16 }} contentContainerStyle={{ gap: 12, paddingBottom: 90, paddingTop: 4 }}
          renderItem={({ item }) => <ProductTile product={item} width={tileWidth} onPress={() => navigation.navigate('Product', { slug: item.slug })} />}
          ListEmptyComponent={similar.length ? <View style={{ paddingHorizontal: 16 }}><Title size={17}>No exact matches for “{submitted}”</Title><Body muted size={13}>Check the spelling, or try one of these similar products.</Body></View>
            : <EmptyState title={mode === 'search' && !submitted ? 'Search the store' : 'No products found'} body={mode === 'search' && !submitted ? 'Try “agarbatti”, “kumkum” or “diya”.' : 'Try another category or search term.'} />}
          onEndReachedThreshold={0.4}
          onEndReached={async () => { if (loadingMore || (items.length >= total)) return; setLoadingMore(true); await load(items.length); setLoadingMore(false); }}
          ListFooterComponent={<>
            {loadingMore ? <ActivityIndicator color={colors.primary} /> : null}
            {similar.length > 0 && items.length >= total && (
              <View style={{ paddingHorizontal: 16, gap: 12, marginTop: 12 }}>
                <Title size={18}>{items.length ? 'Similar products' : 'You might be looking for'}</Title>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>{similar.map(item => <ProductTile key={item.id} product={item} width={tileWidth} onPress={() => navigation.navigate('Product', { slug: item.slug })} />)}</View>
              </View>
            )}
          </>} />
      )}

      <Modal visible={filterOpen} transparent animationType="slide" onRequestClose={() => setFilterOpen(false)}>
        <View style={s.filterBackdrop}><Pressable style={{flex:1}} onPress={()=>setFilterOpen(false)}/><View style={s.filterSheet}>
          <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}><Title size={20}>Filter products</Title><Pressable onPress={()=>setFilterOpen(false)} accessibilityLabel="Close filters"><X color={colors.ink}/></Pressable></View>
          <View style={s.filterGroup}><Title size={16}>Price range (₹)</Title>{facets && facets.price_max_paise > 0 ? <Body muted size={12}>Available ₹{Math.floor(facets.price_min_paise / 100)}–₹{Math.ceil(facets.price_max_paise / 100)}</Body> : null}<View style={{flexDirection:'row',gap:10}}><TextInput value={draftMinPrice} onChangeText={v=>setDraftMinPrice(v.replace(/\D/g,''))} keyboardType="number-pad" placeholder="Min" style={s.priceInput} accessibilityLabel="Minimum price"/><TextInput value={draftMaxPrice} onChangeText={v=>setDraftMaxPrice(v.replace(/\D/g,''))} keyboardType="number-pad" placeholder="Max" style={s.priceInput} accessibilityLabel="Maximum price"/></View>{filterError ? <Body size={12} style={{color:colors.red}}>{filterError}</Body> : null}</View>
          {([['inStock','In stock only'],['discountOnly','On sale'],['featured','Featured products']] as const).map(([key,label])=><Pressable key={key} accessibilityRole="checkbox" accessibilityState={{checked:key==='inStock'?draftInStock:key==='discountOnly'?draftDiscountOnly:draftFeatured}} onPress={()=>key==='inStock'?setDraftInStock(v=>!v):key==='discountOnly'?setDraftDiscountOnly(v=>!v):setDraftFeatured(v=>!v)} style={s.filterOption}><Body weight="semibold">{(key==='inStock'?draftInStock:key==='discountOnly'?draftDiscountOnly:draftFeatured)?'☑':'□'}  {label}{facets ? ` (${key==='inStock'?facets.counts.in_stock:key==='discountOnly'?facets.counts.discounted:facets.counts.featured})` : ''}</Body></Pressable>)}
          <View style={{flexDirection:'row',gap:10}}><Button title="Reset" variant="outline" onPress={()=>{setDraftMinPrice('');setDraftMaxPrice('');setDraftInStock(false);setDraftFeatured(false);setDraftDiscountOnly(false);setFilterError('')}} style={{flex:1}}/><Button title="Show products" onPress={()=>{if(draftMinPrice&&draftMaxPrice&&Number(draftMinPrice)>Number(draftMaxPrice)){setFilterError('Minimum price must not exceed maximum price.');return;}setMinPrice(draftMinPrice);setMaxPrice(draftMaxPrice);setInStock(draftInStock);setFeatured(draftFeatured);setDiscountOnly(draftDiscountOnly);setFilterError('');setFilterOpen(false);}} style={{flex:2}}/></View>
        </View></View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  searchBox: { marginHorizontal: 16, marginBottom: 8, height: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.white, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12 },
  input: { flex: 1, fontFamily: fonts.regular, fontSize: 15, color: colors.ink },
  chips: { gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.white },
  chipActive: { backgroundColor: colors.primaryStrong, borderColor: colors.primaryStrong },
  chipText: { fontFamily: fonts.semibold, fontSize: 12.5, color: colors.ink2 },
  sort: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill },
  sortActive: { backgroundColor: colors.redSoft },
  sortText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.muted },
  offline: { flexDirection: 'row', gap: 6, alignItems: 'center', marginHorizontal: 16, marginBottom: 6, padding: 8, backgroundColor: colors.amberSoft, borderRadius: 8 },
  filterButton: { height: 38, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, borderRadius: 9, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.white },
  filterBackdrop: { flex: 1, backgroundColor: 'rgba(20,10,5,0.4)', justifyContent: 'flex-end' },
  filterSheet: { backgroundColor: colors.ivory, padding: 18, paddingBottom: 26, borderTopLeftRadius: 20, borderTopRightRadius: 20, gap: 16 },
  filterGroup: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 14, gap: 10 },
  priceInput: { flex: 1, height: 44, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 8, paddingHorizontal: 12, backgroundColor: colors.white, color: colors.ink },
  filterOption: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4 },
});