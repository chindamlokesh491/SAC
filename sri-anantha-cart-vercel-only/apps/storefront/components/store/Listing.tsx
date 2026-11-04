import type { CategoryNode, Paginated, ProductCard as Product, ProductFilterFacets } from '@sac/contracts';
import { ArrowLeft, ArrowRight, ChevronRight, LayoutGrid } from 'lucide-react';
import Link from 'next/link';
import { ProductCard } from './ProductCard';
import { ListingControls } from './ListingControls';

export const PAGE_SIZE = 12;

type Props = {
  title: string;
  basePath: string;
  params: Record<string, string | undefined>;
  result: Paginated<Product> & { similar?: Product[] };
  categories: CategoryNode[];
  activeSlug?: string | undefined;
  chips?: { label: string; href: string; active: boolean }[];
  facets?: ProductFilterFacets;
};

function pageHref(basePath: string, params: Record<string, string | undefined>, page: number) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value && key !== 'page') query.set(key, value);
  if (page > 1) query.set('page', String(page));
  const text = query.toString();
  return text ? `${basePath}?${text}` : basePath;
}

export function Listing({ title, basePath, params, result, categories, activeSlug, chips, facets }: Props) {
  const { total, offset, limit } = result.pagination;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + limit, total);
  const windowStart = Math.max(1, Math.min(page - 2, pages - 4));
  const pageNumbers = Array.from({ length: Math.min(5, pages) }, (_, index) => windowStart + index);
  const activeParent = categories.find(category => category.slug === activeSlug || category.children.some(child => child.slug === activeSlug));

  return (
    <div className="listing">
      <aside className="listing-sidebar" id="listing-filters" aria-label="Categories">
        <h2>Categories</h2>
        {categories.map(category => {
          const isActive = category.id === activeParent?.id;
          return (
            <div key={category.id}>
              <Link href={`/c/${category.slug}`} className={`side-cat${isActive ? ' active' : ''}`} aria-current={category.slug === activeSlug ? 'page' : undefined}>
                {category.thumb_url ? <img src={category.thumb_url} alt="" width={26} height={26} /> : <LayoutGrid size={22} />}
                {category.name}
                {category.children.length > 0 && <ChevronRight size={16} className="chev" />}
              </Link>
              {isActive && category.children.length > 0 && (
                <div className="side-sub">
                  <Link href={`/c/${category.slug}`} className={category.slug === activeSlug ? 'active' : ''}>All {category.name}</Link>
                  {category.children.map(child => (
                    <Link key={child.id} href={`/c/${child.slug}`} className={child.slug === activeSlug ? 'active' : ''}>{child.name}</Link>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <ListingControls kind="price" params={params} basePath={basePath} facets={facets} />
      </aside>
      <section>
        <div className="listing-head">
          <div>
            <h1>{title}</h1>
            <p>{total === 0 ? 'No products found' : `Showing ${first}-${last} of ${total} products`}</p>
          </div>
          <ListingControls kind="sort" params={params} basePath={basePath} />
        </div>
        {chips && chips.length > 1 && (
          <div className="chips" role="list">
            {chips.map(chip => <Link role="listitem" key={chip.href} href={chip.href} className={`chip${chip.active ? ' active' : ''}`}>{chip.label}</Link>)}
          </div>
        )}
        {result.data.length === 0 ? (
          params.q && result.similar?.length ? (
            <div className="search-none">
              <h2>No exact matches for “{params.q}”</h2>
              <p>Check the spelling, or try one of these similar products.</p>
            </div>
          ) : (
            <div className="empty">
              <h2>{params.q ? `No products match “${params.q}”` : 'Nothing here yet'}</h2>
              <p>{params.q ? 'Check the spelling or try a shorter word, such as “diya” or “kumkum”.' : 'Try another category or adjust your filters.'}</p>
              <Link href="/categories" className="btn btn-primary">Browse all categories</Link>
            </div>
          )
        ) : (
          <div className="product-grid">{result.data.map(product => <ProductCard key={product.id} product={product} />)}</div>
        )}
        {pages > 1 && (
          <nav className="pagination" aria-label="Pagination">
            {page > 1 ? <Link href={pageHref(basePath, params, page - 1)} aria-label="Previous page"><ArrowLeft size={16} /></Link> : <span className="disabled"><ArrowLeft size={16} /></span>}
            {pageNumbers.map(number => number === page
              ? <span key={number} className="current" aria-current="page">{number}</span>
              : <Link key={number} href={pageHref(basePath, params, number)}>{number}</Link>)}
            {page < pages ? <Link href={pageHref(basePath, params, page + 1)} aria-label="Next page"><ArrowRight size={16} /></Link> : <span className="disabled"><ArrowRight size={16} /></span>}
          </nav>
        )}
        {result.similar && result.similar.length > 0 && (
          <section className="similar-block" aria-labelledby="similar-heading">
            <h2 id="similar-heading">{result.data.length ? 'Similar products' : 'You might be looking for'}</h2>
            <div className="product-grid">{result.similar.map(product => <ProductCard key={product.id} product={product} />)}</div>
          </section>
        )}
      </section>
    </div>
  );
}
