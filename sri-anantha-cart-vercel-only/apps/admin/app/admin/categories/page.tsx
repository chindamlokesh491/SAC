'use client';

import { ApiRequestError } from '@sac/api-client';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { ImageUpload } from '@/components/admin/ImageUpload';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { EmptyRow, LoadingRows } from '@/components/admin/ui';
import { Modal } from '@sac/ui-web';

type Category = { id: string; name: string; slug: string; description: string | null; image_url: string | null; parent_category_id: string | null; sort_order: number; is_active: boolean; is_featured: boolean; product_count: number; child_count: number };
type Draft = { id?: string; name: string; slug: string; description: string; image_url: string | null; parent_category_id: string; sort_order: string; is_active: boolean; is_featured: boolean };
const slugify = (value: string) => value.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);

export default function CategoriesPage() {
  const { request, toast, isAdmin } = useAdmin();
  const [rows, setRows] = useState<Category[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [featured, setFeatured] = useState({ count: 0, limit: 8 });
  const [removing, setRemoving] = useState<Category | null>(null);
  const load = useCallback(async () => {
    try {
      const result = await request<{ data: Category[]; featured: { count: number; limit: number } }>('/api/v1/admin/categories', { query: { include_inactive: 'true' } });
      setRows(result.data); setFeatured(result.featured);
    }
    catch (error) { toast(adminError(error), 'error'); setRows([]); }
  }, [request, toast]);
  useEffect(() => { void load(); }, [load]);

  const tops = (rows ?? []).filter(row => !row.parent_category_id);
  const ordered = tops.flatMap(top => [top, ...(rows ?? []).filter(row => row.parent_category_id === top.id)]);
  const open = (row?: Category, parentId = '') => { setErrors({}); setDraft(row ? { id: row.id, name: row.name, slug: row.slug, description: row.description ?? '', image_url: row.image_url, parent_category_id: row.parent_category_id ?? '', sort_order: String(row.sort_order), is_active: row.is_active, is_featured: row.is_featured } : { name: '', slug: '', description: '', image_url: null, parent_category_id: parentId, sort_order: String((rows?.length ?? 0) + 1), is_active: true, is_featured: false }); };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setBusy(true); setErrors({});
    const body = { name: draft.name.trim(), slug: draft.slug, description: draft.description.trim() || null, image_url: draft.image_url, parent_category_id: draft.parent_category_id || null, sort_order: Number(draft.sort_order || 0), is_active: draft.is_active, is_featured: draft.is_featured };
    try {
      await request(draft.id ? `/api/v1/admin/categories/${draft.id}` : '/api/v1/admin/categories', { method: draft.id ? 'PATCH' : 'POST', body });
      toast('Category saved', 'success'); setDraft(null); await load();
    } catch (error) {
      const message = adminError(error);
      setErrors(error instanceof ApiRequestError ? { ...error.fields, _: message } : { _: message });
    } finally { setBusy(false); }
  };
  const toggle = async (row: Category, field: 'is_active' | 'is_featured' = 'is_active') => {
    if (field === 'is_featured' && !row.is_featured && featured.count >= featured.limit) {
      toast(`You cannot feature more than ${featured.limit} categories. Remove another one to add this.`, 'error');
      return;
    }
    try { await request(`/api/v1/admin/categories/${row.id}`, { method: 'PATCH', body: { [field]: !row[field] } }); await load(); }
    catch (error) { toast(adminError(error), 'error'); }
  };
  const askDelete = (row: Category) => {
    if (row.product_count > 0) { toast('Products exists, so it cannot be deleted.', 'error'); return; }
    if (row.child_count > 0) { toast('This category has subcategories. Delete them first.', 'error'); return; }
    setRemoving(row);
  };
  const remove = async (row: Category) => {
    try { await request(`/api/v1/admin/categories/${row.id}`, { method: 'DELETE' }); toast(`"${row.name}" deleted`, 'success'); setRemoving(null); await load(); }
    catch (error) { toast(adminError(error), 'error'); setRemoving(null); }
  };
  const featuredFull = featured.count >= featured.limit;

  return (
    <>
      <div className="admin-page-head">
        <div><h1>Categories</h1><p>Two levels: main category → subcategory. Inactive categories are hidden from the storefront. Up to {featured.limit} featured categories appear under “Shop by Category”; if fewer are chosen, the rest are picked at random.</p></div>
        {isAdmin && <button type="button" className="btn btn-primary" onClick={() => open()}><Plus size={18} /> Add Category</button>}
      </div>
      <section className="panel">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Category</th><th>Slug</th><th className="num">Products</th><th className="num">Sort</th><th>Active</th><th><span className="th-featured">Featured <span className={`featured-count${featuredFull ? ' full' : ''}`} title="Featured categories selected">{featured.count}/{featured.limit}</span></span></th><th>Actions</th></tr></thead>
            <tbody>
              {rows === null ? <LoadingRows colSpan={7} /> : ordered.length === 0 ? <EmptyRow colSpan={7} text="No categories yet" /> : ordered.map(row => (
                <tr key={row.id} className={row.parent_category_id ? 'tree-child' : ''}>
                  <td><span className="prod">{row.image_url ? <img src={row.image_url.replace(/\.webp$/, '-sm.webp')} alt="" width={36} height={36} /> : null}<span>{row.parent_category_id ? '↳ ' : ''}<strong>{row.name}</strong></span></span></td>
                  <td>{row.slug}</td><td className="num">{row.product_count}</td><td className="num">{row.sort_order}</td>
                  <td><label className="switch"><input type="checkbox" checked={row.is_active} disabled={!isAdmin} onChange={() => void toggle(row)} aria-label={`Active: ${row.name}`} /></label></td>
                  <td><label className="switch"><input type="checkbox" checked={row.is_featured} disabled={!isAdmin} onChange={() => void toggle(row, 'is_featured')} aria-label={`Featured: ${row.name}`} /></label></td>
                  <td><div className="row-actions">
                    {isAdmin && <button type="button" className="btn-view" onClick={() => open(row)}>Edit</button>}
                    {isAdmin && !row.parent_category_id && <button type="button" className="btn-view" onClick={() => open(undefined, row.id)}>+ Subcategory</button>}
                    {isAdmin && <button type="button" className="btn-view danger" onClick={() => askDelete(row)} title={row.product_count > 0 ? 'Products exists, so it cannot be deleted.' : undefined}>Delete</button>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {removing && (
        <ConfirmDialog title={removing.parent_category_id ? 'Delete subcategory' : 'Delete category'} confirmLabel="Delete" tone="danger" onClose={() => setRemoving(null)} onConfirm={() => remove(removing)}>
          <p>Delete <strong>{removing.name}</strong>? It has no products, so nothing else is affected. This cannot be undone.</p>
        </ConfirmDialog>
      )}
      {draft && (
        <Modal title={draft.id ? 'Edit category' : draft.parent_category_id ? 'Add subcategory' : 'Add category'} onClose={() => setDraft(null)}>
          <form onSubmit={save}>
            <div className="modal-body">
              <label className="field"><span>Name *</span><input className="input" value={draft.name} maxLength={120} onChange={event => setDraft({ ...draft, name: event.target.value, slug: draft.id ? draft.slug : slugify(event.target.value) })} />{errors.name && <span className="field-error">{errors.name}</span>}</label>
              <label className="field"><span>Slug *</span><input className="input" value={draft.slug} onChange={event => setDraft({ ...draft, slug: slugify(event.target.value) })} /></label>
              <label className="field"><span>Parent category</span>
                <select className="select" value={draft.parent_category_id} onChange={event => setDraft({ ...draft, parent_category_id: event.target.value })}>
                  <option value="">— None (main category) —</option>{tops.filter(top => top.id !== draft.id).map(top => <option key={top.id} value={top.id}>{top.name}</option>)}
                </select></label>
              <ImageUpload purpose="category" label="Category image (shown on storefront)" value={draft.image_url} onChange={url => setDraft({ ...draft, image_url: url })} />
              <label className="field"><span>Description</span><textarea className="textarea" value={draft.description} maxLength={2000} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
              <div className="form-grid">
                <label className="field"><span>Sort order</span><input className="input" inputMode="numeric" value={draft.sort_order} onChange={event => setDraft({ ...draft, sort_order: event.target.value.replace(/\D/g, '') })} /></label>
                <label className="switch" style={{ alignSelf: 'end', paddingBottom: 10 }}><input type="checkbox" checked={draft.is_active} onChange={event => setDraft({ ...draft, is_active: event.target.checked })} /> Active</label>
              </div>
              <label className="switch"><input type="checkbox" checked={draft.is_featured} disabled={featuredFull && !draft.is_featured && !rows?.find(row => row.id === draft.id)?.is_featured} onChange={event => setDraft({ ...draft, is_featured: event.target.checked })} /> Featured in “Shop by Category” <span className={`featured-count${featuredFull ? ' full' : ''}`}>{featured.count}/{featured.limit}</span></label>
              {featuredFull && !draft.is_featured && <small className="field-hint">{featured.limit} categories are already featured. You cannot select more than {featured.limit}; remove another to add this one.</small>}
              {errors._ && <p className="alert alert-danger">{errors._}</p>}
            </div>
            <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={() => setDraft(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || draft.name.trim().length < 2}>Save</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}
