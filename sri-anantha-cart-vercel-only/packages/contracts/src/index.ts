/** API contracts shared by the web storefront, admin panel and Android app. Amounts are integer paise. */

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';
export type PaymentMethod = 'upi' | 'card' | 'net_banking' | 'wallet' | 'cod';
export type OrderStatus = 'pending_payment' | 'placed' | 'accepted' | 'packed' | 'dispatched' | 'delivered' | 'cancelled'
  | 'return_requested' | 'refund_initiated' | 'refund_completed' | 'refunded';
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'refund_pending' | 'refunded';
export type UserRole = 'customer' | 'admin' | 'operator' | 'delivery_partner';

export type ApiError = { error: string; message?: string; fields?: Record<string, string>; [key: string]: unknown };

export type Category = {
  id: string; name: string; slug: string; description: string | null; image_url: string | null; thumb_url: string | null;
  parent_category_id: string | null; sort_order: number; product_count: number; is_featured?: boolean;
};
export type CategoryNode = Category & { children: Category[] };

export type ProductCard = {
  id: string; slug: string; name: string; short_description: string | null;
  price_paise: number; mrp_paise: number; image_url: string | null; thumb_url: string | null;
  category_name: string | null; category_slug: string | null;
  stock_status: StockStatus; max_quantity: number; has_variants: boolean; is_featured: boolean;
};

export type ProductVariant = {
  id: string; label: string; price_paise: number; mrp_paise: number; weight_grams: number | null; stock_status: StockStatus; max_quantity: number;
};

export type ProductDetail = ProductCard & {
  description: string | null; highlights: string[]; weight_grams: number | null; sku: string; hsn_code: string | null;
  gst_rate_basis_points: number;
  category: { name: string; slug: string } | null; subcategory: { name: string; slug: string } | null;
  images: { url: string; thumb_url: string | null; alt_text: string | null }[];
  variants: ProductVariant[]; related: ProductCard[];
};

export type ProductFilterFacets = { price_min_paise: number; price_max_paise: number; counts: { total: number; in_stock: number; featured: number; discounted: number; variants: number } };

export type Paginated<T> = { data: T[]; pagination: { limit: number; offset: number; total: number } };

export type HomeData = { categories: CategoryNode[]; featured_categories: Category[]; popular: ProductCard[]; kits: ProductCard[] };

export type StoreConfig = {
  store: { name: string; tagline: string; support_phone: string; support_email: string; whatsapp: string; address: string; instagram_url: string; facebook_url: string; youtube_url: string };
  payments: { upi: boolean; card: boolean; net_banking: boolean; wallet: boolean; cod: boolean; cod_limit_paise: number; online_available: boolean };
  delivery: { free_delivery_threshold_paise: number; express_enabled: boolean };
};

export type User = { id: string; role: UserRole; phone: string | null; name: string | null; email: string | null; email_verified?: boolean; google_linked?: boolean; must_change_password?: boolean };

export type Address = {
  id: string; label: string | null; recipient_name: string; phone_e164: string; line1: string; line2: string | null; locality: string;
  city: string; state: string; postal_code: string; delivery_instructions: string | null; is_default: boolean;
};
export type AddressInput = Omit<Address, 'id' | 'is_default'> & { is_default?: boolean };

export type QuoteLine = {
  cart_item_id: string; product_id: string; variant_id: string | null; slug: string; name: string; variant_label: string | null; sku: string;
  image_url: string | null; thumb_url: string | null; unit_price_paise: number; mrp_paise: number; quantity: number; line_total_paise: number;
  gst_rate_basis_points: number; tax_paise: number; max_quantity: number; available: boolean;
  issue: null | 'unavailable' | 'insufficient_stock' | 'choose_variant';
};
export type ScheduledOption = { slot_id: string; date: string; label: string; starts_at: string; ends_at: string };
export type Quote = {
  lines: QuoteLine[]; item_count: number; subtotal_paise: number; mrp_total_paise: number; savings_paise: number; tax_paise: number;
  delivery_fee_paise: number; discount_paise: number; total_paise: number; free_delivery_threshold_paise: number; amount_to_free_delivery_paise: number;
  zone: null | { id: string; name: string; estimated_minutes: number; minimum_order_paise: number };
  delivery: { express: { available: boolean; estimated_minutes: number | null; reason: string | null }; scheduled: ScheduledOption[] };
  payment_methods: Record<PaymentMethod, { available: boolean; reason: string | null }>;
  problems: string[];
};

export type DeliverySelection = { mode: 'express' } | { mode: 'scheduled'; slot_id: string; date: string };

export type CheckoutResult = {
  order_id: string; order_number: string; amount_paise: number; payment_method: PaymentMethod; estimated_delivery_at: string | null;
  checkout?: { key_id: string; razorpay_order_id: string; amount: number; currency: 'INR'; name: string; description: string; prefill?: { name?: string; email?: string; contact?: string } }; expires_at?: string;
};

export type OrderSummary = {
  id: string; order_number: number; display_number: string; status: OrderStatus; payment_status: PaymentStatus; payment_method: PaymentMethod | null;
  total_paise: number; created_at: string; estimated_delivery_at: string | null; item_count: number; thumbs: (string | null)[];
};

export type OrderItem = {
  order_item_id: string; name: string; variant_label: string | null; sku: string; unit_price_paise: number; mrp_paise: number | null; quantity: number; line_total_paise: number;
  gst_rate_basis_points: number; tax_paise: number; hsn_code: string | null; image_url: string | null; thumb_url: string | null; slug: string | null;
};
export type TimelineEntry = { status: OrderStatus; payment_status: PaymentStatus; created_at: string };

export type OrderDetail = {
  id: string; order_number: number; display_number: string; status: OrderStatus; payment_status: PaymentStatus; payment_method: PaymentMethod | null;
  subtotal_paise: number; delivery_fee_paise: number; tax_paise: number; discount_paise: number; total_paise: number; mrp_total_paise: number | null;
  delivery_mode: 'express' | 'scheduled' | null; delivery_slot_start: string | null; delivery_slot_end: string | null; estimated_delivery_at: string | null;
  delivered_at: string | null; cancellation_reason: string | null; return_reason: string | null; created_at: string;
  address: Omit<Address, 'id' | 'is_default' | 'delivery_instructions'>;
  items: OrderItem[]; timeline: TimelineEntry[]; refunds: { amount_paise: number; status: string; created_at: string }[]; can_request_return: boolean;
};

export type Invoice = {
  invoice_number: string; order_number: string; issued_at: string; status: OrderStatus; payment_method: PaymentMethod | null; payment_status: PaymentStatus;
  seller: { name: string; gstin: string | null; address: string; state_code: string };
  buyer: Record<string, string | null>; supply_type: 'intra_state' | 'inter_state'; show_tax_breakup: boolean;
  lines: { name: string; variant_label: string | null; hsn_code: string | null; quantity: number; unit_price_paise: number; line_total_paise: number;
    gst_rate_basis_points: number; tax_paise: number; taxable_value_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number }[];
  totals: { items_paise: number; tax_included_paise: number; delivery_fee_paise: number; discount_paise: number; total_paise: number };
};

export type DeliveryAvailability = {
  serviceable: boolean; postal_code: string; message?: string;
  zone?: { name: string; delivery_fee_paise: number; minimum_order_paise: number; estimated_minutes: number; cod_enabled: boolean };
  free_delivery_threshold_paise?: number;
  express: { available: boolean; estimated_minutes: number | null; reason: string | null } | null;
  scheduled: ScheduledOption[];
};

/** A cart line kept on the device before sign-in. Prices are never stored; the server re-prices them. */
export type GuestCartItem = { product_id: string; variant_id: string | null; quantity: number };

/** Editable address suggested from the device's location. */
export type ReverseAddress = { postal_code: string | null; line1: string | null; locality: string | null; city: string | null; state: string | null; display: string };

// ── Self-delivery: customer delivery code and the delivery-partner portal ──────────────────────

/** The signed-in customer's view of their delivery code (only while the order is out for delivery). */
export type CustomerDeliveryOtp = { status: 'active' | 'expired'; otp: string | null; expires_at: string | null; can_request_new?: boolean };

export type DeliveryStage = 'awaiting_acceptance' | 'awaiting_pickup' | 'out_for_delivery' | 'awaiting_cod' | 'delivered';
export type DeliveryRejectReason = 'vehicle_unavailable' | 'too_far' | 'shift_ending' | 'personal_emergency' | 'other';
export type DeliveryIssueReason = 'customer_not_available' | 'customer_phone_unreachable' | 'incorrect_address' | 'customer_refused' | 'payment_issue' | 'other';

export type PartnerProfile = {
  partner: { id: string; partnerCode: string | null; name: string; phone: string; vehicle: null; online: boolean };
  summary: { assigned: number; inProgress: number; completedToday: number };
  support: { phone: string; email: string; termsUrl: string; privacyUrl: string };
};

export type PartnerOrderSummary = {
  orderId: string; orderNumber: string; placedAt: string; assignedAt: string; totalAmount: string; paymentMethod: string | null; orderStatus: string;
  customerName: string; addressSummary: string; itemCount: number; distanceKm: null; assignmentStatus: string; stage: DeliveryStage;
  deliveryException: string | null; deliveredAt: string | null;
};

export type PartnerOrderDetail = {
  order: { id: string; orderNumber: string; placedAt: string; status: string; deliveryException: string | null; itemCount: number; slot: { start: string; end: string } | null; estimatedDeliveryAt: string | null };
  assignment: { id: string; status: string; stage: DeliveryStage; assignedAt: string; acceptedAt: string | null; pickedUpAt: string | null; outForDeliveryAt: string | null; otpVerifiedAt: string | null; deliveredAt: string | null; readyForPickup: boolean };
  customer: { name: string; phone: string; fullAddress: string; address: { line1: string; line2: string | null; landmark: string | null; city: string; state: string; pincode: string } | null; location: null };
  distanceKm: null;
  items: { id: string; name: string; variant: string | null; quantity: number; imageUrl: string | null }[];
  payment: { method: string | null; status: string; total: string; codAmount: string | null; collection: { amount: string; collectedAt: string } | null };
  otp: { expiresAt: string; sendsRemaining: number; attemptsRemaining: number } | null;
  pickup: null;
  issues: { id: string; reason: DeliveryIssueReason; status: string; reportedAt: string }[];
};
