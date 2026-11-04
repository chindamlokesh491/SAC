'use client';

import { ApiRequestError } from '@sac/api-client';
import { formatDateTime, formatPhone, normalizeIndianMobile } from '@sac/shared';
import { Copy, KeyRound, ShieldCheck, UserMinus, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Modal } from '@sac/ui-web';
import { adminError, useAdmin } from './AdminProvider';

type Staff = { id: string; display_name: string | null; phone_e164: string; role: 'admin' | 'operator' | 'delivery_partner'; must_change_password: boolean; last_sign_in_at: string | null; is_you: boolean };
type Action = { kind: 'add' } | { kind: 'remove' | 'reset'; member: Staff };

/** Admin accounts: add, reset or remove staff. Every change is confirmed with the acting admin's own password. */
export function StaffManager() {
  const { request, toast } = useAdmin();
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [issued, setIssued] = useState<{ phone: string; password: string; reset: boolean } | null>(null);

  const load = useCallback(async () => {
    try { setStaff((await request<{ data: Staff[] }>('/api/v1/admin/staff')).data); } catch (error) { toast(adminError(error), 'error'); }
  }, [request, toast]);
  useEffect(() => { void load(); }, [load]);
  const admins = staff?.filter(member => member.role === 'admin').length ?? 0;

  return (
    <section className="form-section">
      <h2>Admin accounts <small>Who can sign in to this panel</small></h2>
      <div className="staff-list">
        {staff === null ? <div className="skeleton" style={{ height: 60 }} /> : staff.map(member => (
          <div key={member.id} className="staff-row">
            <div>
              <strong>{member.display_name ?? formatPhone(member.phone_e164)}{member.is_you && <span className="muted"> (you)</span>}</strong>
              <small>{member.display_name ? `${formatPhone(member.phone_e164)} · ` : ''}{member.must_change_password ? 'Has not set a password yet' : member.last_sign_in_at ? `Last signed in ${formatDateTime(member.last_sign_in_at)}` : 'Never signed in'}</small>
            </div>
            <span className={`badge ${member.role === 'admin' ? 'badge-danger' : 'badge-neutral'}`}>{member.role === 'admin' ? 'Admin' : member.role === 'operator' ? 'Operator' : 'Delivery partner'}</span>
            {!member.is_you && (
              <div className="row-actions">
                {member.role !== 'delivery_partner' && <button type="button" className="icon-btn" onClick={() => setAction({ kind: 'reset', member })} aria-label={`Reset password for ${formatPhone(member.phone_e164)}`} title="Issue a new temporary password"><KeyRound size={17} /></button>}
                <button type="button" className="icon-btn" disabled={member.role === 'admin' && admins <= 1} onClick={() => setAction({ kind: 'remove', member })} aria-label={`Remove ${formatPhone(member.phone_e164)}`} title="Remove access"><UserMinus size={17} color="var(--red)" /></button>
              </div>
            )}
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAction({ kind: 'add' })}><UserPlus size={16} /> Add staff or delivery partner</button>
      <p className="field-hint" style={{ margin: 0 }}>Admins can change everything. Operators can view and fulfil orders. Delivery partners use SMS OTP sign-in at <a href="/admin/delivery-partner/login">/admin/delivery-partner/login</a> and only see their assigned deliveries. You are asked for your own password before any change.</p>

      {action && (
        <StaffDialog action={action} onClose={() => setAction(null)} onDone={async (result, message) => {
          setAction(null);
          if (result) setIssued(result);
          else toast(message ?? 'Access removed. They have been signed out.', 'success');
          await load();
        }} />
      )}
      {issued && (
        <Modal title={issued.reset ? 'New temporary password' : 'Account created'} onClose={() => setIssued(null)}>
          <div className="modal-body confirm-body">
            <p>Give this temporary password to <strong>{formatPhone(issued.phone)}</strong> in person or by phone. It is shown only once. They must set their own password before they can sign in and use this account.</p>
            <div className="temp-password"><code>{issued.password}</code>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(issued.password).then(() => toast('Copied', 'success'), () => toast('Select the password and copy it', 'info')); }}><Copy size={15} /> Copy</button>
            </div>
          </div>
          <div className="modal-foot"><button type="button" className="btn btn-primary" onClick={() => setIssued(null)}>Done</button></div>
        </Modal>
      )}
    </section>
  );
}

function StaffDialog({ action, onClose, onDone }: { action: Action; onClose: () => void; onDone: (issued: { phone: string; password: string; reset: boolean } | null, message?: string) => Promise<void> }) {
  const { request } = useAdmin();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'admin' | 'operator' | 'delivery_partner'>('operator');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setErrors({});
    try {
      setBusy(true);
      if (action.kind === 'add') {
        const normalized = normalizeIndianMobile(phone);
        if (!normalized) { setErrors({ phone: 'Enter a valid 10-digit mobile number' }); return; }
        const result = await request<{ data: { phone: string; temporary_password: string | null } }>('/api/v1/admin/staff', { method: 'POST', body: { phone: normalized, role, ...(name.trim() ? { name: name.trim() } : {}), current_password: password } });
        if (role === 'delivery_partner') await onDone(null, 'Delivery partner account created. Share the registered mobile number; sign-in uses SMS OTP.');
        else if (result.data.temporary_password) await onDone({ phone: result.data.phone, password: result.data.temporary_password, reset: false });
        else throw new Error('Temporary password could not be created.');
      } else if (action.kind === 'reset') {
        const result = await request<{ data: { temporary_password: string } }>(`/api/v1/admin/staff/${action.member.id}/reset-password`, { method: 'POST', body: { current_password: password } });
        await onDone({ phone: action.member.phone_e164, password: result.data.temporary_password, reset: true });
      } else {
        await request(`/api/v1/admin/staff/${action.member.id}/remove`, { method: 'POST', body: { current_password: password } });
        await onDone(null);
      }
    } catch (error) {
      setErrors(error instanceof ApiRequestError && Object.keys(error.fields).length ? error.fields : { _: adminError(error) });
    } finally { setBusy(false); }
  };

  const title = action.kind === 'add' ? 'Add staff account' : action.kind === 'reset' ? 'Reset password' : 'Remove access';
  return (
    <Modal title={title} onClose={() => { if (!busy) onClose(); }}>
      <form onSubmit={submit}>
        <div className="modal-body confirm-body">
          {action.kind === 'add' ? (
            <>
              <label className="field" htmlFor="staff-new-phone"><span>Mobile number</span>
                <div className="phone-field"><span>+91</span><input id="staff-new-phone" type="tel" inputMode="numeric" maxLength={10} value={phone} onChange={event => setPhone(event.target.value.replace(/\D/g, ''))} /></div>
                {errors.phone && <small className="field-error">{errors.phone}</small>}
              </label>
              <label className="field" htmlFor="staff-new-name"><span>Name (optional)</span><input id="staff-new-name" className="input" maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
              <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}><span>Access</span>
                <label className="radio-line"><input type="radio" name="staff-role" checked={role === 'admin'} onChange={() => setRole('admin')} /> <span><strong>Admin</strong> — everything, including products, prices, settings and staff</span></label>
                <label className="radio-line"><input type="radio" name="staff-role" checked={role === 'operator'} onChange={() => setRole('operator')} /> <span><strong>Operator</strong> — view and fulfil orders only</span></label>
                <label className="radio-line"><input type="radio" name="staff-role" checked={role === 'delivery_partner'} onChange={() => setRole('delivery_partner')} /> <span><strong>Delivery partner</strong> — dedicated delivery account; no admin panel access</span></label>
              </fieldset>
            </>
          ) : action.kind === 'reset' ? (
            <p>Issue a new temporary password for <strong>{formatPhone(action.member.phone_e164)}</strong>? Their current password stops working and they are signed out everywhere.</p>
          ) : (
            <p>Remove admin panel access for <strong>{action.member.display_name ?? formatPhone(action.member.phone_e164)}</strong>? They are signed out immediately and can no longer sign in. You can add the number again later.</p>
          )}
          <label className="field" htmlFor="staff-confirm-password"><span><ShieldCheck size={15} style={{ verticalAlign: '-3px' }} /> Your password, to confirm</span>
            <input id="staff-confirm-password" className="input" type="password" autoComplete="current-password" maxLength={128} value={password} onChange={event => setPassword(event.target.value)} />
            {errors.current_password && <small className="field-error">{errors.current_password}</small>}
          </label>
          {errors._ && <p className="alert alert-danger" style={{ margin: 0 }}>{errors._}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className={`btn ${action.kind === 'remove' ? 'btn-danger' : 'btn-primary'}`} disabled={busy || !password || (action.kind === 'add' && phone.length !== 10)}>
            {busy ? 'Working…' : action.kind === 'add' ? (role === 'delivery_partner' ? 'Create delivery account' : 'Add and create password') : action.kind === 'reset' ? 'Issue new password' : 'Remove access'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
