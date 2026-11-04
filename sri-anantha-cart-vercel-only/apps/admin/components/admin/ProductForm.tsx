'use client';

import { type CategoryNode } from '@sac/contracts';
import { ApiRequestError } from '@sac/api-client';
import { discountPercent, formatRupees } from '@sac/shared';
import { ArrowLeft, ImagePlus, Plus, Star, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { adminError, useAdmin } from './AdminProvider';

type Variant = { id?: string; label: string; sku: string; price: string; mrp: string; weight: string; is_active: boolean; initial_quantity: string; quantity?: number };
export type ProductRecord = {
  id: string; name: string; slug: string; sku: string; short_description: string | null; description: string; category_id: string; subcategory_id: string | null;
  price_paise: number; mrp_paise: number | null; gst_rate_basis_points: number; hsn_code: string | null; minimum_stock_level: number; weight_grams: number | null;
  highlights: string[]; is_active: boolean; is_featured: boolean; quantity: number;
  images: { url: string; thumb_url: string | null; alt_text: string | null }[];
  variants: { id: string; label: string; sku: string; price_paise: number; mrp_paise: number; weight_grams: number | null; is_active: boolean; quantity: number }[];
};

const rupees = (paise: number | null | undefined) => (paise === null || paise === undefined ? '' : (paise / 100).toString());
const toPaise = (value: string) => Math.round(Number(value) * 100);
const slugify = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);

export function ProductForm({ product }: { product?: ProductRecord }) {
  const { request, toast, isAdmin } = useAdmin();
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [form, setForm] = useState({
    name: product?.name ?? '', slug: product?.slug ?? '', sku: product?.sku ?? '', short_description: product?.short_description ?? '',
    description: product?.description ?? '', category_id: product?.category_id ?? '', subcategory_id: product?.subcategory_id ?? '',
    price: rupees(product?.price_paise), mrp: rupees(product?.mrp_paise ?? product?.price_paise), gst: String(product?.gst_rate_basis_points ?? 500),
    hsn_code: product?.hsn_code ?? '', minimum_stock_level: String(product?.minimum_stock_level ?? 5), weight: product?.weight_grams ? String(product.weight_grams) : '',
    highlights: (product?.highlights ?? []).join(', '), is_active: product?.is_active ?? true, is_featured: product?.is_featured ?? false, initial_quantity: '0',
  });
  const [images, setImages] = useState(product?.images ?? []);
  const [variants, setVariants] = useState<Variant[]>(product?.variants.map(item => ({ id: item.id, label: item.label, sku: item.sku, price: rupees(item.price_paise), mrp: rupees(item.mrp_paise), weight: item.weight_grams ? String(item.weight_grams) : '', is_active: item.is_active, initial_quantity: '0', quantity: item.quantity })) ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const slugTouched = useRef(Boolean(product));

  useEffect(() => { request<{ data: CategoryNode[] }>('/api/v1/admin/categories', { query: { include_inactive: 'true' } }).then(result => {
    // Admin endpoint returns a flat list; build the two-level tree.
    const flat = result.data as unknown as (CategoryNode & { parent_category_id: string | null })[];
    setCategories(flat.filter(item => !item.parent_category_id).map(item => ({ ...item, children: flat.filter(child => child.parent_category_id === item.id) })));
  }).catch(() => undefined); }, [request]);

  const set = (key: keyof typeof form, value: string | boolean) => setForm(current => ({ ...current, [key]: value }));
  const subcategories = categories.find(item => item.id === form.category_id)?.children ?? [];

  const [dragging, setDragging] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [featured, setFeatured] = useState<{ count: number; limit: number } | null>(null);
  useEffect(() => {
    request<{ featured: { count: number; limit: number } }>('/api/v1/admin/products', { query: { limit: 1 } }).then(result => setFeatured(result.featured)).catch(() => undefined);
  }, [request]);
  const featuredFull = Boolean(featured && featured.count >= featured.limit && !product?.is_featured);

  const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
  const upload = async (list: FileList | File[] | null) => {
    const all = Array.from(list ?? []);
    const files = all.filter(file => ACCEPTED.includes(file.type));
    if (all.length > files.length) toast('Only JPG, PNG, WebP or AVIF images can be added', 'error');
    if (!files.length) return;
    if (files.length > 8 - images.length) toast(`Only ${8 - images.length} more image${8 - images.length === 1 ? '' : 's'} can be added (8 at most)`, 'info');
    setUploading(true);
    for (const file of files.slice(0, 8 - images.length)) {
      if (file.size > 4 * 1024 * 1024) { toast(`${file.name} is larger than 4 MB`, 'error'); continue; }
      const body = new FormData(); body.append('file', file);
      try {
        const result = await request<{ data: { url: string; thumb_url: string } }>('/api/v1/admin/media?purpose=product', { method: 'POST', body });
        setImages(current => [...current, { url: result.data.url, thumb_url: result.data.thumb_url, alt_text: null }]);
      } catch (error) { toast(adminError(error, `Could not upload ${file.name}`), 'error'); }
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
  };
  const dropImageAt = (target: number) => {
    if (dragIndex === null || dragIndex === target) return;
    setImages(current => { const next = [...current]; const [moved] = next.splice(dragIndex, 1); next.splice(target, 0, moved!); return next; });
    setDragIndex(null);
  };
  const moveImage = (index: number, direction: -1 | 1) => setImages(current => {
    const next = [...current]; const target = index + direction;
    if (target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target]!, next[index]!]; return next;
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setErrors({});
    const body = {
      name: form.name.trim(), slug: form.slug.trim(), sku: form.sku.trim().toUpperCase(), short_description: form.short_description.trim() || null,
      description: form.description.trim(), category_id: form.category_id, subcategory_id: form.subcategory_id || null,
      price_paise: toPaise(form.price), mrp_paise: toPaise(form.mrp || form.price), gst_rate_basis_points: Number(form.gst),
      hsn_code: form.hsn_code.trim() || null, minimum_stock_level: Number(form.minimum_stock_level || 0), weight_grams: form.weight ? Number(form.weight) : null,
      highlights: form.highlights.split(',').map(item => item.trim()).filter(Boolean).slice(0, 4), is_active: form.is_active, is_featured: form.is_featured,
      images: images.map(image => ({ url: image.url, alt_text: image.alt_text || null })),
      variants: variants.map(item => ({
        ...(item.id ? { id: item.id } : { initial_quantity: Number(item.initial_quantity || 0) }),
        label: item.label.trim(), sku: item.sku.trim().toUpperCase(), price_paise: toPaise(item.price), mrp_paise: toPaise(item.mrp || item.price),
        weight_grams: item.weight ? Number(item.weight) : null, is_active: item.is_active,
      })),
      ...(product ? {} : { initial_quantity: Number(form.initial_quantity || 0) }),
    };
    setBusy(true);
    try {
      const result = await request<{ data: ProductRecord }>(product ? `/api/v1/admin/products/${product.id}` : '/api/v1/admin/products', { method: product ? 'PUT' : 'POST', body });
      toast(product ? 'Product saved' : 'Product created', 'success');
      if (!product) { router.replace(`/admin/products/${result.data.id}`); return; }
      // Newly added variants now have server IDs; keep the form in sync so a second save updates them.
      setImages(result.data.images);
      setVariants(result.data.variants.map(item => ({ id: item.id, label: item.label, sku: item.sku, price: rupees(item.price_paise), mrp: rupees(item.mrp_paise), weight: item.weight_grams ? String(item.weight_grams) : '', is_active: item.is_active, initial_quantity: '0', quantity: item.quantity })));
    } catch (error) {
      if (error instanceof ApiRequestError) setErrors({ ...error.fields, _: error.message });
      else setErrors({ _: adminError(error) });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally { setBusy(false); }
  };

  const err = (key: string) => errors[key] ? <span className="field-error">{errors[key]}</span> : null;
  const off = discountPercent(toPaise(form.price || '0'), toPaise(form.mrp || '0'));
  return (
    <form onSubmit={submit} noValidate>
      <Link href="/admin/products" className="link-red" style={{ marginBottom: 12 }}><ArrowLeft size={16} /> All products</Link>
      <div className="admin-page-head"><div><h1>{product ? product.name : 'Add Product'}</h1><p>{product ? `SKU ${product.sku}` : 'Fields marked * are required by the Phase 1 scope.'}</p></div></div>
      {errors._ && <div className="alert alert-danger" role="alert" style={{ marginBottom: 14 }}>{errors._}</div>}
      <fieldset disabled={!isAdmin} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="form-layout">
          <div className="admin-form">
            <section className="form-section">
              <h2>Basic details</h2>
              <label className="field"><span>Product title *</span><input className="input" value={form.name} maxLength={160} onChange={event => { set('name', event.target.value); if (!slugTouched.current) set('slug', slugify(event.target.value)); }} />{err('name')}</label>
              <div className="form-grid">
                <label className="field"><span>URL slug *</span><input className="input" value={form.slug} onChange={event => { slugTouched.current = true; set('slug', slugify(event.target.value)); }} />{err('slug')}</label>
                <label className="field"><span>SKU *</span><input className="input" value={form.sku} onChange={event => set('sku', event.target.value.toUpperCase())} maxLength={64} />{err('sku')}</label>
              </div>
              <label className="field"><span>Short subtitle <small className="muted">(shown on cards, e.g. “Natural Fragrance”)</small></span><input className="input" value={form.short_description} maxLength={120} onChange={event => set('short_description', event.target.value)} />{err('short_description')}</label>
              <label className="field"><span>Description *</span><textarea className="textarea" rows={5} value={form.description} maxLength={4000} onChange={event => set('description', event.target.value)} />{err('description')}</label>
              <label className="field"><span>Highlights <small className="muted">(up to 4, comma separated)</small></span><input className="input" value={form.highlights} onChange={event => set('highlights', event.target.value)} placeholder="Natural Fragrance, Long Lasting, Premium Quality, Traditional Aroma" />{err('highlights')}</label>
            </section>
            <section className={`form-section image-drop${dragging ? ' dragging' : ''}`}
              onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
              onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); setDragging(false); if (images.length < 8) void upload(event.dataTransfer.files); else toast('8 images is the maximum', 'error'); }}>
              <h2>Images * <small>Drag photos here or click to upload. Drag tiles to reorder; the first image is the thumbnail. JPG, PNG, WebP up to 4 MB, 8 at most.</small></h2>
              <div className="image-grid">
                {images.map((image, index) => (
                  <div key={image.url} className={`image-tile${dragIndex === index ? ' moving' : ''}`} draggable
                    onDragStart={event => { setDragIndex(index); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)); }}
                    onDragOver={event => { if (dragIndex !== null) event.preventDefault(); }}
                    onDrop={event => { if (dragIndex === null) return; event.preventDefault(); event.stopPropagation(); dropImageAt(index); }}
                    onDragEnd={() => setDragIndex(null)}>
                    <img src={image.thumb_url ?? image.url} alt="" />
                    {index === 0 && <span className="badge badge-success primary-tag"><Star size={12} /> Thumbnail</span>}
                    <div className="tile-actions">
                      <button type="button" onClick={() => moveImage(index, -1)} aria-label="Move left"><ChevronLeft size={16} /></button>
                      <button type="button" onClick={() => setImages(current => current.filter((_, i) => i !== index))} aria-label="Remove image"><Trash2 size={15} color="var(--red)" /></button>
                      <button type="button" onClick={() => moveImage(index, 1)} aria-label="Move right"><ChevronRight size={16} /></button>
                    </div>
                  </div>
                ))}
                {images.length < 8 && (
                  <label className="upload-tile">
                    <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple hidden onChange={event => void upload(event.target.files)} />
                    <span>{uploading ? <span className="spinner" style={{ margin: '0 auto' }} /> : <ImagePlus size={26} style={{ margin: '0 auto 6px' }} />}{uploading ? 'Uploading…' : dragging ? 'Drop to upload' : 'Drag & drop or click'}</span>
                  </label>
                )}
              </div>
              {err('images')}
            </section>
            <section className="form-section">
              <h2>Variants <small>Optional — size or pack options, each with its own price and stock</small></h2>
              {variants.length > 0 && (
                <div className="table-wrap"><table className="table variant-table">
                  <thead><tr><th>Label</th><th>SKU</th><th>Price ₹</th><th>MRP ₹</th><th>Weight g</th><th>{product ? 'Stock' : 'Opening stock'}</th><th>Active</th><th /></tr></thead>
                  <tbody>{variants.map((item, index) => {
                    const update = (key: keyof Variant, value: string | boolean) => setVariants(current => current.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
                    return (
                      <tr key={item.id ?? index}>
                        <td><input className="input" value={item.label} onChange={event => update('label', event.target.value)} placeholder="250 g" maxLength={40} /></td>
                        <td><input className="input" value={item.sku} onChange={event => update('sku', event.target.value.toUpperCase())} maxLength={64} /></td>
                        <td><input className="input" inputMode="decimal" value={item.price} onChange={event => update('price', event.target.value.replace(/[^\d.]/g, ''))} style={{ width: 90 }} /></td>
                        <td><input className="input" inputMode="decimal" value={item.mrp} onChange={event => update('mrp', event.target.value.replace(/[^\d.]/g, ''))} style={{ width: 90 }} /></td>
                        <td><input className="input" inputMode="numeric" value={item.weight} onChange={event => update('weight', event.target.value.replace(/\D/g, ''))} style={{ width: 80 }} /></td>
                        <td>{item.id ? <span>{item.quantity ?? 0}</span> : <input className="input" inputMode="numeric" value={item.initial_quantity} onChange={event => update('initial_quantity', event.target.value.replace(/\D/g, ''))} style={{ width: 80 }} />}</td>
                        <td><label className="switch"><input type="checkbox" checked={item.is_active} onChange={event => update('is_active', event.target.checked)} /></label></td>
                        <td><button type="button" className="icon-btn" onClick={() => setVariants(current => current.filter((_, i) => i !== index))} aria-label="Remove variant"><Trash2 size={17} color="var(--red)" /></button></td>
                      </tr>
                    );
                  })}</tbody>
                </table></div>
              )}
              {err('variants')}
              <div><button type="button" className="btn btn-ghost btn-sm" onClick={() => setVariants(current => [...current, { label: '', sku: `${form.sku || 'SKU'}-${current.length + 1}`, price: form.price, mrp: form.mrp, weight: '', is_active: true, initial_quantity: '0' }])}><Plus size={16} /> Add variant</button></div>
            </section>
          </div>
          <div className="sticky-actions">
            <section className="form-section">
              <h2>Visibility</h2>
              <label className="switch"><input type="checkbox" checked={form.is_active} onChange={event => set('is_active', event.target.checked)} /> Active (visible on storefront)</label>
              <label className="switch"><input type="checkbox" checked={form.is_featured} disabled={featuredFull && !form.is_featured} onChange={event => set('is_featured', event.target.checked)} /> Featured in “Popular Products” {featured && <span className={`featured-count${featured.count >= featured.limit ? ' full' : ''}`}>{featured.count + (form.is_featured && !product?.is_featured ? 1 : 0) - (!form.is_featured && product?.is_featured ? 1 : 0)}/{featured.limit}</span>}</label>
              {featuredFull && <small className="field-hint">{featured!.limit} products are already featured. You cannot select more than {featured!.limit}; remove another to add this one.</small>}
            </section>
            <section className="form-section">
              <h2>Category</h2>
              <label className="field"><span>Category *</span>
                <select className="select" value={form.category_id} onChange={event => { set('category_id', event.target.value); set('subcategory_id', ''); }}>
                  <option value="">Choose…</option>{categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>{err('category_id')}</label>
              <label className="field"><span>Subcategory {subcategories.length ? '*' : ''}</span>
                <select className="select" value={form.subcategory_id} onChange={event => set('subcategory_id', event.target.value)} disabled={!subcategories.length}>
                  <option value="">{subcategories.length ? 'Choose…' : 'No subcategories'}</option>{subcategories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>{err('subcategory_id')}</label>
            </section>
            <section className="form-section">
              <h2>Pricing &amp; tax</h2>
              <div className="form-grid">
                <label className="field"><span>Selling price ₹ *</span><input className="input" inputMode="decimal" value={form.price} onChange={event => set('price', event.target.value.replace(/[^\d.]/g, ''))} />{err('price_paise')}</label>
                <label className="field"><span>MRP ₹ *</span><input className="input" inputMode="decimal" value={form.mrp} onChange={event => set('mrp', event.target.value.replace(/[^\d.]/g, ''))} />{err('mrp_paise')}</label>
              </div>
              <p className="field-hint" style={{ margin: 0 }}>Discount: {off > 0 ? `${off}% (customer saves ${formatRupees(toPaise(form.mrp) - toPaise(form.price))})` : 'none'} · prices include GST</p>
              <div className="form-grid">
                <label className="field"><span>GST rate *</span><select className="select" value={form.gst} onChange={event => set('gst', event.target.value)}>{[0, 500, 1200, 1800, 2800].map(rate => <option key={rate} value={rate}>{rate / 100}%</option>)}</select></label>
                <label className="field"><span>HSN code</span><input className="input" inputMode="numeric" value={form.hsn_code} maxLength={8} onChange={event => set('hsn_code', event.target.value.replace(/\D/g, ''))} />{err('hsn_code')}</label>
              </div>
            </section>
            <section className="form-section">
              <h2>Stock &amp; shipping</h2>
              <div className="form-grid">
                {!product && !variants.length && <label className="field"><span>Opening stock *</span><input className="input" inputMode="numeric" value={form.initial_quantity} onChange={event => set('initial_quantity', event.target.value.replace(/\D/g, ''))} /></label>}
                {product && !variants.length && <div className="field"><span>Current stock</span><input className="input" value={product.quantity} disabled /><span className="field-hint">Adjust in <Link className="link-red" href={`/admin/inventory?product=${product.id}`}>Inventory</Link></span></div>}
                <label className="field"><span>Minimum stock level *</span><input className="input" inputMode="numeric" value={form.minimum_stock_level} onChange={event => set('minimum_stock_level', event.target.value.replace(/\D/g, ''))} />{err('minimum_stock_level')}</label>
                <label className="field"><span>Weight (g)</span><input className="input" inputMode="numeric" value={form.weight} onChange={event => set('weight', event.target.value.replace(/\D/g, ''))} />{err('weight_grams')}</label>
              </div>
            </section>
            {isAdmin && <button type="submit" className="btn btn-primary btn-lg" disabled={busy || uploading}>{busy ? <span className="spinner" /> : product ? 'Save Changes' : 'Create Product'}</button>}
          </div>
        </div>
      </fieldset>
    </form>
  );
}
