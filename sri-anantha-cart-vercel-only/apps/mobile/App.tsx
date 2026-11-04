import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import { SourceSerif4_600SemiBold, SourceSerif4_700Bold } from '@expo-google-fonts/source-serif-4';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { DefaultTheme, NavigationContainer, type LinkingOptions } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts } from 'expo-font';
import * as Linking from 'expo-linking';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { ClipboardList, House, LayoutGrid, ShoppingCart, UserRound } from 'lucide-react-native';
import { useEffect } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { WEB_URL } from './src/config';
import type { RootStackParamList, TabParamList } from './src/navigation-types';
import { AccountSettingsScreen, AddressesScreen, AddressFormScreen, ProfileScreen, WishlistScreen } from './src/screens/AccountScreens';
import { AssistantScreen } from './src/screens/AssistantScreen';
import { CartScreen } from './src/screens/CartScreen';
import { CategoriesScreen } from './src/screens/CategoriesScreen';
import { CheckoutScreen, PaymentScreen, ReviewScreen } from './src/screens/CheckoutScreens';
import { HomeScreen } from './src/screens/HomeScreen';
import { LockScreen, LoginScreen } from './src/screens/LoginScreen';
import { OrderDetailScreen, OrdersScreen, OrderSuccessScreen, TrackOrderScreen } from './src/screens/OrderScreens';
import { ProductListScreen } from './src/screens/ProductListScreen';
import { ProductScreen } from './src/screens/ProductScreen';
import { WelcomeScreen } from './src/screens/WelcomeScreen';
import { readFlag } from './src/guest';
import { navigationRef, SessionProvider, useSession } from './src/session';
import { colors, fonts } from './src/theme';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

/** Shared product links (https://<site>/products/<slug>) and the app scheme open the matching screen. */
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: [Linking.createURL('/'), 'sriananthacart://', WEB_URL],
  config: {
    screens: {
      Tabs: { screens: { Home: '', Categories: 'categories', Cart: 'cart', Orders: 'account/orders', Profile: 'account' } },
      Product: 'products/:slug',
      CategoryProducts: 'c/:slug',
      Search: 'search',
      OrderDetail: 'account/orders/:id',
      TrackOrder: 'track-order',
    },
  },
};

function CartIcon({ color }: { color: string }) {
  const { cart } = useSession();
  const count = cart?.item_count ?? 0;
  return (
    <View>
      <ShoppingCart size={24} color={color} />
      {count > 0 && <View style={{ position: 'absolute', top: -6, right: -10, backgroundColor: colors.red, borderRadius: 9, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }}><Text style={{ color: colors.white, fontSize: 10.5, fontFamily: fonts.bold }}>{count}</Text></View>}
    </View>
  );
}

function Tabs() {
  // Five labels share the width: on the narrowest phones a slightly smaller label keeps "Categories" whole.
  const { width } = useWindowDimensions();
  return (
    <Tab.Navigator screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: colors.primaryStrong,
      tabBarInactiveTintColor: colors.muted,
      tabBarLabelStyle: { fontFamily: fonts.medium, fontSize: width < 360 ? 9.5 : 11 },
      tabBarItemStyle: { paddingHorizontal: 0 },
      tabBarStyle: { height: 64, paddingBottom: 8, paddingTop: 6, backgroundColor: colors.white, borderTopColor: colors.line },
    }}>
      <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarIcon: ({ color }) => <House size={24} color={color} /> }} />
      <Tab.Screen name="Categories" component={CategoriesScreen} options={{ tabBarIcon: ({ color }) => <LayoutGrid size={24} color={color} /> }} />
      <Tab.Screen name="Cart" component={CartScreen} options={{ tabBarIcon: ({ color }) => <CartIcon color={color} /> }} />
      <Tab.Screen name="Orders" component={OrdersScreen} options={{ tabBarIcon: ({ color }) => <ClipboardList size={24} color={color} /> }} />
      <Tab.Screen name="Profile" component={ProfileScreen} options={{ tabBarIcon: ({ color }) => <UserRound size={24} color={color} /> }} />
    </Tab.Navigator>
  );
}

const CategoryProducts = () => <ProductListScreen mode="category" />;
const Search = () => <ProductListScreen mode="search" />;

/** First launch: show the introduction (and, for guests, the PIN check) once the app is ready. */
async function showWelcomeIfNew(signedIn: boolean, hasPincode: boolean) {
  const [tourDone, pinAsked] = await Promise.all([readFlag('tour-done'), readFlag('pin-asked')]);
  if (!navigationRef.isReady()) return;
  if (!tourDone) navigationRef.navigate('Welcome', { start: 'tour' });
  else if (!signedIn && !hasPincode && !pinAsked) navigationRef.navigate('Welcome', { start: 'pin' });
}

function Root() {
  const { ready, locked, user, pincode } = useSession();
  useEffect(() => { if (ready) void SplashScreen.hideAsync().catch(() => undefined); }, [ready]);
  if (!ready) return null;
  if (locked) return <LockScreen />;
  return (
    <NavigationContainer ref={navigationRef} linking={linking} onReady={() => void showWelcomeIfNew(Boolean(user), Boolean(pincode))} theme={{ ...DefaultTheme, colors: { ...DefaultTheme.colors, background: colors.ivory, primary: colors.primary } }}>
      <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right', contentStyle: { backgroundColor: colors.ivory } }}>
        <Stack.Screen name="Tabs" component={Tabs} />
        <Stack.Screen name="CategoryProducts" component={CategoryProducts} />
        <Stack.Screen name="Search" component={Search} />
        <Stack.Screen name="Product" component={ProductScreen} />
        <Stack.Screen name="Login" component={LoginScreen} options={{ presentation: 'modal' }} />
        <Stack.Screen name="Checkout" component={CheckoutScreen} />
        <Stack.Screen name="Payment" component={PaymentScreen} />
        <Stack.Screen name="Review" component={ReviewScreen} />
        <Stack.Screen name="OrderSuccess" component={OrderSuccessScreen} options={{ gestureEnabled: false }} />
        <Stack.Screen name="OrderDetail" component={OrderDetailScreen} />
        <Stack.Screen name="TrackOrder" component={TrackOrderScreen} />
        <Stack.Screen name="Addresses" component={AddressesScreen} />
        <Stack.Screen name="AddressForm" component={AddressFormScreen} />
        <Stack.Screen name="Wishlist" component={WishlistScreen} />
        <Stack.Screen name="AccountSettings" component={AccountSettingsScreen} />
        <Stack.Screen name="Assistant" component={AssistantScreen} options={{ presentation: 'modal' }} />
        <Stack.Screen name="Welcome" component={WelcomeScreen} options={{ presentation: 'transparentModal', animation: 'fade' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, SourceSerif4_600SemiBold, SourceSerif4_700Bold });
  if (!fontsLoaded) return null;
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SessionProvider>
        <Root />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
