'use client';

import { ApiRequestError } from '@sac/api-client';
import { formatRupees } from '@sac/shared';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { EmptyRow, LoadingRows } from '@/components/admin/ui';
import { Modal } from '@sac/ui-web';

type Zone = { id: string; name: string; postal_codes: string[]; delivery_fee_paise: number; minimum_order_paise: number; estimated_minutes: number; cod_enabled: boolean; cod_limit_paise: number; is_active: boolean };
type Slot = { id: string; zone_id: string | null; zone_name: string | null; name: string; starts_at: string; ends_at: string; is_scheduled: boolean; is_active: boolean };
type DeliverySettings = { free_delivery_threshold_paise: number; express_enabled: boolean; scheduled_days_ahead: number; scheduled_lead_minutes: number };
const rupees = (paise: number) => String(paise / 100);
const hhmm = (time: string) => time.slice(0, 5);

export default function DeliveryPage() {
  const { request, toast, isAdmin } = useAdmin();
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [settings, setSettings] = useState<DeliverySettings | null>(null);
  const [zoneDraft, setZoneDraft] = useState<(Omit<Zone, 'id' | 'postal_codes' | 'delivery_fee_paise' | 'minimum_order_paise' | 'cod_limit_paise' | 'estimated_minutes'> & { id?: string; postal_codes: string; fee: string; minimum: string; cod_limit: string; minutes: string }) | null>(null);
  const [slotDraft, setSlotDraft] = useState<{ id?: string; zone_id: string; name: string; starts_at: string; ends_at: string; is_scheduled: boolean; is_active: boolean } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [z, s, all] = await Promise.all([
        request<{ data: Zone[] }>('/api/v1/admin/delivery-zones'),
        request<{ data: Slot[] }>('/api/v1/admin/delivery-slots'),
        request<{ data: { delivery: DeliverySettings } }>('/api/v1/admin/settings'),
      ]);
      setZones(z.data); setSlots(s.data); setSettings(all.data.delivery);
    } catch (err) { toast(adminError(err), 'error'); }
  }, [request, toast]);
  useEffect(() => { void load(); }, [load]);

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    try { await request('/api/v1/admin/settings/delivery', { method: 'PUT', body: settings }); toast('Delivery charges saved', 'success'); }
    catch (err) { toast(adminError(err), 'error'); } finally { setBusy(false); }
  };
  const saveZone = async (event: FormEvent) => {
    event.preventDefault();
    if (!zoneDraft) return;
    if (zoneDraft.name.trim().length < 2) { setError('Zone name must be at least 2 characters'); return; }
    const codes = [...new Set(zoneDraft.postal_codes.split(/[\s,]+/).map(code => code.trim()).filter(Boolean))];
    if (!codes.length || codes.some(code => !/^[1-9][0-9]{5}$/.test(code))) { setError('Enter valid 6-digit PIN codes separated by commas'); return; }
    const body = { name: zoneDraft.name.trim(), postal_codes: codes, delivery_fee_paise: Math.round(Number(zoneDraft.fee || 0) * 100), minimum_order_paise: Math.round(Number(zoneDraft.minimum || 0) * 100), estimated_minutes: Number(zoneDraft.minutes || 30), cod_enabled: zoneDraft.cod_enabled, cod_limit_paise: Math.round(Number(zoneDraft.cod_limit || 0) * 100), is_active: zoneDraft.is_active };
    setBusy(true); setError('');
    try { await request(zoneDraft.id ? `/api/v1/admin/delivery-zones/${zoneDraft.id}` : '/api/v1/admin/delivery-zones', { method: zoneDraft.id ? 'PATCH' : 'POST', body }); toast('Delivery zone saved', 'success'); setZoneDraft(null); await load(); }
    catch (err) { setError(err instanceof ApiRequestError ? err.message : adminError(err)); } finally { setBusy(false); }
  };
  const saveSlot = async (event: FormEvent) => {
    event.preventDefault();
    if (!slotDraft) return;
    if (slotDraft.ends_at <= slotDraft.starts_at) { setError('End time must be after start time'); return; }
    setBusy(true); setError('');
    const body = slotDraft.id
      ? { name: slotDraft.name.trim(), starts_at: slotDraft.starts_at, ends_at: slotDraft.ends_at, is_scheduled: slotDraft.is_scheduled, is_active: slotDraft.is_active }
      : { zone_id: slotDraft.zone_id || null, name: slotDraft.name.trim(), starts_at: slotDraft.starts_at, ends_at: slotDraft.ends_at, is_scheduled: slotDraft.is_scheduled, is_active: slotDraft.is_active };
    try { await request(slotDraft.id ? `/api/v1/admin/delivery-slots/${slotDraft.id}` : '/api/v1/admin/delivery-slots', { method: slotDraft.id ? 'PATCH' : 'POST', body }); toast('Delivery slot saved', 'success'); setSlotDraft(null); await load(); }
    catch (err) { setError(adminError(err)); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="admin-page-head"><div><h1>Delivery Settings</h1><p>Serviceable PIN codes, delivery charges, Deliver Now hours, scheduled slots and COD availability for Tirupati.</p></div></div>
      {settings && (
        <form className="form-section" onSubmit={saveSettings} style={{ marginBottom: 16 }}>
          <h2>Delivery charges &amp; scheduling</h2>
          <fieldset disabled={!isAdmin} style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="form-grid cols-4">
              <label className="field"><span>Free delivery above (₹)</span><input className="input" inputMode="numeric" value={rupees(settings.free_delivery_threshold_paise)} onChange={event => setSettings({ ...settings, free_delivery_threshold_paise: Math.round(Number(event.target.value.replace(/[^\d.]/g, '') || 0) * 100) })} /><span className="field-hint">0 = never free</span></label>
              <label className="field"><span>Scheduled days ahead</span><input className="input" inputMode="numeric" value={settings.scheduled_days_ahead} onChange={event => setSettings({ ...settings, scheduled_days_ahead: Math.min(7, Number(event.target.value.replace(/\D/g, '') || 0)) })} /></label>
              <label className="field"><span>Slot lead time (minutes)</span><input className="input" inputMode="numeric" value={settings.scheduled_lead_minutes} onChange={event => setSettings({ ...settings, scheduled_lead_minutes: Number(event.target.value.replace(/\D/g, '') || 0) })} /></label>
              <label className="switch" style={{ alignSelf: 'center' }}><input type="checkbox" checked={settings.express_enabled} onChange={event => setSettings({ ...settings, express_enabled: event.target.checked })} /> Deliver Now (15-30 min) enabled</label>
            </div>
            {isAdmin && <div style={{ marginTop: 12 }}><button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Save charges</button></div>}
          </fieldset>
        </form>
      )}
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head"><h2 className="sans">Delivery zones</h2>{isAdmin && <button type="button" className="btn btn-primary btn-sm" onClick={() => { setError(''); setZoneDraft({ name: '', postal_codes: '', fee: '30', minimum: '0', minutes: '30', cod_enabled: true, cod_limit: '2000', is_active: false }); }}><Plus size={16} /> Add zone</button>}</div>
        <div className="panel-body table-wrap">
          <table className="table">
            <thead><tr><th>Zone</th><th>PIN codes</th><th className="num">Fee</th><th className="num">Min. order</th><th className="num">ETA</th><th>COD</th><th>Active</th><th /></tr></thead>
            <tbody>{zones === null ? <LoadingRows colSpan={8} rows={2} /> : zones.length === 0 ? <EmptyRow colSpan={8} text="No delivery zones — customers cannot check out until one is active" /> : zones.map(zone => (
              <tr key={zone.id}>
                <td><strong>{zone.name}</strong></td><td className="wrap" style={{ maxWidth: 280 }}>{zone.postal_codes.join(', ')}</td>
                <td className="num">{formatRupees(zone.delivery_fee_paise)}</td><td className="num">{formatRupees(zone.minimum_order_paise)}</td><td className="num">{zone.estimated_minutes} min</td>
                <td>{zone.cod_enabled ? `Yes${zone.cod_limit_paise ? ` (≤ ${formatRupees(zone.cod_limit_paise)})` : ''}` : 'No'}</td>
                <td>{zone.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-neutral">Inactive</span>}</td>
                <td>{isAdmin && <button type="button" className="btn-view" onClick={() => { setError(''); setZoneDraft({ id: zone.id, name: zone.name, postal_codes: zone.postal_codes.join(', '), fee: rupees(zone.delivery_fee_paise), minimum: rupees(zone.minimum_order_paise), minutes: String(zone.estimated_minutes), cod_enabled: zone.cod_enabled, cod_limit: rupees(zone.cod_limit_paise), is_active: zone.is_active }); }}>Edit</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><h2 className="sans">Delivery time slots</h2>{isAdmin && <button type="button" className="btn btn-primary btn-sm" onClick={() => { setError(''); setSlotDraft({ zone_id: '', name: '', starts_at: '09:00', ends_at: '12:00', is_scheduled: true, is_active: false }); }}><Plus size={16} /> Add slot</button>}</div>
        <div className="panel-body">
          <p className="field-hint" style={{ marginTop: 0 }}>“Deliver Now” windows set the hours when 15-30 minute delivery is offered. Scheduled slots are offered for today and the next days set above.</p>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Name</th><th>Type</th><th>Window</th><th>Zone</th><th>Active</th><th /></tr></thead>
            <tbody>{slots === null ? <LoadingRows colSpan={6} rows={3} /> : slots.length === 0 ? <EmptyRow colSpan={6} text="No slots configured" /> : slots.map(slot => (
              <tr key={slot.id}>
                <td><strong>{slot.name}</strong></td><td>{slot.is_scheduled ? 'Scheduled slot' : 'Deliver Now hours'}</td><td>{hhmm(slot.starts_at)} – {hhmm(slot.ends_at)}</td><td>{slot.zone_name ?? 'All zones'}</td>
                <td>{slot.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-neutral">Inactive</span>}</td>
                <td>{isAdmin && <button type="button" className="btn-view" onClick={() => { setError(''); setSlotDraft({ id: slot.id, zone_id: slot.zone_id ?? '', name: slot.name, starts_at: hhmm(slot.starts_at), ends_at: hhmm(slot.ends_at), is_scheduled: slot.is_scheduled, is_active: slot.is_active }); }}>Edit</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      </section>
      {zoneDraft && (
        <Modal title={zoneDraft.id ? 'Edit delivery zone' : 'Add delivery zone'} onClose={() => setZoneDraft(null)}>
          <form onSubmit={saveZone}>
            <div className="modal-body">
              <label className="field"><span>Zone name</span><input className="input" value={zoneDraft.name} maxLength={120} onChange={event => setZoneDraft({ ...zoneDraft, name: event.target.value })} required /></label>
              <label className="field"><span>PIN codes (comma separated)</span><textarea className="textarea" value={zoneDraft.postal_codes} onChange={event => setZoneDraft({ ...zoneDraft, postal_codes: event.target.value })} placeholder="517501, 517502" /></label>
              <div className="form-grid">
                <label className="field"><span>Delivery fee (₹)</span><input className="input" inputMode="decimal" value={zoneDraft.fee} onChange={event => setZoneDraft({ ...zoneDraft, fee: event.target.value.replace(/[^\d.]/g, '') })} /></label>
                <label className="field"><span>Minimum order (₹)</span><input className="input" inputMode="decimal" value={zoneDraft.minimum} onChange={event => setZoneDraft({ ...zoneDraft, minimum: event.target.value.replace(/[^\d.]/g, '') })} /></label>
                <label className="field"><span>Deliver Now ETA (minutes)</span><input className="input" inputMode="numeric" value={zoneDraft.minutes} onChange={event => setZoneDraft({ ...zoneDraft, minutes: event.target.value.replace(/\D/g, '') })} /></label>
                <label className="field"><span>COD limit (₹, 0 = no limit)</span><input className="input" inputMode="decimal" value={zoneDraft.cod_limit} onChange={event => setZoneDraft({ ...zoneDraft, cod_limit: event.target.value.replace(/[^\d.]/g, '') })} /></label>
              </div>
              <label className="switch"><input type="checkbox" checked={zoneDraft.cod_enabled} onChange={event => setZoneDraft({ ...zoneDraft, cod_enabled: event.target.checked })} /> Cash on Delivery available in this zone</label>
              <label className="switch"><input type="checkbox" checked={zoneDraft.is_active} onChange={event => setZoneDraft({ ...zoneDraft, is_active: event.target.checked })} /> Zone active (accepting orders)</label>
              {error && <p className="alert alert-danger">{error}</p>}
            </div>
            <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={() => setZoneDraft(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>Save zone</button></div>
          </form>
        </Modal>
      )}
      {slotDraft && (
        <Modal title={slotDraft.id ? 'Edit slot' : 'Add slot'} onClose={() => setSlotDraft(null)}>
          <form onSubmit={saveSlot}>
            <div className="modal-body">
              <label className="field"><span>Name</span><input className="input" value={slotDraft.name} maxLength={80} onChange={event => setSlotDraft({ ...slotDraft, name: event.target.value })} placeholder="Morning" required /></label>
              <label className="field"><span>Type</span><select className="select" value={slotDraft.is_scheduled ? 'scheduled' : 'express'} onChange={event => setSlotDraft({ ...slotDraft, is_scheduled: event.target.value === 'scheduled' })}><option value="scheduled">Scheduled delivery slot</option><option value="express">Deliver Now operating hours</option></select></label>
              <div className="form-grid">
                <label className="field"><span>Starts</span><input className="input" type="time" value={slotDraft.starts_at} onChange={event => setSlotDraft({ ...slotDraft, starts_at: event.target.value })} /></label>
                <label className="field"><span>Ends</span><input className="input" type="time" value={slotDraft.ends_at} onChange={event => setSlotDraft({ ...slotDraft, ends_at: event.target.value })} /></label>
              </div>
              {!slotDraft.id && <label className="field"><span>Zone</span><select className="select" value={slotDraft.zone_id} onChange={event => setSlotDraft({ ...slotDraft, zone_id: event.target.value })}><option value="">All zones</option>{(zones ?? []).map(zone => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>}
              <label className="switch"><input type="checkbox" checked={slotDraft.is_active} onChange={event => setSlotDraft({ ...slotDraft, is_active: event.target.checked })} /> Active</label>
              {error && <p className="alert alert-danger">{error}</p>}
            </div>
            <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={() => setSlotDraft(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>Save slot</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}
