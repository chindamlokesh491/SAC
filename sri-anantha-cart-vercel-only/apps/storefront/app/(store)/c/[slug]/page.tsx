import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '@/components/store/Breadcrumbs';
import { Listing } from '@/components/store/Listing';
import { listingQuery } from '@/lib/listing';
import { getCategories, getProductFilters, getProducts } from '@/lib/server-api';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

async function findCategory(slug: string) {
  const categories = await getCategories();
  for (const category of categories) {
    if (category.slug === slug) return { categories, category, parent: null };
    const child = category.children.find(item => item.slug === slug);
    if (child) return { categories, category: { ...child, children: [] }, parent: category };
  }
  return { categories, category: null, parent: null };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const { category, parent } = await findCategory(slug);
  if (!category) return { title: 'Category not found' };
  return { title: parent ? `${category.name} — ${parent.name}` : category.name, description: `Buy ${category.name.toLowerCase()} online in Tirupati. Authentic pooja essentials delivered in 15-30 minutes.`, alternates: { canonical: `/c/${slug}` } };
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const { slug } = await params;
  if (!/^[a-z0-9-]{1,120}$/.test(slug)) notFound();
  const { categories, category, parent } = await findCategory(slug);
  if (!category) notFound();
  const { params: listParams, api } = listingQuery(await searchParams);
  const [result, facets] = await Promise.all([getProducts({ ...api, category: slug }), getProductFilters(slug)]);
  const top = parent ?? categories.find(item => item.id === category.id);
  const chips = top && top.children.length ? [
    { label: 'All', href: `/c/${top.slug}`, active: !parent },
    ...top.children.map(child => ({ label: child.name, href: `/c/${child.slug}`, active: child.slug === slug })),
  ] : undefined;
  return (
    <div className="container">
      <Breadcrumbs items={[...(parent ? [{ label: parent.name, href: `/c/${parent.slug}` }] : []), { label: category.name }]} />
      <Listing title={parent ? `${parent.name} — ${category.name}` : category.name} basePath={`/c/${slug}`} params={listParams} result={result} categories={categories} activeSlug={slug} chips={chips} facets={facets} />
    </div>
  );
}
