import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '@/components/store/Breadcrumbs';
import { ProductCard } from '@/components/store/ProductCard';
import { ProductGallery, ProductHighlights, ProductPurchase, ProductTabs } from '@/components/store/ProductPurchase';
import { preload } from 'react-dom';
import { absoluteImageUrl, imageSrcSet, PRODUCT_IMAGE_SIZES } from '@/lib/images';
import { getProduct } from '@/lib/server-api';

type Props = { params: Promise<{ slug: string }> };
export const revalidate = 60;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = /^[a-z0-9-]{1,120}$/.test(slug) ? await getProduct(slug) : null;
  if (!product) return { title: 'Product not found' };
  const description = (product.description ?? product.short_description ?? '').slice(0, 160);
  return {
    title: product.name,
    description,
    alternates: { canonical: `/products/${product.slug}` },
    openGraph: { title: product.name, description, images: product.images[0] ? [product.images[0].url] : [] },
  };
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  if (!/^[a-z0-9-]{1,120}$/.test(slug)) notFound();
  const product = await getProduct(slug);
  if (!product) notFound();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  // The main photo is the largest element on screen: start fetching it with the HTML.
  const main = product.images[0]?.url;
  if (main) {
    const srcSet = imageSrcSet(main);
    preload(main, { as: 'image', fetchPriority: 'high', ...(srcSet ? { imageSrcSet: srcSet, imageSizes: PRODUCT_IMAGE_SIZES } : {}) });
  }
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.description,
    sku: product.sku,
    image: product.images.map(image => absoluteImageUrl(image.url, siteUrl)),
    category: product.category?.name,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'INR',
      price: (product.price_paise / 100).toFixed(2),
      availability: product.stock_status === 'out_of_stock' ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
      url: `${siteUrl}/products/${product.slug}`,
    },
  };
  return (
    <div className="container">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      <Breadcrumbs items={[
        ...(product.category ? [{ label: product.category.name, href: `/c/${product.category.slug}` }] : []),
        ...(product.subcategory ? [{ label: product.subcategory.name, href: `/c/${product.subcategory.slug}` }] : []),
        { label: product.name },
      ]} />
      <div className="pdp">
        <ProductGallery product={product} />
        <ProductPurchase product={product} />
      </div>
      <ProductHighlights highlights={product.highlights} />
      <ProductTabs product={product} />
      {product.related.length > 0 && (
        <section className="section" aria-labelledby="related">
          <div className="section-head"><h2 id="related">You may also like</h2></div>
          <div className="product-grid">{product.related.map(item => <ProductCard key={item.id} product={item} />)}</div>
        </section>
      )}
      <div style={{ height: 40 }} />
    </div>
  );
}
