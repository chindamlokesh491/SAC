import type { MetadataRoute } from 'next';
import { CMS_PAGES } from '@/lib/cms';

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const api = (process.env.API_SERVER_ORIGIN ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
  const entries: MetadataRoute.Sitemap = [
    { url: `${site}/`, changeFrequency: 'daily', priority: 1 },
    { url: `${site}/categories`, changeFrequency: 'weekly', priority: 0.8 },
    ...Object.keys(CMS_PAGES).map(slug => ({ url: `${site}/${slug}`, changeFrequency: 'monthly' as const, priority: 0.3 })),
  ];
  try {
    const categories = await (await fetch(`${api}/api/v1/categories`)).json() as { data: { slug: string; children: { slug: string }[] }[] };
    for (const category of categories.data) {
      entries.push({ url: `${site}/c/${category.slug}`, changeFrequency: 'daily', priority: 0.7 });
      for (const child of category.children) entries.push({ url: `${site}/c/${child.slug}`, changeFrequency: 'daily', priority: 0.6 });
    }
    for (let offset = 0; offset < 2000; offset += 48) {
      const page = await (await fetch(`${api}/api/v1/products?limit=48&offset=${offset}&sort=newest`)).json() as { data: { slug: string }[] };
      for (const product of page.data) entries.push({ url: `${site}/products/${product.slug}`, changeFrequency: 'weekly', priority: 0.6 });
      if (page.data.length < 48) break;
    }
  } catch { /* API unavailable during build: emit static entries only */ }
  return entries;
}
