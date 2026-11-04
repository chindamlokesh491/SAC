import type { Metadata } from 'next';
import { Breadcrumbs } from '@/components/store/Breadcrumbs';
import { Listing } from '@/components/store/Listing';
import { listingQuery } from '@/lib/listing';
import { getCategories, getProductFilters, getProducts } from '@/lib/server-api';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const q = (await searchParams).q;
  return { title: typeof q === 'string' && q ? `Search: ${q.slice(0, 60)}` : 'All Products', robots: { index: false } };
}

export default async function SearchPage({ searchParams }: Props) {
  const raw = await searchParams;
  const { params, api, pick } = listingQuery(raw);
  const q = (pick('q') ?? '').trim().slice(0, 100);
  const [categories, result, facets] = await Promise.all([getCategories(), getProducts({ ...api, q: q || undefined }), getProductFilters(undefined, q || undefined)]);
  return (
    <div className="container">
      <Breadcrumbs items={[{ label: q ? `Search results for “${q}”` : 'All Products' }]} />
      <Listing title={q ? `Results for “${q}”` : 'All Products'} basePath="/search" params={{ ...params, q: q || undefined }} result={result} categories={categories} facets={facets} />
    </div>
  );
}
