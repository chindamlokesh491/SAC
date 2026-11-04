import 'server-only';
import type { CategoryNode, HomeData, Paginated, ProductCard, ProductDetail, ProductFilterFacets, StoreConfig } from '@sac/contracts';

const API_ORIGIN = (process.env.API_SERVER_ORIGIN ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
// Server-only: identifies this server to the API so shared catalogue reads are not IP rate-limited.
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN;

/** Cache tag on every catalogue read. Admin changes revalidate it immediately (see app/internal/revalidate). */
export const CATALOG_TAG = 'catalog';

/** Public, cacheable catalogue reads made by server components (no user credentials). */
async function get<T>(path: string, revalidate = 60): Promise<T | null> {
  try {
    const response = await fetch(`${API_ORIGIN}${path}`, { next: { revalidate, tags: [CATALOG_TAG] }, headers: { accept: 'application/json', ...(INTERNAL_TOKEN ? { 'x-sac-internal': INTERNAL_TOKEN } : {}) } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`API ${response.status} for ${path}`);
    return (await response.json()) as T;
  } catch (error) {
    console.error('Catalogue request failed', path, error instanceof Error ? error.message : error);
    throw error;
  }
}

export async function getHome() { return (await get<{ data: HomeData }>('/api/v1/home'))?.data ?? null; }
export async function getCategories() { return (await get<{ data: CategoryNode[] }>('/api/v1/categories'))?.data ?? []; }
export async function getStoreConfig() {
  try { return (await get<{ data: StoreConfig }>('/api/v1/store/config', 120))?.data ?? null; } catch { return null; }
}
export async function getProduct(slug: string) { return (await get<{ data: ProductDetail }>(`/api/v1/products/${encodeURIComponent(slug)}`))?.data ?? null; }
export async function getProducts(params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') query.set(key, String(value));
  return (await get<Paginated<ProductCard> & { similar?: ProductCard[] }>(`/api/v1/products?${query.toString()}`, 30)) ?? { data: [], similar: [], pagination: { limit: 12, offset: 0, total: 0 } };
}

export async function getProductFilters(category?: string, q?: string) {
  const query = new URLSearchParams();
  if (category) query.set('category', category);
  if (q) query.set('q', q.slice(0, 100));
  const suffix = query.size ? `?${query.toString()}` : '';
  return (await get<{ data: ProductFilterFacets }>(`/api/v1/products/filters${suffix}`, 60))?.data ?? { price_min_paise: 0, price_max_paise: 0, counts: { total: 0, in_stock: 0, featured: 0, discounted: 0, variants: 0 } };
}
