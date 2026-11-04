'use client';

import { ApiRequestError } from '@sac/api-client';
import { normalizeIndianMobile } from '@sac/shared';
import { Check, Eye, EyeOff } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';

function PasswordInput({ id, label, value, onChange, autoComplete, error }: { id: string; label: string; value: string; onChange: (value: string) => void; autoComplete: string; error?: string | undefined }) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="field" htmlFor={id}><span>{label}</span>
      <div className="password-field">
        <input id={id} className="input" type={visible ? 'text' : 'password'} autoComplete={autoComplete} maxLength={128} value={value} onChange={event => onChange(event.target.value)} aria-invalid={Boolean(error)} />
        <button type="button" className="icon-btn" onClick={() => setVisible(!visible)} aria-label={visible ? 'Hide password' : 'Show password'}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button>
      </div>
      {error && <small className="field-error">{error}</small>}
    </label>
  );
}

/** Mirrors the server's rules so people see what is missing before submitting. */
function rules(password: string, phone: string | null) {
  const digits = (phone ?? '').replace(/^\+91/, '');
  return [
    { label: 'At least 10 characters', ok: password.length >= 10 },
    { label: 'Letters and numbers', ok: /[A-Za-z]/.test(password) && /\d/.test(password) },
    { label: 'Does not contain your mobile number', ok: !digits || !password.replace(/\D/g, '').includes(digits) },
  ];
}

export function ChangePasswordForm({ phone, onDone, submitLabel = 'Change password' }: { phone: string | null; onDone: () => void; submitLabel?: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const checks = rules(next, phone);
  const ready = current.length > 0 && checks.every(check => check.ok) && next === confirm;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== confirm) { setErrors({ confirm: 'Passwords do not match' }); return; }
    setBusy(true); setErrors({});
    try {
      await api.changeStaffPassword(current, next);
      setCurrent(''); setNext(''); setConfirm('');
      onDone();
    } catch (error) {
      if (error instanceof ApiRequestError) setErrors({ ...error.fields, form: Object.keys(error.fields).length ? '' : error.message });
      else setErrors({ form: 'Could not change the password. Try again.' });
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
      <PasswordInput id="current-password" label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" error={errors.current_password} />
      <PasswordInput id="new-password" label="New password" value={next} onChange={setNext} autoComplete="new-password" error={errors.new_password} />
      <ul className="password-rules" aria-label="Password requirements">
        {checks.map(check => <li key={check.label} className={check.ok ? 'ok' : ''}>{check.ok && <Check size={13} aria-hidden="true" />} {check.label}</li>)}
      </ul>
      <PasswordInput id="confirm-password" label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" error={errors.confirm ?? (confirm && confirm !== next ? 'Passwords do not match' : undefined)} />
      {errors.form && <p className="field-error" role="alert">{errors.form}</p>}
      <button className="btn btn-primary" disabled={busy || !ready}>{busy ? 'Saving…' : submitLabel}</button>
    </form>
  );
}

export function ChangePhoneForm({ onDone }: { onDone: (phone: string) => void }) {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeIndianMobile(phone);
    if (!normalized) { setErrors({ phone: 'Enter a valid 10-digit mobile number' }); return; }
    setBusy(true); setErrors({});
    try {
      const result = await api.changeStaffPhone(password, normalized);
      setPhone(''); setPassword('');
      onDone(result.phone);
    } catch (error) {
      if (error instanceof ApiRequestError) setErrors({ ...error.fields, form: Object.keys(error.fields).length ? '' : error.message });
      else setErrors({ form: 'Could not change the number. Try again.' });
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
      <label className="field" htmlFor="new-phone"><span>New mobile number</span>
        <div className="phone-field"><span>+91</span><input id="new-phone" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={10} value={phone} onChange={event => setPhone(event.target.value.replace(/\D/g, ''))} /></div>
        {errors.phone && <small className="field-error">{errors.phone}</small>}
      </label>
      <PasswordInput id="phone-current-password" label="Current password" value={password} onChange={setPassword} autoComplete="current-password" error={errors.current_password} />
      {errors.form && <p className="field-error" role="alert">{errors.form}</p>}
      <button className="btn btn-primary" disabled={busy || phone.length !== 10 || !password}>{busy ? 'Saving…' : 'Change mobile number'}</button>
    </form>
  );
}
