import type { CategoryNode } from '@sac/contracts';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { ChevronRight, Search } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../api';
import { cached } from '../cache';
import { Button, EmptyState, Loading, Title } from '../components/ui';
import { mediaUrl } from '../config';
import type { RootStackParamList } from '../navigation-types';
import { errorMessage } from '../session';
import { colors, fonts } from '../theme';

export function CategoriesScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const [categories, setCategories] = useState<CategoryNode[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setCategories((await cached('categories', () => api.categories())).data); setError(''); } catch (err) { setError(errorMessage(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <View style={s.head}><View style={{ width: 26 }} /><Title size={20}>All Categories</Title><Pressable accessibilityLabel="Search" onPress={() => navigation.navigate('Search')} hitSlop={10}><Search size={22} color={colors.ink} /></Pressable></View>
      {error ? <EmptyState title="Cannot load categories" body={error} action={<Button title="Try again" onPress={() => void load()} />} /> : !categories ? <Loading /> : (
        <FlatList data={categories} keyExtractor={item => item.id} contentContainerStyle={{ paddingBottom: 90 }}
          renderItem={({ item }) => (
            <Pressable style={s.row} onPress={() => navigation.navigate('CategoryProducts', { slug: item.slug, title: item.name })} accessibilityRole="button">
              <View style={s.thumb}>{item.thumb_url && <Image source={{ uri: mediaUrl(item.thumb_url) }} style={{ width: 52, height: 44 }} resizeMode="contain" />}</View>
              <Text style={s.name}>{item.name}</Text>
              <ChevronRight size={20} color={colors.muted} />
            </Pressable>
          )} />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.white },
  thumb: { width: 60, height: 52, alignItems: 'center', justifyContent: 'center' },
  name: { flex: 1, fontFamily: fonts.medium, fontSize: 15.5, color: colors.ink },
});
