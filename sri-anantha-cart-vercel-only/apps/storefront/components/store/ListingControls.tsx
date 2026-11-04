'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { ProductFilterFacets } from '@sac/contracts';

const SORTS = [['relevance', 'Best match'], ['popular', 'Popularity'], ['newest', 'Newest'], ['price_asc', 'Price: Low to High'], ['price_desc', 'Price: High to Low']] as const;
function buildHref(basePath: string, params: Record<string, string | undefined>, changes: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, ...changes, page: undefined })) if (value) query.set(key, value);
  const text = query.toString(); return text ? `${basePath}?${text}` : basePath;
}
export function ListingControls({ kind, params, basePath, facets }: { kind: 'sort' | 'price'; params: Record<string, string | undefined>; basePath: string; facets?: ProductFilterFacets }) {
  const router = useRouter();
  const [min, setMin] = useState(params.min ?? '');
  const [max, setMax] = useState(params.max ?? '');
  const active = [params.min, params.max, params.in_stock, params.featured, params.discount_only].filter(Boolean).length;
  if (kind === 'sort') return <div className="sort">
    <button type="button" className="btn btn-ghost btn-sm mobile-only filter-open" onClick={() => document.getElementById('listing-filters')?.classList.toggle('open')}><SlidersHorizontal size={16}/> Filters{active > 0 ? ` · ${active}` : ''}</button>
    <label htmlFor="sort-select">Sort by:</label>
    <select id="sort-select" className="select" value={params.sort ?? (params.q ? 'relevance' : 'popular')} onChange={event => router.push(buildHref(basePath, params, { sort: event.target.value === (params.q ? 'relevance' : 'popular') ? undefined : event.target.value }))}>
      {SORTS.filter(([value]) => value !== 'relevance' || params.q).map(([value,label]) => <option key={value} value={value}>{label}</option>)}
    </select></div>;
  const apply = (event: FormEvent) => { event.preventDefault(); const clean=(v:string)=>/^\d{1,6}$/.test(v.trim())?v.trim():undefined; if(min&&max&&Number(min)>Number(max)) return; router.push(buildHref(basePath,params,{min:clean(min),max:clean(max)})); };
  const toggle=(key:'in_stock'|'featured'|'discount_only',checked:boolean)=>router.push(buildHref(basePath,params,{[key]:checked?'true':undefined}));
  const clear=()=>{setMin('');setMax('');router.push(buildHref(basePath,params,{min:undefined,max:undefined,in_stock:undefined,featured:undefined,discount_only:undefined}));};
  return <form className="price-filter advanced-filter" onSubmit={apply}>
    <div className="filter-title"><div><h3>Refine results</h3><small>Choose what matters to you</small></div>{active>0&&<button type="button" className="filter-clear" onClick={clear}>Clear all</button>}</div>
    <section className="filter-group"><h4>Price range</h4><small>{facets && facets.price_max_paise > 0 ? `Available range ₹${Math.floor(facets.price_min_paise / 100)}–₹${Math.ceil(facets.price_max_paise / 100)}` : "Enter a price range"}</small><div className="row">
      <label><span>Minimum (₹)</span><input className="input" inputMode="numeric" placeholder="0" aria-label="Minimum price" value={min} onChange={e=>setMin(e.target.value.replace(/\D/g,''))}/></label>
      <label><span>Maximum (₹)</span><input className="input" inputMode="numeric" placeholder="Any" aria-label="Maximum price" value={max} onChange={e=>setMax(e.target.value.replace(/\D/g,''))}/></label>
    </div><button type="submit" className="btn btn-primary btn-sm filter-apply">Apply price range</button></section>
    <section className="filter-group"><h4>Availability & offers</h4>
      <label className="filter-option"><input type="checkbox" checked={params.in_stock==='true'} onChange={e=>toggle('in_stock',e.target.checked)}/><span><strong>In stock</strong><small>Only items available to order{facets ? ` (${facets.counts.in_stock})` : ''}</small></span></label>
      <label className="filter-option"><input type="checkbox" checked={params.discount_only==='true'} onChange={e=>toggle('discount_only',e.target.checked)}/><span><strong>On sale</strong><small>Products with a discount{facets ? ` (${facets.counts.discounted})` : ''}</small></span></label>
      <label className="filter-option"><input type="checkbox" checked={params.featured==='true'} onChange={e=>toggle('featured',e.target.checked)}/><span><strong>Featured</strong><small>Handpicked store highlights{facets ? ` (${facets.counts.featured})` : ''}</small></span></label>
    </section>
    {min&&max&&Number(min)>Number(max)&&<p className="filter-error" role="alert">Minimum price must not exceed maximum price.</p>}
  </form>;
}
