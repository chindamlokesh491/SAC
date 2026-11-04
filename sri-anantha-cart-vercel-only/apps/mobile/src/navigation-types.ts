import type { NavigatorScreenParams } from '@react-navigation/native';
import type { DeliverySelection, PaymentMethod } from '@sac/contracts';

export type TabParamList = {
  Home: undefined;
  Categories: undefined;
  Cart: undefined;
  Orders: undefined;
  Profile: undefined;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  CategoryProducts: { slug: string; title?: string };
  Search: { q?: string } | undefined;
  Product: { slug: string };
  Login: { next?: 'Checkout' } | undefined;
  Checkout: undefined;
  Payment: { addressId: string; delivery: DeliverySelection };
  Review: { addressId: string; delivery: DeliverySelection; method: PaymentMethod; email?: string };
  OrderSuccess: { orderId: string };
  OrderDetail: { id: string };
  Addresses: { selectMode?: boolean } | undefined;
  AddressForm: { id?: string } | undefined;
  Wishlist: undefined;
  AccountSettings: undefined;
  TrackOrder: undefined;
  Assistant: undefined;
  Welcome: { start?: 'tour' | 'pin' } | undefined;
};
