'use client';

import { ApiRequestError } from '@sac/api-client';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { StaffManager } from '@/components/admin/StaffManager';

type Settings = {
  store: { name: string; tagline: string; support_phone: string; support_email: string; whatsapp: string; gstin: string; legal_name: string; address: string; state_code: string; instagram_url: string; facebook_url: string; youtube_url: string };
  payments: { upi: boolean; card: boolean; net_banking: boolean; wallet: boolean; cod: boolean; cod_limit_paise: number };
  tax: { show_breakup_on_invoice: boolean };
};
type Integrations = { online_payments_available: boolean; razorpay_configured: boolean; sms_configured: boolean; google_sign_in_configured: boolean };

export default function SettingsPage() {
  const { request, toast, isAdmin } = useAdmin();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [errors, setErrors] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState('');

  useEffect(() => {
    request<{ data: Settings; integrations: Integrations }>('/api/v1/admin/settings')
      .then(result => { setSettings(result.data); setIntegrations(result.integrations); })
      .catch(error => toast(adminError(error), 'error'));
  }, [request, toast]);

  const save = (section: keyof Settings) => async (event: FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    setBusy(section); setErrors(current => ({ ...current, [section]: {} }));
    try { await request(`/api/v1/admin/settings/${section}`, { method: 'PUT', body: settings[section] }); toast('Settings saved', 'success'); }
    catch (error) { setErrors(current => ({ ...current, [section]: error instanceof ApiRequestError ? error.fields : { _: adminError(error) } })); toast(adminError(error), 'error'); }
    finally { setBusy(''); }
  };
  if (!settings) return <div className="skeleton" style={{ height: 400 }} />;
  const store = settings.store;
  const setStore = (key: keyof Settings['store'], value: string) => setSettings({ ...settings, store: { ...store, [key]: key === 'gstin' ? value.toUpperCase() : value } });
  const field = (key: keyof Settings['store'], label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="field"><span>{label}</span><input className="input" value={store[key]} onChange={event => setStore(key, event.target.value)} {...props} />{errors.store?.[key] && <span className="field-error">{errors.store[key]}</span>}</label>
  );
  const status = (ok: boolean, label: string, hint: string) => (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>{ok ? <CheckCircle2 color="var(--green)" size={20} /> : <CircleAlert color="var(--amber)" size={20} />}<div><strong>{label}</strong><p className="field-hint" style={{ margin: 0 }}>{hint}</p></div></div>
  );

  return (
    <>
      <div className="admin-page-head"><div><h1>Settings</h1><p>Store details, payment methods and tax display. {isAdmin ? '' : 'Only administrators can change settings.'}</p></div></div>
      <fieldset disabled={!isAdmin} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="form-layout">
          <div className="admin-form">
            <form className="form-section" onSubmit={save('store')}>
              <h2>Store details <small>Shown on the contact page and invoices. The store name and tagline are fixed.</small></h2>
              <div className="form-grid">
                {field('legal_name', 'Legal business name (invoice)', { maxLength: 120 })}{field('gstin', 'GSTIN', { maxLength: 15, style: { textTransform: 'uppercase' } })}
                {field('support_phone', 'Support phone')}{field('whatsapp', 'WhatsApp number')}
                {field('support_email', 'Support email', { type: 'email' })}{field('state_code', 'GST state code', { maxLength: 2 })}
              </div>
              <label className="field"><span>Store address</span><textarea className="textarea" value={store.address} maxLength={300} onChange={event => setStore('address', event.target.value)} /></label>
              <div className="form-grid three">{field('instagram_url', 'Instagram URL')}{field('facebook_url', 'Facebook URL')}{field('youtube_url', 'YouTube URL')}</div>
              {errors.store?._ && <p className="alert alert-danger">{errors.store._}</p>}
              {isAdmin && <div><button type="submit" className="btn btn-primary btn-sm" disabled={busy === 'store'}>Save store details</button></div>}
            </form>
            <form className="form-section" onSubmit={save('payments')}>
              <h2>Payment methods</h2>
              <div className="form-grid">
                {(['upi', 'card', 'net_banking', 'wallet', 'cod'] as const).map(key => (
                  <label key={key} className="switch"><input type="checkbox" checked={settings.payments[key]} onChange={event => setSettings({ ...settings, payments: { ...settings.payments, [key]: event.target.checked } })} />
                    {{ upi: 'UPI', card: 'Credit / debit cards', net_banking: 'Net banking', wallet: 'Wallets', cod: 'Cash on Delivery' }[key]}</label>
                ))}
              </div>
              <label className="field" style={{ maxWidth: 260 }}><span>COD limit per order (₹, 0 = no limit)</span><input className="input" inputMode="numeric" value={settings.payments.cod_limit_paise / 100} onChange={event => setSettings({ ...settings, payments: { ...settings.payments, cod_limit_paise: Math.round(Number(event.target.value.replace(/[^\d.]/g, '') || 0) * 100) } })} /></label>
              <p className="field-hint" style={{ margin: 0 }}>Online methods are offered only when the payment gateway is configured. Per-zone COD rules are in Delivery Settings.</p>
              {isAdmin && <div><button type="submit" className="btn btn-primary btn-sm" disabled={busy === 'payments'}>Save payment methods</button></div>}
            </form>
            <form className="form-section" onSubmit={save('tax')}>
              <h2>Tax</h2>
              <label className="switch"><input type="checkbox" checked={settings.tax.show_breakup_on_invoice} onChange={event => setSettings({ ...settings, tax: { show_breakup_on_invoice: event.target.checked } })} /> Show CGST / SGST / IGST breakup on invoices</label>
              <p className="field-hint" style={{ margin: 0 }}>GST rates (0%, 5%, 12%, 18%, 28%) and HSN codes are set per product. Prices are GST-inclusive.</p>
              {isAdmin && <div><button type="submit" className="btn btn-primary btn-sm" disabled={busy === 'tax'}>Save tax settings</button></div>}
            </form>
          </div>
          <div className="sticky-actions">
            {integrations && (
              <section className="form-section">
                <h2>Integrations</h2>
                {status(integrations.online_payments_available, 'Online payments (Razorpay)', integrations.razorpay_configured ? (integrations.online_payments_available ? 'Live' : 'Credentials present — enable ONLINE_PAYMENTS_ENABLED after sandbox sign-off') : 'Awaiting Razorpay test credentials')}
                {status(integrations.sms_configured, 'SMS OTP gateway', integrations.sms_configured ? 'Configured' : 'Awaiting SMS provider credentials')}
                {status(integrations.google_sign_in_configured, 'Google sign-in', integrations.google_sign_in_configured ? 'Configured' : 'Awaiting Google OAuth client ID')}
              </section>
            )}
            {isAdmin && <StaffManager />}
          </div>
        </div>
      </fieldset>
    </>
  );
}
