import { type CategoryNode, type ProductCard } from '@sac/contracts';
import { formatRupees } from '@sac/shared';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { Plus, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../api';
import { cached } from '../cache';
import { Body } from '../components/ui';
import { mediaUrl } from '../config';
import type { RootStackParamList } from '../navigation-types';
import { useSession } from '../session';
import { colors, fonts } from '../theme';

type Message = { id: number; from: 'bot' | 'me'; text?: string; products?: ProductCard[]; choices?: 'categories' | 'after' | 'fallback'; category?: { slug: string; name: string } };
const KITS = 'pooja-kits';

/** Button-driven guided shopping (no free text, no AI) — same flow as the website. */
export function AssistantScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { addToCart } = useSession();
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [messages, setMessages] = useState<Message[]>([{ id: 1, from: 'bot', text: 'Namaste! 🙏 What are you looking for today?' }, { id: 2, from: 'bot', choices: 'categories' }]);
  const [loading, setLoading] = useState(false);
  const nextId = useRef(3);
  const scroll = useRef<ScrollView>(null);
  useEffect(() => { void cached('categories', () => api.categories()).then(result => setCategories(result.data)).catch(() => undefined); }, []);
  const push = (...items: Omit<Message, 'id'>[]) => setMessages(current => [...current, ...items.map(item => ({ ...item, id: nextId.current++ }))]);
  const show = async (slug: string, name: string, said = name) => {
    push({ from: 'me', text: said });
    setLoading(true);
    try {
      const result = await api.products({ category: slug, sort: 'popular', limit: 4, in_stock: true });
      if (!result.data.length) push({ from: 'bot', text: `${name} is restocking right now.` }, { from: 'bot', choices: 'fallback' });
      else push({ from: 'bot', text: slug === KITS ? 'Here are our ready-made pooja kits:' : `Top picks in ${name}:` }, { from: 'bot', products: result.data, category: { slug, name } }, { from: 'bot', choices: 'after' });
    } catch { push({ from: 'bot', text: 'I could not load products just now.' }, { from: 'bot', choices: 'fallback' }); }
    finally { setLoading(false); }
  };
  const Chip = ({ label, onPress }: { label: string; onPress: () => void }) => <Pressable onPress={onPress} style={s.chip}><Text style={s.chipText}>{label}</Text></Pressable>;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }}>
      <View style={s.head}>
        <Image source={require('../../assets/lotus.png')} style={s.headIcon} resizeMode="contain" />
        <View style={{ flex: 1 }}><Text style={s.headTitle}>Shopping Assistant</Text><Text style={s.headSub}>Find pooja essentials in a few taps</Text></View>
        <Pressable onPress={() => navigation.goBack()} accessibilityLabel="Close assistant" hitSlop={10}><X size={24} color={colors.white} /></Pressable>
      </View>
      <ScrollView ref={scroll} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} contentContainerStyle={{ padding: 16, gap: 10 }}>
        {messages.map(message => {
          if (message.text) return <View key={message.id} style={[s.bubble, message.from === 'me' ? s.me : s.bot]}><Text style={[s.bubbleText, message.from === 'me' && { color: colors.white }]}>{message.text}</Text></View>;
          if (message.products) return (
            <View key={message.id} style={{ gap: 8 }}>
              {message.products.map(product => (
                <View key={product.id} style={s.card}>
                  {product.thumb_url && <Image source={{ uri: mediaUrl(product.thumb_url) }} style={s.cardImg} resizeMode="contain" />}
                  <Pressable style={{ flex: 1 }} onPress={() => navigation.navigate('Product', { slug: product.slug })}><Body weight="semibold" size={13.5}>{product.name}</Body><Text style={s.price}>{product.has_variants ? 'From ' : ''}{formatRupees(product.price_paise)}</Text></Pressable>
                  <Pressable accessibilityLabel={`Add ${product.name}`} style={s.add} onPress={() => (product.has_variants ? navigation.navigate('Product', { slug: product.slug }) : void addToCart(product.id, 1))}><Plus size={16} color={colors.red} /><Text style={s.addText}>{product.has_variants ? 'Options' : 'Add'}</Text></Pressable>
                </View>
              ))}
              {message.category && <Pressable onPress={() => navigation.navigate('CategoryProducts', { slug: message.category!.slug, title: message.category!.name })}><Text style={s.link}>See all {message.category.name} →</Text></Pressable>}
            </View>
          );
          if (message.choices === 'categories') return (
            <View key={message.id} style={s.chips}>
              {categories.filter(item => item.slug !== KITS).map(item => <Chip key={item.id} label={item.name} onPress={() => void show(item.slug, item.name)} />)}
              <Chip label="Need a complete puja set?" onPress={() => void show(KITS, 'Pooja Kits', 'Need a complete puja set?')} />
              <Chip label="Something else" onPress={() => push({ from: 'me', text: 'Something else' }, { from: 'bot', choices: 'fallback' })} />
            </View>
          );
          if (message.choices === 'after') return (
            <View key={message.id} style={s.chips}>
              <Chip label="Another category" onPress={() => push({ from: 'bot', text: 'Sure! Pick a category:' }, { from: 'bot', choices: 'categories' })} />
              <Chip label="Complete puja set" onPress={() => void show(KITS, 'Pooja Kits', 'Need a complete puja set?')} />
            </View>
          );
          return (
            <View key={message.id} style={[s.bubble, s.bot]}>
              <Text style={s.bubbleText}>You can browse our full catalogue, or reach our support team from Profile → Contact Us.</Text>
              <View style={[s.chips, { marginTop: 8 }]}>
                <Chip label="Browse catalogue" onPress={() => navigation.navigate('Tabs', { screen: 'Categories' })} />
                <Chip label="Start again" onPress={() => push({ from: 'bot', text: 'What are you looking for?' }, { from: 'bot', choices: 'categories' })} />
              </View>
            </View>
          );
        })}
        {loading && <ActivityIndicator color={colors.primary} style={{ alignSelf: 'flex-start' }} />}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.primary, paddingHorizontal: 16, paddingVertical: 14 },
  headIcon: { width: 38, height: 38, backgroundColor: colors.white, borderRadius: 19 },
  headTitle: { color: colors.white, fontFamily: fonts.bold, fontSize: 16 },
  headSub: { color: '#ffd9c6', fontFamily: fonts.regular, fontSize: 12 },
  bubble: { maxWidth: '88%', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 14 },
  bot: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderTopLeftRadius: 4, alignSelf: 'flex-start' },
  me: { backgroundColor: colors.primary, borderTopRightRadius: 4, alignSelf: 'flex-end' },
  bubbleText: { fontFamily: fonts.regular, fontSize: 14, color: colors.ink, lineHeight: 20 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: colors.red, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: colors.white },
  chipText: { color: colors.red, fontFamily: fonts.semibold, fontSize: 13 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.white, borderRadius: 10, borderWidth: 1, borderColor: colors.line, padding: 8 },
  cardImg: { width: 54, height: 54, backgroundColor: colors.cream, borderRadius: 8 },
  price: { fontFamily: fonts.bold, color: colors.red, fontSize: 14 },
  add: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: colors.red, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  addText: { color: colors.red, fontFamily: fonts.semibold, fontSize: 13 },
  link: { color: colors.red, fontFamily: fonts.semibold, fontSize: 13 },
});
