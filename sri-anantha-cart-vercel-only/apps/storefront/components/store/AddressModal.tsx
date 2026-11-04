'use client';

import { type Address, type AddressInput } from '@sac/contracts';
import { ApiRequestError } from '@sac/api-client';
import { normalizeIndianMobile, isValidPostalCode } from '@sac/shared';
import { LocateFixed } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { useDeviceLocation } from './LocationTools';
import { Modal } from '@sac/ui-web';
import { errorMessage } from './StoreProvider';

const empty: AddressInput = { label: 'Home', recipient_name: '', phone_e164: '', line1: '', line2: '', locality: '', city: 'Tirupati', state: 'Andhra Pradesh', postal_code: '', delivery_instructions: '' };

export function AddressModal({ address, onClose, onSaved, defaultPhone }: { address?: Address | null; onClose: () => void; onSaved: (address: Address) => void; defaultPhone?: string | null }) {
  const [form, setForm] = useState<AddressInput>(() => address
    ? { label: address.label, recipient_name: address.recipient_name, phone_e164: address.phone_e164.replace(/^\+91/, ''), line1: address.line1, line2: address.line2 ?? '', locality: address.locality, city: address.city, state: address.state, postal_code: address.postal_code, delivery_instructions: address.delivery_instructions ?? '', is_default: address.is_default }
    : { ...empty, phone_e164: (defaultPhone ?? '').replace(/^\+91/, '') });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (key: keyof AddressInput, value: string | boolean) => setForm(current => ({ ...current, [key]: value }));
  const location = useDeviceLocation();
  const [detected, setDetected] = useState<string | null>(null);
  // Fills the fields from the device's location. Everything stays editable; house number is left to the customer.
  const detect = async () => {
    const found = await location.detect();
    if (!found) return;
    setForm(current => ({
      ...current,
      line1: current.line1.trim() ? current.line1 : (found.line1 ?? ''),
      locality: found.locality ?? current.locality,
      city: found.city ?? current.city,
      state: found.state ?? current.state,
      postal_code: found.postal_code ?? current.postal_code,
    }));
    setErrors({});
    setDetected(found.display || 'your location');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (form.recipient_name.trim().length < 2) next.recipient_name = 'Enter the recipient name';
    const phone = normalizeIndianMobile(form.phone_e164);
    if (!phone) next.phone_e164 = 'Enter a valid 10-digit mobile number';
    if (form.line1.trim().length < 3) next.line1 = 'Enter house / street details';
    if (form.locality.trim().length < 2) next.locality = 'Enter the area or locality';
    if (!isValidPostalCode(form.postal_code)) next.postal_code = 'Enter a valid 6-digit PIN code';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const payload: AddressInput = { ...form, phone_e164: phone!, label: form.label?.trim() || null, line2: form.line2?.trim() || null, delivery_instructions: form.delivery_instructions?.trim() || null };
      const saved = address ? await api.updateAddress(address.id, payload) : await api.createAddress(payload);
      onSaved(saved);
    } catch (error) {
      if (error instanceof ApiRequestError && Object.keys(error.fields).length) setErrors(error.fields);
      else setErrors({ _: errorMessage(error) });
    } finally { setBusy(false); }
  };

  const field = (key: keyof AddressInput, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="field">
      <span>{label}</span>
      <input className="input" value={String(form[key] ?? '')} onChange={event => set(key, event.target.value)} aria-invalid={Boolean(errors[key])} {...props} />
      {errors[key] && <span className="field-error">{errors[key]}</span>}
    </label>
  );

  return (
    <Modal title={address ? 'Edit Address' : 'Add New Address'} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <div className="modal-body">
          <div className="field">
            <span>Save as</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {['Home', 'Office', 'Other'].map(label => (
                <button key={label} type="button" className={`chip${form.label === label ? ' active' : ''}`} onClick={() => set('label', label)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="locate-box">
            <button type="button" className="btn btn-outline btn-sm" onClick={() => void detect()} disabled={location.busy}>
              <LocateFixed size={16} /> {location.busy ? 'Finding your location…' : 'Use my current location'}
            </button>
            {location.error && <p className="field-error" role="alert" style={{ margin: 0 }}>{location.error}</p>}
            {detected && !location.error && <p className="field-hint" role="status" style={{ margin: 0 }}>Filled from {detected}. Please check every field and add your house or flat number. Map data © OpenStreetMap contributors.</p>}
          </div>
          <div className="form-grid-2">
            {field('recipient_name', 'Full name', { autoComplete: 'name', maxLength: 100 })}
            {field('phone_e164', 'Mobile number', { inputMode: 'numeric', autoComplete: 'tel-national', maxLength: 14 })}
          </div>
          {field('line1', 'House no., building, street', { autoComplete: 'address-line1', maxLength: 200 })}
          {field('line2', 'Landmark (optional)', { autoComplete: 'address-line2', maxLength: 200 })}
          <div className="form-grid-2">
            {field('locality', 'Area / locality', { maxLength: 120 })}
            {field('postal_code', 'PIN code', { inputMode: 'numeric', autoComplete: 'postal-code', maxLength: 6 })}
          </div>
          <div className="form-grid-2">
            {field('city', 'City', { autoComplete: 'address-level2', maxLength: 100 })}
            {field('state', 'State', { autoComplete: 'address-level1', maxLength: 100 })}
          </div>
          {field('delivery_instructions', 'Delivery instructions (optional)', { maxLength: 300 })}
          <label className="checkbox"><input type="checkbox" checked={Boolean(form.is_default)} onChange={event => set('is_default', event.target.checked)} /> Make this my default address</label>
          {errors._ && <p className="alert alert-danger" role="alert">{errors._}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : 'Save Address'}</button>
        </div>
      </form>
    </Modal>
  );
}
