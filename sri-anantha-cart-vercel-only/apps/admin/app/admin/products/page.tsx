'use client';

import { type CategoryNode } from '@sac/contracts';
import { formatRupees } from '@sac/shared';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { EmptyRow, LoadingRows, Pager } from '@/components/admin/ui';

type Row = { id: string; name: string; sku: string; slug: string; price_paise: number; mrp_paise: number | null; gst_rate_basis_points: number; stock: number; minimum_stock_level: number; is_active: boolean; is_featured: boolean; archived_at: string | null; thumb_url: string | null; category_name: string | null; subcategory_name: string | null; variant_count: number };
const LIMIT = 20;

function Products() {
  const { request, toast, isAdmin } = useAdmin();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const params = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [stock, setStock] = useState(params.get('stock') ?? '');
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [featured, setFeatured] = useState({ count: 0, limit: 8 });
  const [dialog, setDialog] = useState<null | { kind: 'archive' | 'delete'; row: Row }>(null);

  useEffect(() => { request<{ data: CategoryNode[] }>('/api/v1/categories').then(result => setCategories(result.data)).catch(() => undefined); }, [request]);
  const load = useCallback(async () => {
    setRows(null);
    try {
      const result = await request<{ data: Row[]; pagination: { total: number }; featured: { count: number; limit: number } }>('/api/v1/admin/products', { query: { search: search.trim(), category, status, stock, limit: LIMIT, offset } });
      setRows(result.data); setTotal(result.pagination.total); setFeatured(result.featured);
    } catch (error) { toast(adminError(error), 'error'); setRows([]); }
  }, [request, toast, search, category, status, stock, offset]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), search ? 300 : 0); return () => window.clearTimeout(timer); }, [load, search]);

  const toggle = async (row: Row, field: 'is_active' | 'is_featured') => {
    if (field === 'is_featured' && !row.is_featured && featured.count >= featured.limit) {
      toast(`You cannot feature more than ${featured.limit} products. Remove another one to add this.`, 'error');
      return;
    }
    try { await request(`/api/v1/admin/products/${row.id}`, { method: 'PATCH', body: { [field]: !row[field] } }); await load(); }
    catch (error) { toast(adminError(error), 'error'); }
  };
  const archive = async (row: Row) => {
    try { await request(`/api/v1/admin/products/${row.id}`, { method: 'DELETE' }); toast('Product archived', 'success'); setDialog(null); await load(); }
    catch (error) { toast(adminError(error), 'error'); }
  };
  const removeForever = async (row: Row, typed: string) => {
    try {
      await request(`/api/v1/admin/products/${row.id}/delete-permanently`, { method: 'POST', body: { confirm_name: typed } });
      toast(`"${row.name}" was deleted permanently`, 'success'); setDialog(null); await load();
    } catch (error) { toast(adminError(error), 'error'); }
  };
  const restore = async (row: Row) => {
    try { await request(`/api/v1/admin/products/${row.id}/restore`, { method: 'POST' }); toast('Product restored as inactive', 'success'); await load(); }
    catch (error) { toast(adminError(error), 'error'); }
  };

  return (
    <>
      <div className="admin-page-head">
        <div><h1>Products</h1><p>Add, edit, hide or delete products. Stock is managed in Inventory. Up to {featured.limit} products can be featured on the home page; if fewer are chosen, the rest are picked at random.</p></div>
        {isAdmin && <Link href="/admin/products/new" className="btn btn-primary"><Plus size={18} /> Add Product</Link>}
      </div>
      <section className="panel">
        <div className="toolbar">
          <input className="input grow" type="search" placeholder="Search name, SKU or slug" value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} aria-label="Search products" />
          <select className="select" value={category} onChange={event => { setCategory(event.target.value); setOffset(0); }} aria-label="Category">
            <option value="">All categories</option>
            {categories.map(item => [<option key={item.id} value={item.id}>{item.name}</option>, ...item.children.map(child => <option key={child.id} value={child.id}>&nbsp;&nbsp;↳ {child.name}</option>)])}
          </select>
          <select className="select" value={status} onChange={event => { setStatus(event.target.value); setOffset(0); }} aria-label="Status">
            <option value="">Active &amp; inactive</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="archived">Archived</option>
          </select>
          <select className="select" value={stock} onChange={event => { setStock(event.target.value); setOffset(0); }} aria-label="Stock">
            <option value="">Any stock</option><option value="low">Low stock</option><option value="out">Out of stock</option>
          </select>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Product</th><th>SKU</th><th>Category</th><th className="num">Price</th><th className="num">MRP</th><th className="num">GST</th><th className="num">Stock</th><th>Visible</th><th><span className="th-featured">Featured <span className={`featured-count${featured.count >= featured.limit ? ' full' : ''}`} title="Featured products selected">{featured.count}/{featured.limit}</span></span></th><th>Actions</th></tr></thead>
            <tbody>
              {rows === null ? <LoadingRows colSpan={10} /> : rows.length === 0 ? <EmptyRow colSpan={10} text="No products found" /> : rows.map(row => (
                <tr key={row.id}>
                  <td><span className="prod">{row.thumb_url && <img src={row.thumb_url} alt="" width={36} height={36} />}<span><Link className="row-link" href={`/admin/products/${row.id}`}>{row.name}</Link>{row.variant_count > 0 && <small>{row.variant_count} variants</small>}</span></span></td>
                  <td>{row.sku}</td>
                  <td>{row.category_name ?? '—'}{row.subcategory_name && <><br /><small className="muted">{row.subcategory_name}</small></>}</td>
                  <td className="num">{formatRupees(row.price_paise)}</td>
                  <td className="num">{formatRupees(row.mrp_paise ?? row.price_paise)}</td>
                  <td className="num">{row.gst_rate_basis_points / 100}%</td>
                  <td className={`num${row.stock <= row.minimum_stock_level ? ' stock-low' : ''}`}>{row.stock}</td>
                  <td>{row.archived_at ? <span className="badge badge-neutral">Archived</span> : <label className="switch"><input type="checkbox" checked={row.is_active} disabled={!isAdmin} onChange={() => void toggle(row, 'is_active')} aria-label={`Visible: ${row.name}`} /></label>}</td>
                  <td>{!row.archived_at && <label className="switch"><input type="checkbox" checked={row.is_featured} disabled={!isAdmin} onChange={() => void toggle(row, 'is_featured')} aria-label={`Featured: ${row.name}`} /></label>}</td>
                  <td><div className="row-actions">
                    <Link href={`/admin/products/${row.id}`} className="btn-view">{isAdmin ? 'Edit' : 'View'}</Link>
                    {isAdmin && (row.archived_at ? <button type="button" className="btn-view" onClick={() => void restore(row)}>Restore</button> : <button type="button" className="btn-view" onClick={() => setDialog({ kind: 'archive', row })}>Archive</button>)}
                    {isAdmin && <button type="button" className="btn-view danger" onClick={() => setDialog({ kind: 'delete', row })}>Delete</button>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager offset={offset} limit={LIMIT} total={total} onChange={setOffset} />
      </section>
      {dialog?.kind === 'archive' && (
        <ConfirmDialog title="Archive product" confirmLabel="Archive" onClose={() => setDialog(null)} onConfirm={() => archive(dialog.row)}>
          <p><strong>{dialog.row.name}</strong> will be hidden from the store and removed from carts. It stays in the database for order history and can be restored later.</p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog title="Delete product permanently" confirmLabel="Delete permanently" tone="danger" typeToConfirm={dialog.row.name} onClose={() => setDialog(null)} onConfirm={typed => removeForever(dialog.row, typed)}>
          <p>This removes <strong>{dialog.row.name}</strong> from the database and from every admin and customer page. It cannot be undone.</p>
          <ul>
            <li>Deleted: product details, sizes/packs, photos, stock history, and any carts or wishlists holding it.</li>
            <li>Kept: past orders and invoices, which have their own copy of the name, price and GST.</li>
            <li>Not allowed while the product is in an order that is still open.</li>
          </ul>
        </ConfirmDialog>
      )}
    </>
  );
}

export default function ProductsPage() { return <Suspense fallback={null}><Products /></Suspense>; }
