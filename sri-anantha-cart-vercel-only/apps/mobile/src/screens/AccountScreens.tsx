import { type Address, type AddressInput, type ProductCard } from '@sac/contracts';
import { ApiRequestError } from '@sac/api-client';
import { formatAddressLine, formatPhone, isValidPostalCode, normalizeIndianMobile } from '@sac/shared';
import { useFocusEffect, useNavigation, useRoute, type NavigationProp, type RouteProp } from '@react-navigation/native';
import * as WebBrowser from 'expo-web-browser';
import { ChevronRight, FileText, Fingerprint, Heart, LocateFixed, LogOut, MapPin, Package, Search, ShieldCheck, UserCog } from 'lucide-react-native';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDeviceLocation } from '../location';
import { api } from '../api';
import { Body, Button, Card, EmptyState, Loading, ProductTile, ScreenHeader, Title } from '../components/ui';
import { WEB_URL } from '../config';
import type { RootStackParamList } from '../navigation-types';
import { errorMessage, useSession } from '../session';
import { colors, fonts, radius } from '../theme';

function MenuItem({ icon, label, onPress, right }: { icon: ReactNode; label: string; onPress?: () => void; right?: ReactNode }) {
  return (
    <Pressable onPress={onPress} style={s.menu} accessibilityRole={onPress ? 'button' : undefined}>
      {icon}<Text style={s.menuText}>{label}</Text>{right ?? (onPress ? <ChevronRight size={18} color={colors.muted} /> : null)}
    </Pressable>
  );
}

export function ProfileScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { user, signOut, biometricEnabled, setBiometric } = useSession();
  const open = (path: string) => void WebBrowser.openBrowserAsync(`${WEB_URL}/${path}`);
  if (!user) {
    // Guests can browse, fill a cart and keep a wishlist; signing in is needed only to order.
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 90 }}>
          <Card style={{ alignItems: 'center', gap: 8, paddingVertical: 22 }}>
            <Title size={20}>Welcome to Sri Anantha Cart</Title>
            <Body muted style={{ textAlign: 'center' }}>Sign in with your mobile number to place orders, track them and save addresses. Your cart and wishlist come with you.</Body>
            <Button title="Sign in with mobile number" onPress={() => navigation.navigate('Login')} style={{ alignSelf: 'stretch', marginTop: 6 }} />
          </Card>
          <Card style={{ padding: 0 }}>
            <MenuItem icon={<Heart size={20} color={colors.red} />} label="Wishlist" onPress={() => navigation.navigate('Wishlist')} />
            <MenuItem icon={<MapPin size={20} color={colors.red} />} label="Check delivery to your area" onPress={() => navigation.navigate('Welcome', { start: 'pin' })} />
            <MenuItem icon={<Search size={20} color={colors.red} />} label="How to use the app" onPress={() => navigation.navigate('Welcome', { start: 'tour' })} />
          </Card>
          <Card style={{ padding: 0 }}>
            <MenuItem icon={<ShieldCheck size={20} color={colors.muted} />} label="Privacy Policy" onPress={() => open('privacy')} />
            <MenuItem icon={<FileText size={20} color={colors.muted} />} label="Terms & Conditions" onPress={() => open('terms')} />
            <MenuItem icon={<FileText size={20} color={colors.muted} />} label="Contact Us" onPress={() => open('contact')} />
          </Card>
        </ScrollView>
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 90 }}>
        <View style={s.profileHead}>
          <View style={s.avatar}><Text style={s.avatarText}>{(user.name ?? 'S').charAt(0).toUpperCase()}</Text></View>
          <View><Title size={20}>{user.name ?? 'Welcome'}</Title><Body muted>{user.phone ? formatPhone(user.phone) : user.email}</Body></View>
        </View>
        <Card style={{ padding: 0 }}>
          <MenuItem icon={<Package size={20} color={colors.red} />} label="My Orders" onPress={() => navigation.navigate('Tabs', { screen: 'Orders' })} />
          <MenuItem icon={<Search size={20} color={colors.red} />} label="Track Order" onPress={() => navigation.navigate('TrackOrder')} />
          <MenuItem icon={<MapPin size={20} color={colors.red} />} label="My Addresses" onPress={() => navigation.navigate('Addresses')} />
          <MenuItem icon={<Heart size={20} color={colors.red} />} label="Wishlist" onPress={() => navigation.navigate('Wishlist')} />
          <MenuItem icon={<UserCog size={20} color={colors.red} />} label="Account Settings" onPress={() => navigation.navigate('AccountSettings')} />
          <MenuItem icon={<Search size={20} color={colors.red} />} label="How to use the app" onPress={() => navigation.navigate('Welcome', { start: 'tour' })} />
          <MenuItem icon={<Fingerprint size={20} color={colors.red} />} label="Unlock with fingerprint" right={<Switch value={biometricEnabled} onValueChange={value => void setBiometric(value)} trackColor={{ true: colors.green, false: colors.lineStrong }} />} />
        </Card>
        <Card style={{ padding: 0 }}>
          <MenuItem icon={<ShieldCheck size={20} color={colors.muted} />} label="Privacy Policy" onPress={() => open('privacy')} />
          <MenuItem icon={<FileText size={20} color={colors.muted} />} label="Terms & Conditions" onPress={() => open('terms')} />
          <MenuItem icon={<FileText size={20} color={colors.muted} />} label="Cancellation & Refund" onPress={() => open('refund-return-policy')} />
          <MenuItem icon={<FileText size={20} color={colors.muted} />} label="Contact Us" onPress={() => open('contact')} />
        </Card>
        <Button variant="outline" title="Logout" icon={<LogOut size={18} color={colors.red} />} onPress={() => Alert.alert('Log out', 'Sign out of this device?', [{ text: 'Cancel', style: 'cancel' }, { text: 'Log out', style: 'destructive', onPress: () => void signOut() }])} />
      </ScrollView>
    </SafeAreaView>
  );
}

export function AddressesScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { params } = useRoute<RouteProp<RootStackParamList, 'Addresses'>>();
  const { toast } = useSession();
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const load = useCallback(() => api.addresses().then(setAddresses).catch(() => setAddresses([])), []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const select = async (address: Address) => {
    try {
      if (!address.is_default) await api.updateAddress(address.id, { is_default: true });
      if (params?.selectMode) navigation.goBack(); else await load();
    } catch (error) { toast(errorMessage(error), 'error'); }
  };
  const remove = (address: Address) => Alert.alert('Delete address', 'Remove this address?', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: async () => { try { await api.deleteAddress(address.id); await load(); } catch (error) { toast(errorMessage(error), 'error'); } } }]);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <ScreenHeader title={params?.selectMode ? 'Choose Address' : 'My Addresses'} />
      {addresses === null ? <Loading /> : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
          {addresses.length === 0 && <EmptyState icon={<MapPin size={40} color={colors.saffron} />} title="No saved addresses" />}
          {addresses.map(address => (
            <Pressable key={address.id} onPress={() => void select(address)} style={[s.address, address.is_default && { borderColor: 'rgba(200,22,29,0.55)', backgroundColor: '#fff8f7' }]} accessibilityRole="radio" accessibilityState={{ checked: address.is_default }}>
              <View style={[s.radio, address.is_default && { borderColor: colors.red }]}>{address.is_default && <View style={s.radioDot} />}</View>
              <View style={{ flex: 1 }}>
                <Body weight="semibold">{address.label ? `${address.label} · ` : ''}{address.recipient_name}</Body>
                <Body muted size={13}>{formatAddressLine(address)}</Body>
                <Body muted size={13}>{formatPhone(address.phone_e164)}</Body>
                <View style={{ flexDirection: 'row', gap: 16, marginTop: 6 }}>
                  <Pressable onPress={() => navigation.navigate('AddressForm', { id: address.id })} hitSlop={8}><Text style={s.link}>Edit</Text></Pressable>
                  <Pressable onPress={() => remove(address)} hitSlop={8}><Text style={s.link}>Delete</Text></Pressable>
                </View>
              </View>
            </Pressable>
          ))}
          <Button variant="outline" title="Add New Address" onPress={() => navigation.navigate('AddressForm')} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const EMPTY: AddressInput = { label: 'Home', recipient_name: '', phone_e164: '', line1: '', line2: '', locality: '', city: 'Tirupati', state: 'Andhra Pradesh', postal_code: '', delivery_instructions: '' };

export function AddressFormScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { params } = useRoute<RouteProp<RootStackParamList, 'AddressForm'>>();
  const { user } = useSession();
  const [form, setForm] = useState<AddressInput>({ ...EMPTY, phone_e164: user?.phone?.replace(/^\+91/, '') ?? '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!params?.id) return;
    void api.addresses().then(list => { const found = list.find(item => item.id === params.id); if (found) setForm({ ...found, phone_e164: found.phone_e164.replace(/^\+91/, ''), line2: found.line2 ?? '', delivery_instructions: found.delivery_instructions ?? '' }); });
  }, [params?.id]);
  const set = (key: keyof AddressInput, value: string) => setForm(current => ({ ...current, [key]: value }));
  const location = useDeviceLocation();
  const [detected, setDetected] = useState('');
  // Fills the fields from the phone's location; every field stays editable.
  const detect = async () => {
    const found = await location.detect();
    if (!found) return;
    setForm(current => ({
      ...current,
      line1: current.line1.trim() ? current.line1 : (found.line1 ?? ''),
      locality: found.locality ?? current.locality, city: found.city ?? current.city, state: found.state ?? current.state,
      postal_code: found.postal_code ?? current.postal_code,
    }));
    setErrors({});
    setDetected(found.display || 'your location');
  };
  const save = async () => {
    const next: Record<string, string> = {};
    const phone = normalizeIndianMobile(form.phone_e164);
    if (form.recipient_name.trim().length < 2) next.recipient_name = 'Enter the recipient name';
    if (!phone) next.phone_e164 = 'Enter a valid 10-digit mobile number';
    if (form.line1.trim().length < 3) next.line1 = 'Enter house / street details';
    if (form.locality.trim().length < 2) next.locality = 'Enter the area';
    if (!isValidPostalCode(form.postal_code)) next.postal_code = 'Enter a valid 6-digit PIN code';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    const payload = { ...form, phone_e164: phone!, line2: form.line2?.trim() || null, delivery_instructions: form.delivery_instructions?.trim() || null, label: form.label || null };
    const { is_default: _ignored, ...withoutDefault } = payload as AddressInput & { id?: string };
    void _ignored;
    try {
      if (params?.id) await api.updateAddress(params.id, { label: withoutDefault.label, recipient_name: withoutDefault.recipient_name, phone_e164: withoutDefault.phone_e164, line1: withoutDefault.line1, line2: withoutDefault.line2, locality: withoutDefault.locality, city: withoutDefault.city, state: withoutDefault.state, postal_code: withoutDefault.postal_code, delivery_instructions: withoutDefault.delivery_instructions });
      else await api.createAddress({ ...payload, is_default: true });
      navigation.goBack();
    } catch (error) { setErrors(error instanceof ApiRequestError ? { ...error.fields, _: error.message } : { _: errorMessage(error) }); }
    finally { setBusy(false); }
  };
  const field = (key: keyof AddressInput, label: string, props: Partial<React.ComponentProps<typeof TextInput>> = {}) => (
    <View style={{ gap: 6 }}>
      <Body weight="semibold" size={13}>{label}</Body>
      <TextInput style={[s.input, errors[key] && { borderColor: colors.red }]} value={String(form[key] ?? '')} onChangeText={value => set(key, value)} placeholderTextColor={colors.muted2} {...props} />
      {errors[key] ? <Body size={12} style={{ color: colors.red }}>{errors[key]}</Body> : null}
    </View>
  );
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <ScreenHeader title={params?.id ? 'Edit Address' : 'Add Address'} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: 'row', gap: 8 }}>{['Home', 'Office', 'Other'].map(label => <Pressable key={label} onPress={() => set('label', label)} style={[s.chip, form.label === label && s.chipActive]}><Text style={[s.chipText, form.label === label && { color: colors.white }]}>{label}</Text></Pressable>)}</View>
        <View style={s.locateBox}>
          <Button small variant="outline" title={location.busy ? 'Finding your location…' : 'Use my current location'} icon={<LocateFixed size={16} color={colors.red} />} disabled={location.busy} onPress={() => void detect()} style={{ alignSelf: 'flex-start' }} />
          {location.error ? <Body size={12} style={{ color: colors.red }}>{location.error}</Body> : null}
          {detected && !location.error ? <Body muted size={12}>Filled from {detected}. Please check every field and add your house or flat number. Map data © OpenStreetMap contributors.</Body> : null}
        </View>
        {field('recipient_name', 'Full name', { autoComplete: 'name', maxLength: 100 })}
        {field('phone_e164', 'Mobile number', { keyboardType: 'phone-pad', maxLength: 14 })}
        {field('line1', 'House no., building, street', { maxLength: 200 })}
        {field('line2', 'Landmark (optional)', { maxLength: 200 })}
        {field('locality', 'Area / locality', { maxLength: 120 })}
        {field('postal_code', 'PIN code', { keyboardType: 'number-pad', maxLength: 6 })}
        {field('city', 'City', { maxLength: 100 })}
        {field('delivery_instructions', 'Delivery instructions (optional)', { maxLength: 300 })}
        {errors._ ? <Body style={{ color: colors.red }}>{errors._}</Body> : null}
        <Button title="Save Address" loading={busy} onPress={() => void save()} />
      </ScrollView>
    </SafeAreaView>
  );
}

export function WishlistScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const { user, wishlist } = useSession();
  const { width } = useWindowDimensions();
  const [items, setItems] = useState<ProductCard[] | null>(null);
  const ids = [...wishlist].sort().join(',');
  // Signed in: the account's wishlist. Guest: the products saved on this phone.
  useFocusEffect(useCallback(() => {
    const load = user ? api.wishlist().then(result => result.items) : api.productsByIds(ids ? ids.split(',') : []);
    load.then(setItems).catch(() => setItems([]));
  }, [user, ids]));
  const visible = items?.filter(item => wishlist.has(item.id)) ?? null;
  const tileWidth = (width - 16 * 2 - 12) / 2;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <ScreenHeader title="My Wishlist" />
      {visible === null ? <Loading /> : visible.length === 0 ? <EmptyState icon={<Heart size={40} color={colors.red} />} title="Your wishlist is empty" body="Tap the heart on a product to save it." /> : (
        <ScrollView contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, padding: 16 }}>
          {visible.map(item => <ProductTile key={item.id} product={item} width={tileWidth} onPress={() => navigation.navigate('Product', { slug: item.slug })} />)}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

export function AccountSettingsScreen() {
  const { user, refreshUser, toast } = useSession();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await api.updateProfile({ display_name: name.trim(), email: email.trim() }); await refreshUser(); toast('Profile updated', 'success'); }
    catch (error) { toast(errorMessage(error), 'error'); } finally { setBusy(false); }
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <ScreenHeader title="Account Settings" />
      <View style={{ padding: 16, gap: 12 }}>
        <Body weight="semibold" size={13}>Full name</Body>
        <TextInput style={s.input} value={name} onChangeText={setName} maxLength={100} />
        <Body weight="semibold" size={13}>Email (for receipts)</Body>
        <TextInput style={s.input} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" maxLength={254} />
        <Body weight="semibold" size={13}>Mobile number</Body>
        <TextInput style={[s.input, { color: colors.muted }]} value={user?.phone ? formatPhone(user.phone) : ''} editable={false} />
        <Button title="Save Changes" loading={busy} disabled={!name.trim()} onPress={() => void save()} />
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  profileHead: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 8 },
  avatar: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#b5542b', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.white, fontFamily: fonts.bold, fontSize: 24 },
  menu: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line },
  menuText: { flex: 1, fontFamily: fonts.medium, fontSize: 15, color: colors.ink },
  address: { flexDirection: 'row', gap: 12, backgroundColor: colors.white, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 14 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.lineStrong, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  radioDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: colors.red },
  link: { color: colors.red, fontFamily: fonts.semibold, fontSize: 13 },
  input: { height: 48, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 8, backgroundColor: colors.white, paddingHorizontal: 12, fontFamily: fonts.regular, fontSize: 15, color: colors.ink },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.white },
  chipActive: { backgroundColor: colors.primaryStrong, borderColor: colors.primaryStrong },
  chipText: { fontFamily: fonts.semibold, fontSize: 13, color: colors.ink2 },
  locateBox: { gap: 6, padding: 12, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.lineStrong, backgroundColor: colors.cream },
});
