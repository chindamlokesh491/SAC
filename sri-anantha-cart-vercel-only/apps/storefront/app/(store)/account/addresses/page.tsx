'use client';

import { type Address } from '@sac/contracts';
import { formatAddressLine, formatPhone } from '@sac/shared';
import { MapPin } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AddressModal } from '@/components/store/AddressModal';
import { errorMessage, useStore } from '@/components/store/StoreProvider';
import { api } from '@/lib/api';

export default function AddressesPage() {
  const { user, toast } = useStore();
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [editing, setEditing] = useState<Address | 'new' | null>(null);
  const load = useCallback(() => api.addresses().then(setAddresses).catch(() => setAddresses([])), []);
  useEffect(() => { void load(); }, [load]);

  const makeDefault = async (address: Address) => {
    if (address.is_default) return;
    try { await api.updateAddress(address.id, { is_default: true }); await load(); toast('Default address updated', 'success'); }
    catch (error) { toast(errorMessage(error), 'error'); }
  };
  const remove = async (address: Address) => {
    if (!window.confirm('Delete this address?')) return;
    try { await api.deleteAddress(address.id); await load(); toast('Address deleted'); }
    catch (error) { toast(errorMessage(error), 'error'); }
  };

  return (
    <>
      <div className="account-head"><h1>My Addresses</h1><button type="button" className="btn btn-outline" onClick={() => setEditing('new')}>Add New Address</button></div>
      {addresses === null ? <div className="skeleton" style={{ height: 220 }} /> : addresses.length === 0 ? (
        <div className="empty"><MapPin size={40} style={{ margin: '0 auto 10px', color: 'var(--saffron)' }} /><h2>No saved addresses</h2><button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>Add Address</button></div>
      ) : (
        <div className="option-list" role="radiogroup" aria-label="Default address">
          {addresses.map(address => (
            <label key={address.id} className={`option${address.is_default ? ' selected' : ''}`}>
              <input type="radio" name="default-address" checked={address.is_default} onChange={() => void makeDefault(address)} aria-label={`Make ${address.label ?? address.recipient_name} the default address`} />
              <div className="option-body">
                <strong>{address.label ? `${address.label} · ` : ''}{address.recipient_name}{address.is_default && <span className="badge badge-success" style={{ marginLeft: 8 }}>Default</span>}</strong>
                <p>{formatAddressLine(address)}</p>
                <p>{formatPhone(address.phone_e164)}</p>
              </div>
              <div className="option-actions" style={{ alignSelf: 'center' }}>
                <button type="button" onClick={event => { event.preventDefault(); setEditing(address); }}>Edit</button>
                <span className="sep">|</span>
                <button type="button" onClick={event => { event.preventDefault(); void remove(address); }}>Delete</button>
              </div>
            </label>
          ))}
        </div>
      )}
      {editing && <AddressModal address={editing === 'new' ? null : editing} defaultPhone={user?.phone} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); toast('Address saved', 'success'); }} />}
    </>
  );
}
