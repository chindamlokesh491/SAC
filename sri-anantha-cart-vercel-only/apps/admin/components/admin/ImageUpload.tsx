'use client';

import { ImagePlus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { adminError, useAdmin } from './AdminProvider';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

/** Single-image uploader backed by the admin media endpoint (images are re-encoded server-side). Accepts drag & drop. */
export function ImageUpload({ value, onChange, label = 'Image', purpose = 'product' }: { value: string | null; onChange: (url: string | null) => void; label?: string; purpose?: 'product' | 'category' | 'banner' }) {
  const { request, toast } = useAdmin();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) { toast('Upload a JPG, PNG, WebP or AVIF image', 'error'); return; }
    if (file.size > 4 * 1024 * 1024) { toast('Images must be 4 MB or smaller', 'error'); return; }
    setBusy(true);
    const body = new FormData(); body.append('file', file);
    try { onChange((await request<{ data: { url: string } }>(`/api/v1/admin/media?purpose=${purpose}`, { method: 'POST', body })).data.url); }
    catch (error) { toast(adminError(error), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="field">
      <span>{label}</span>
      <div className={`single-drop${dragging ? ' dragging' : ''}`}
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)}
        onDrop={event => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files[0]); }}>
        <div className="image-tile" style={{ width: 96 }}>{value ? <img src={value.replace(/\.webp$/, '-sm.webp')} alt="" /> : <ImagePlus size={24} color="var(--muted)" />}</div>
        <div style={{ display: 'grid', gap: 6 }}>
          <label className="btn btn-ghost btn-sm">{busy ? 'Uploading…' : value ? 'Replace' : 'Upload'}<input type="file" accept={ACCEPTED.join(',')} hidden onChange={event => void upload(event.target.files?.[0])} /></label>
          <small className="field-hint">{dragging ? 'Drop to upload' : 'or drag an image here'}</small>
        </div>
        {value && <button type="button" className="icon-btn" onClick={() => onChange(null)} aria-label="Remove image"><Trash2 size={17} color="var(--red)" /></button>}
      </div>
    </div>
  );
}
