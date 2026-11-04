import type {
  Address, AddressInput, ApiError, CategoryNode, CheckoutResult, DeliveryAvailability, DeliverySelection, HomeData, Invoice, OrderDetail,
  OrderSummary, Paginated, PaymentMethod, ProductCard, ProductDetail, ProductFilterFacets, Quote, StoreConfig, User, GuestCartItem, ReverseAddress,
  CustomerDeliveryOtp, DeliveryIssueReason, DeliveryRejectReason, PartnerOrderDetail, PartnerOrderSummary, PartnerProfile,
} from '@sac/contracts';

export class ApiRequestError extends Error {
  constructor(public readonly status: number, public readonly body: ApiError) {
    const rawMessage: unknown = body?.message;
    const rawError: unknown = body?.error;
    const message = typeof rawMessage === 'string' && rawMessage.trim()
      ? rawMessage
      : typeof rawError === 'string' && rawError.trim()
        ? rawError
        : `Request failed (${status})`;
    super(message);
    this.name = 'ApiRequestError';
  }
  get code() { return typeof this.body?.error === 'string' ? this.body.error : undefined; }
  get fields() { return this.body?.fields ?? {}; }
}

type ClientOptions = {
  /** '' for same-origin web requests, or the API origin for mobile. */
  baseUrl: string;
  /** Web uses an HttpOnly cookie plus CSRF header; mobile sends a bearer token. */
  auth: { kind: 'cookie' } | { kind: 'bearer'; getToken: () => string | null | Promise<string | null> };
  fetchImpl?: typeof fetch;
  onUnauthorized?: () => void;
};

type RequestOptions = { method?: string; body?: unknown; query?: Record<string, string | number | boolean | null | undefined>; headers?: Record<string, string>; signal?: AbortSignal };

export function createApiClient(options: ClientOptions) {
  const doFetch = options.fetchImpl ?? fetch;

  async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const url = new URL(`${options.baseUrl}${path}`, options.baseUrl ? undefined : 'http://same-origin.invalid');
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
    if (init.body !== undefined && !(init.body instanceof FormData)) headers['content-type'] = 'application/json';
    if (options.auth.kind === 'cookie') {
      headers['x-sac-csrf'] = '1';
      headers['x-sac-client'] = 'web';
    } else {
      const token = await options.auth.getToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    const target = options.baseUrl ? url.toString() : `${url.pathname}${url.search}`;
    const response = await doFetch(target, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? null : init.body instanceof FormData ? init.body : JSON.stringify(init.body),
      credentials: options.auth.kind === 'cookie' ? 'same-origin' : 'omit',
      signal: init.signal ?? null,
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let body: unknown = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: 'INVALID_RESPONSE', message: 'Unexpected server response' }; }
    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized?.();
      throw new ApiRequestError(response.status, (body as ApiError) ?? { error: 'REQUEST_FAILED' });
    }
    return body as T;
  }

  const data = async <T>(path: string, init?: RequestOptions) => (await request<{ data: T }>(path, init)).data;

  return {
    request,
    // Catalogue
    home: () => data<HomeData>('/api/v1/home'),
    categories: () => data<CategoryNode[]>('/api/v1/categories'),
    products: (query: { q?: string; category?: string; sort?: string; min_price?: number; max_price?: number; limit?: number; offset?: number; featured?: boolean; in_stock?: boolean; discount_only?: boolean }) =>
      request<Paginated<ProductCard> & { similar?: ProductCard[] }>('/api/v1/products', { query }),
    productFilters: (category?: string, q?: string) => data<ProductFilterFacets>('/api/v1/products/filters', { query: { category, q } }),
    product: (slug: string) => data<ProductDetail>(`/api/v1/products/${encodeURIComponent(slug)}`),
    suggest: (q: string, signal?: AbortSignal) => data<{ products: ProductCard[]; categories: { name: string; slug: string }[] }>('/api/v1/search/suggest', signal ? { query: { q }, signal } : { query: { q } }),
    storeConfig: () => data<StoreConfig>('/api/v1/store/config'),
    deliveryAvailability: (postalCode: string) => data<DeliveryAvailability>('/api/v1/delivery/availability', { query: { postal_code: postalCode } }),
    // Auth & account
    requestOtp: (phone: string) => request<{ message: string; expiresInSeconds: number; resendAfterSeconds: number }>('/api/v1/auth/otp/request', { method: 'POST', body: { phone } }),
    verifyOtp: (phone: string, code: string) => data<{ user: User; accessToken?: string; expiresInSeconds: number }>('/api/v1/auth/otp/verify', { method: 'POST', body: { phone, code } }),
    googleSignIn: (idToken: string) => data<{ user: User; accessToken?: string }>('/api/v1/auth/google', { method: 'POST', body: { id_token: idToken } }),
    linkGoogle: (idToken: string) => data<{ linked: boolean }>('/api/v1/auth/google/link', { method: 'POST', body: { id_token: idToken } }),
    logout: () => request<void>('/api/v1/auth/logout', { method: 'POST' }),
    staffLogin: (phone: string, password: string) => data<{ user: User; accessToken?: string; expiresInSeconds: number }>('/api/v1/auth/staff/login', { method: 'POST', body: { phone, password } }),
    changeStaffPassword: (currentPassword: string, newPassword: string) => data<{ changed: boolean }>('/api/v1/auth/staff/password', { method: 'POST', body: { current_password: currentPassword, new_password: newPassword } }),
    changeStaffPhone: (currentPassword: string, phone: string) => data<{ phone: string }>('/api/v1/auth/staff/phone', { method: 'POST', body: { current_password: currentPassword, phone } }),
    me: () => data<User>('/api/v1/me'),
    session: () => data<User | null>('/api/v1/session'),
    updateProfile: (body: { display_name?: string; email?: string }) => data<User>('/api/v1/me', { method: 'PATCH', body }),
    addresses: () => data<Address[]>('/api/v1/addresses'),
    createAddress: (body: AddressInput) => data<Address>('/api/v1/addresses', { method: 'POST', body }),
    updateAddress: (id: string, body: Partial<AddressInput>) => data<Address>(`/api/v1/addresses/${id}`, { method: 'PATCH', body }),
    deleteAddress: (id: string) => request<void>(`/api/v1/addresses/${id}`, { method: 'DELETE' }),
    // Cart & wishlist
    previewCart: (items: GuestCartItem[], postalCode?: string) => data<Quote>('/api/v1/cart/preview', { method: 'POST', body: { items, ...(postalCode ? { postal_code: postalCode } : {}) } }),
    mergeCart: (items: GuestCartItem[]) => request<{ data: Quote; adjusted: { product_id: string; variant_id: string | null; reason: string }[] }>('/api/v1/cart/merge', { method: 'POST', body: { items } }),
    mergeWishlist: (productIds: string[]) => data<{ product_ids: string[] }>('/api/v1/wishlist/merge', { method: 'POST', body: { product_ids: productIds } }),
    productsByIds: (ids: string[]) => data<ProductCard[]>('/api/v1/products/by-ids', { method: 'POST', body: { ids } }),
    reverseGeocode: (lat: number, lon: number) => data<ReverseAddress>('/api/v1/geo/reverse', { query: { lat, lon } }),
    cart: (addressId?: string) => data<Quote>('/api/v1/cart', addressId ? { query: { address_id: addressId } } : {}),
    addToCart: (productId: string, quantity: number, variantId?: string | null) => data<Quote>('/api/v1/cart/items', { method: 'POST', body: { product_id: productId, variant_id: variantId ?? null, quantity } }),
    setCartQuantity: (productId: string, quantity: number, variantId?: string | null) => data<Quote>('/api/v1/cart/items', { method: 'PUT', body: { product_id: productId, variant_id: variantId ?? null, quantity } }),
    removeCartItem: (cartItemId: string) => data<Quote>(`/api/v1/cart/items/${cartItemId}`, { method: 'DELETE' }),
    clearCart: () => data<Quote>('/api/v1/cart', { method: 'DELETE' }),
    wishlist: () => data<{ items: ProductCard[]; product_ids: string[] }>('/api/v1/wishlist'),
    addToWishlist: (productId: string) => request<void>(`/api/v1/wishlist/${productId}`, { method: 'PUT' }),
    removeFromWishlist: (productId: string) => request<void>(`/api/v1/wishlist/${productId}`, { method: 'DELETE' }),
    // Orders
    checkout: (body: { address_id: string; delivery: DeliverySelection; payment_method: PaymentMethod; expected_total_paise: number; email?: string }, idempotencyKey: string) =>
      data<CheckoutResult>('/api/v1/orders/checkout', { method: 'POST', body, headers: { 'idempotency-key': idempotencyKey } }),
    verifyRazorpayPayment: (body: { order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => data<{ verified: boolean; order_id: string; payment_status: string }>('/api/v1/payments/razorpay/verify', { method: 'POST', body }),
    orders: (status?: string) => data<OrderSummary[]>('/api/v1/orders', status ? { query: { status } } : {}),
    order: (id: string) => data<OrderDetail>(`/api/v1/orders/${id}`),
    invoice: (id: string) => data<Invoice>(`/api/v1/orders/${id}/invoice`),
    trackOrder: (reference: string) => data<{ order_id: string }>('/api/v1/orders/track', { query: { reference } }),
    requestReturn: (id: string, reason: string, items?: { order_item_id: string; quantity: number }[]) => data<{ return_id: string; order_id: string; status: string; items: number; requested_refund_paise: number }>(`/api/v1/orders/${id}/return-request`, { method: 'POST', body: { reason, ...(items ? { items } : {}) } }),
    cancelReturn: (id: string) => data<{ order_id: string; return_id: string; status: string }>(`/api/v1/orders/${id}/return-cancel`, { method: 'POST' }),
    uploadReturnEvidence: (id: string, file: File) => {
      const form = new FormData();
      form.append('file', file);
      return data<{ id: string; content_type: string; byte_size: number; created_at: string }>(`/api/v1/orders/${id}/return-evidence`, { method: 'POST', body: form });
    },
    submitReturnShipment: (id: string, body: { carrier: string; tracking_reference: string; parcel_description: string }) =>
      data<{ order_id: string; return_id: string; status: string }>(`/api/v1/orders/${id}/return-shipment`, { method: 'PATCH', body }),
    returnDetails: (id: string) => data<{
      id: string; reason: string; status: string; decision_reason: string | null;
      pickup_method: string | null; return_carrier: string | null; pickup_reference: string | null; parcel_description: string | null; decided_at: string | null; received_at: string | null;
      evidence: { id: string; content_type: string; byte_size: number; created_at: string }[];
      items: { order_item_id: string; name: string; variant_label: string | null; sku: string; quantity: number; unit_price_paise: number; refund_amount_paise: number; tax_amount_paise: number }[];
      timeline: { from_status: string | null; to_status: string; note: string | null; created_at: string }[];
    }>(`/api/v1/orders/${id}/return`),
    returnEvidenceUrl: (orderId: string, evidenceId: string) => `/api/v1/orders/${orderId}/return-evidence/${evidenceId}`,
    // Customer delivery code (self-delivery)
    deliveryOtp: (orderId: string) => data<CustomerDeliveryOtp>(`/api/v1/orders/${orderId}/delivery-otp`),
    resendDeliveryOtp: (orderId: string) => data<{ status: 'active'; otp: string; expires_in_seconds: number }>(`/api/v1/orders/${orderId}/delivery-otp/resend`, { method: 'POST', body: {} }),
    // Delivery-partner portal
    partner: {
      requestOtp: (phone: string) => request<{ message: string; expiresInSeconds: number; resendAfterSeconds: number }>('/api/v1/delivery/auth/request-otp', { method: 'POST', body: { phone } }),
      verifyOtp: (phone: string, code: string) => data<{ user: User; accessToken?: string; expiresInSeconds: number }>('/api/v1/delivery/auth/verify-otp', { method: 'POST', body: { phone, code } }),
      logout: () => request<{ data: { ok: boolean } }>('/api/v1/delivery/auth/logout', { method: 'POST', body: {} }),
      me: () => data<PartnerProfile>('/api/v1/delivery/me'),
      setAvailability: (online: boolean) => data<{ online: boolean }>('/api/v1/delivery/me/availability', { method: 'PATCH', body: { online } }),
      orders: (tab: 'assigned' | 'in_progress' | 'completed') => data<{ orders: PartnerOrderSummary[] }>('/api/v1/delivery/me/orders', { query: { tab } }),
      order: (orderId: string) => data<PartnerOrderDetail>(`/api/v1/delivery/me/orders/${orderId}`),
      accept: (orderId: string) => data<{ assignmentStatus: string }>(`/api/v1/delivery/me/orders/${orderId}/accept`, { method: 'POST', body: {} }),
      reject: (orderId: string, reason: DeliveryRejectReason, note?: string) => data<{ assignmentStatus: string }>(`/api/v1/delivery/me/orders/${orderId}/reject`, { method: 'POST', body: { reason, ...(note ? { note } : {}) } }),
      pickup: (orderId: string) => data<{ stage: string; otpSent: boolean; otpExpiresInSeconds: number }>(`/api/v1/delivery/me/orders/${orderId}/pickup`, { method: 'POST', body: {} }),
      resendOtp: (orderId: string) => data<{ resent: boolean; otpSent: boolean; expiresInSeconds: number; sendsRemaining: number }>(`/api/v1/delivery/me/orders/${orderId}/resend-otp`, { method: 'POST', body: {} }),
      verifyDeliveryOtp: (orderId: string, otp: string) => data<{ delivered: boolean; requiresCod: boolean; codAmount?: string }>(`/api/v1/delivery/me/orders/${orderId}/verify-otp`, { method: 'POST', body: { otp } }),
      collectCod: (orderId: string, amount: string) => data<{ delivered: boolean; duplicate: boolean }>(`/api/v1/delivery/me/orders/${orderId}/cod-collection`, { method: 'POST', body: { amount } }),
      reportIssue: (orderId: string, body: { reason: DeliveryIssueReason; description?: string; clientRequestId: string }) => data<{ issueId: string; reportedAt: string }>(`/api/v1/delivery/me/orders/${orderId}/report-issue`, { method: 'POST', body }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Random idempotency key for one checkout attempt (reused on retries of that attempt). */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `chk_${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
