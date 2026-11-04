import { ArrowRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { Breadcrumbs } from '@/components/store/Breadcrumbs';
import { getCategories } from '@/lib/server-api';

export const metadata: Metadata = { title: 'All Categories', description: 'Browse every pooja essentials category — agarbatti, kumkum & haldi, diyas, flowers, pooja kits and more.' };

export default async function CategoriesPage() {
  await connection(); // per-request render; data from the tagged catalogue cache
  const categories = await getCategories();
  return (
    <div className="container categories-page">
      <Breadcrumbs items={[{ label: 'All Categories' }]} />
      <h1 className="page-title">All Categories</h1>
      <div className="category-grid">
        {categories.map(category => (
          <Link key={category.id} href={`/c/${category.slug}`} className="category-card">
            <div className="media">{category.image_url && <img src={category.image_url} alt="" loading="lazy" width={240} height={150} />}</div>
            <div className="info">
              <strong>{category.name}</strong>
              <small>({category.product_count} {category.product_count === 1 ? 'product' : 'products'}) <ArrowRight size={15} /></small>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
