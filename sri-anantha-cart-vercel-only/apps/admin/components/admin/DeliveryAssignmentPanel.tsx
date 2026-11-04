'use client';

import { formatDateTime, formatPhone } from '@sac/shared';
import { useCallback, useEffect, useState } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';

type Partner = { id: string; display_name: string | null; phone_e164: string; active_assignments: number };
type Assignment = { id: string; status: string; assigned_at: string; completed_at: string | null; delivery_person_id: string; partner_name: string | null; partner_phone: string; assigned_by_name: string | null };
type AssignmentResponse = { fulfilment_provider: string; history: Assignment[] };

/** Manual assignment only: selecting a partner is always an explicit staff action. */
export function DeliveryAssignmentPanel({ orderId, fulfilmentProvider, orderStatus }: {
  orderId: string; fulfilmentProvider: string | null; orderStatus: string;
}) {
  const { request, toast } = useAdmin();
  const [partners, setPartners] = useState<Partner[]>([]);
  const [history, setHistory] = useState<Assignment[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (fulfilmentProvider !== 'self_delivery') return;
    try {
      const [p, a] = await Promise.all([
        request<{ data: Partner[] }>('/api/v1/admin/delivery-partners'),
        request<{ data: AssignmentResponse }>(`/api/v1/admin/orders/${orderId}/delivery-assignment`),
      ]);
      setPartners(p.data);
      setHistory(a.data.history);
      setSelected(a.data.history.find(entry => entry.status === 'assigned')?.delivery_person_id ?? '');
    } catch (error) { toast(adminError(error), 'error'); }
  }, [request, orderId, toast, fulfilmentProvider]);
  useEffect(() => { void load(); }, [load]);
  if (fulfilmentProvider !== 'self_delivery') return null;
  const active = history.find(entry => entry.status === 'assigned');
  const locked = ['cancelled', 'delivered', 'return_requested', 'refund_initiated', 'refund_completed', 'refunded'].includes(orderStatus);
  const assign = async () => {
    if (!selected || locked) return;
    setBusy(true);
    try {
      await request(`/api/v1/admin/orders/${orderId}/delivery-assignment`, {
        method: 'POST', body: { delivery_person_id: selected },
      });
      toast(active ? 'Delivery partner reassigned' : 'Delivery partner assigned', 'success');
      await load();
    } catch (error) { toast(adminError(error), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <section className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head"><h2 className="sans">Self-delivery assignment</h2></div>
      <div className="panel-body" style={{ display: 'grid', gap: 12 }}>
        {active ? (
          <p style={{ margin: 0 }}><strong>Assigned:</strong> {active.partner_name ?? formatPhone(active.partner_phone)} · {formatPhone(active.partner_phone)}<br />
            <small className="muted">Assigned {formatDateTime(active.assigned_at)}{active.assigned_by_name ? ` by ${active.assigned_by_name}` : ''}</small></p>
        ) : <p className="alert alert-warning" style={{ margin: 0 }}>Awaiting delivery assignment. No partner has been assigned automatically.</p>}
        <label className="field"><span>{active ? 'Choose replacement partner' : 'Select delivery partner'}</span>
          <select className="input" value={selected} onChange={event => setSelected(event.target.value)} disabled={locked || busy}>
            <option value="">Select a delivery partner</option>
            {partners.map(partner => <option key={partner.id} value={partner.id}>
              {(partner.display_name || formatPhone(partner.phone_e164))} · {formatPhone(partner.phone_e164)} · {partner.active_assignments} active
            </option>)}
          </select>
        </label>
        <div><button type="button" className="btn btn-primary btn-sm" onClick={() => void assign()} disabled={!selected || selected === active?.delivery_person_id || locked || busy}>
          {busy ? 'Saving…' : active ? 'Confirm reassignment' : 'Assign delivery partner'}
        </button></div>
        {partners.length === 0 && <p className="field-hint" style={{ margin: 0 }}>No active delivery-partner accounts are available. Create or activate a delivery-partner account before assigning this order.</p>}
        {history.length > 0 && <div><strong>Assignment history</strong><ol className="timeline" style={{ marginTop: 10 }}>
          {history.map(entry => <li key={entry.id}><span><strong>{entry.status === 'assigned' ? 'Current assignment' : entry.status}</strong>
            <small>{entry.partner_name ?? formatPhone(entry.partner_phone)} · {formatDateTime(entry.assigned_at)}{entry.assigned_by_name ? ` · by ${entry.assigned_by_name}` : ''}</small></span></li>)}
        </ol></div>}
        {locked && <p className="field-hint" style={{ margin: 0 }}>Assignment changes are disabled for this order status.</p>}
      </div>
    </section>
  );
}
