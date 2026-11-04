import { PAGE_SIZE } from '@/components/store/Listing';

const SORTS = new Set(['relevance', 'popular', 'newest', 'price_asc', 'price_desc']);

/** Converts URL search params into a validated product query (prices in rupees in the URL). */
export function listingQuery(searchParams: Record<string, string | string[] | undefined>) {
  const pick = (key: string) => { const value = searchParams[key]; return typeof value === 'string' ? value : undefined; };
  const page = Math.min(Math.max(Number.parseInt(pick('page') ?? '1', 10) || 1, 1), 500);
  const sort = SORTS.has(pick('sort') ?? '') ? pick('sort') : undefined;
  const rupees = (key: string) => { const value = pick(key); return value && /^\d{1,6}$/.test(value) ? value : undefined; };
  const featured = pick('featured') === 'true' ? 'true' : undefined;
  const in_stock = pick('in_stock') === 'true' ? 'true' : undefined;
  const discount_only = pick('discount_only') === 'true' ? 'true' : undefined;
  const params = { sort, min: rupees('min'), max: rupees('max'), featured, in_stock, discount_only, page: page > 1 ? String(page) : undefined };
  const api = {
    // No sort chosen: the API ranks searches by best match and categories by popularity.
    sort,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    min_price: params.min ? Number(params.min) * 100 : undefined,
    max_price: params.max ? Number(params.max) * 100 : undefined,
    featured,
    in_stock,
    discount_only,
  };
  return { params, api, pick };
}
