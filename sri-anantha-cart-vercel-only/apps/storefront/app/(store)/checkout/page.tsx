'use client';

import { type Address, type DeliverySelection, type PaymentMethod, type Quote } from '@sac/contracts';
import { ApiRequestError, newIdempotencyKey } from '@sac/api-client';
import { formatAddressLine, formatDate, formatPhone, formatRupees, PAYMENT_METHOD_LABELS } from '@sac/shared';
import { ArrowRight, Check, Clock, Lock, Plus, Truck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AddressModal } from '@/components/store/AddressModal';
import { Breadcrumbs } from '@/components/store/Breadcrumbs';
import { OrderSummary } from '@/components/store/OrderSummary';
import { errorMessage, useStore } from '@/components/store/StoreProvider';
import { api } from '@/lib/api';

type Step = 1 | 2 | 3;
const METHODS: PaymentMethod[] = ['upi', 'card', 'net_banking', 'cod'];

function Stepper({ step }: { step: Step }) {
  const labels = ['Address', 'Payment', 'Review'];
  return (
    <ol className="stepper" aria-label="Checkout progress" style={{ listStyle: 'none', padding: 0 }}>
      {labels.map((label, index) => {
        const number = (index + 1) as Step;
        const state = number < step ? 'done' : number === step ? 'active' : '';
        return (
          <li key={label} className={`step ${state}`} aria-current={number === step ? 'step' : undefined}>
            <span className="num">{number < step ? <Check size={18} /> : number}</span>{label}
          </li>
        );
      })}
    </ol>
  );
}

type RazorpayCheckoutResponse = { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string };
type RazorpayOptions = {
  key: string; order_id: string; amount: number; currency: string; name: string; description: string;
  prefill?: { name?: string; email?: string; contact?: string };
  handler: (response: RazorpayCheckoutResponse) => void | Promise<void>;
  modal?: { ondismiss?: () => void };
};
declare global { interface Window { Razorpay?: new (options: RazorpayOptions) => { open: () => void } } }

async function loadRazorpayCheckout(): Promise<void> {
  if (window.Razorpay) return;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-razorpay-checkout]');
    if (existing) { existing.addEventListener('load', () => resolve(), { once: true }); existing.addEventListener('error', () => reject(new Error('Payment checkout could not be loaded')), { once: true }); return; }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true; script.dataset.razorpayCheckout = 'true';
    script.onload = () => resolve(); script.onerror = () => reject(new Error('Payment checkout could not be loaded'));
    document.body.appendChild(script);
  });
  if (!window.Razorpay) throw new Error('Payment checkout is unavailable');
}

export default function CheckoutPage() {
  const router = useRouter();
  const { user, ready, refreshCart, toast } = useStore();
  const [step, setStep] = useState<Step>(1);
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [delivery, setDelivery] = useState<DeliverySelection | null>(null);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [email, setEmail] = useState('');
  const [editing, setEditing] = useState<Address | 'new' | null>(null);
  const [error, setError] = useState('');
  const [placing, setPlacing] = useState(false);
  const attemptKey = useRef<string | null>(null);

  useEffect(() => { if (ready && !user) router.replace('/login?next=/checkout'); }, [ready, user, router]);
  useEffect(() => { if (user?.email) setEmail(user.email); }, [user]);

  const loadQuote = useCallback(async (id: string | null) => {
    try {
      const next = await api.cart(id ?? undefined);
      setQuote(next);
      if (next.lines.length === 0) router.replace('/cart');
      return next;
    } catch (err) { setError(errorMessage(err)); return null; }
  }, [router]);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      const list = await api.addresses().catch(() => []);
      setAddresses(list);
      const preferred = list.find(item => item.is_default) ?? list[0];
      setAddressId(preferred?.id ?? null);
      await loadQuote(preferred?.id ?? null);
    })();
  }, [user, loadQuote]);

  // Any change to the order details invalidates the previous checkout attempt key.
  useEffect(() => { attemptKey.current = null; }, [addressId, delivery, method]);

  useEffect(() => {
    if (!quote) return;
    if (delivery?.mode === 'express' && !quote.delivery.express.available) setDelivery(null);
    if (!delivery) {
      if (quote.delivery.express.available) setDelivery({ mode: 'express' });
      else if (quote.delivery.scheduled[0]) setDelivery({ mode: 'scheduled', slot_id: quote.delivery.scheduled[0].slot_id, date: quote.delivery.scheduled[0].date });
    }
    if (!method || !quote.payment_methods[method].available) {
      const firstAvailable = METHODS.find(item => quote.payment_methods[item].available);
      setMethod(firstAvailable ?? null);
    }
  }, [quote, delivery, method]);

  const chooseAddress = async (id: string) => { setAddressId(id); setDelivery(null); setError(''); await loadQuote(id); };
  const selectedAddress = addresses?.find(item => item.id === addressId) ?? null;
  const slotsByDate = useMemo(() => {
    const groups = new Map<string, NonNullable<Quote>['delivery']['scheduled']>();
    for (const option of quote?.delivery.scheduled ?? []) groups.set(option.date, [...(groups.get(option.date) ?? []), option]);
    return [...groups.entries()];
  }, [quote]);

  const deliveryProblem = quote?.problems.find(problem => ['DELIVERY_UNAVAILABLE', 'MINIMUM_ORDER_NOT_MET', 'NO_DELIVERY_SLOTS', 'CART_HAS_UNAVAILABLE_ITEMS'].includes(problem));
  const problemText: Record<string, string> = {
    DELIVERY_UNAVAILABLE: 'We do not deliver to this PIN code yet. Please choose another address.',
    MINIMUM_ORDER_NOT_MET: `The minimum order for this area is ${formatRupees(quote?.zone?.minimum_order_paise ?? 0)}.`,
    NO_DELIVERY_SLOTS: 'No delivery slots are available right now. Please check back later.',
    CART_HAS_UNAVAILABLE_ITEMS: 'Some cart items are unavailable. Please review your cart.',
  };
  const canContinueAddress = Boolean(selectedAddress && delivery && quote && !deliveryProblem);
  const onlineSelected = method !== null && method !== 'cod';
  const emailValid = !onlineSelected || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const placeOrder = async () => {
    if (!quote || !selectedAddress || !delivery || !method) return;
    setPlacing(true); setError('');
    attemptKey.current ??= newIdempotencyKey();
    try {
      const result = await api.checkout({
        address_id: selectedAddress.id, delivery, payment_method: method, expected_total_paise: quote.total_paise,
        ...(onlineSelected ? { email: email.trim() } : {}),
      }, attemptKey.current);
      if (result.checkout) {
        await loadRazorpayCheckout();
        if (!window.Razorpay) throw new Error('Payment checkout is unavailable');
        const checkout = result.checkout;
        const modal = new window.Razorpay({
          key: checkout.key_id, order_id: checkout.razorpay_order_id, amount: checkout.amount, currency: checkout.currency,
          name: checkout.name, description: checkout.description, prefill: checkout.prefill,
          handler: async response => {
            try {
              await api.verifyRazorpayPayment({ order_id: result.order_id, razorpay_payment_id: response.razorpay_payment_id, razorpay_signature: response.razorpay_signature });
              await refreshCart(); router.replace(`/orders/${result.order_id}/confirmation`);
            } catch (verificationError) { setError(errorMessage(verificationError, 'Payment confirmation is pending. Do not pay again; contact support if the order does not update.')); setPlacing(false); }
          },
          modal: { ondismiss: () => setPlacing(false) },
        });
        modal.open();
        return;
      }
      await refreshCart();
      router.replace(`/orders/${result.order_id}/confirmation`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.body.quote) {
        setQuote(err.body.quote as Quote);
        attemptKey.current = null;
      }
      setError(errorMessage(err, 'We could not place your order. Nothing was charged. Please try again.'));
      setPlacing(false);
    }
  };

  if (!ready || !user || !quote || addresses === null) {
    return <div className="container" style={{ padding: '40px 24px' }}><div className="skeleton" style={{ height: 420 }} /></div>;
  }

  const deliveryLabel = delivery?.mode === 'express'
    ? `Deliver Now · ${quote.delivery.express.estimated_minutes ?? 30} minutes`
    : quote.delivery.scheduled.find(item => delivery && item.slot_id === delivery.slot_id && item.date === delivery.date)?.label ?? '';
  const deliveryDate = delivery?.mode === 'scheduled' ? delivery.date : null;

  return (
    <div className="container">
      <Breadcrumbs items={[{ label: 'Cart', href: '/cart' }, { label: 'Checkout', href: '/checkout' }, { label: ['Address', 'Payment', 'Review'][step - 1]! }]} />
      <Stepper step={step} />
      <div className="checkout-grid">
        <div>
          {error && <div className="alert alert-danger" role="alert" style={{ marginBottom: 14 }}>{error}</div>}

          {step === 1 && (
            <>
              <div className="panel-title">
                <h2>Delivery Address</h2>
                <button type="button" className="link-red" style={{ background: 'none', border: 0, textDecoration: 'underline' }} onClick={() => setEditing('new')}>Add New Address</button>
              </div>
              {addresses.length === 0 ? (
                <button type="button" className="option" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setEditing('new')}><Plus size={20} /> Add a delivery address</button>
              ) : (
                <div className="option-list" role="radiogroup" aria-label="Delivery address">
                  {addresses.map(address => (
                    <label key={address.id} className={`option${address.id === addressId ? ' selected' : ''}`}>
                      <input type="radio" name="address" checked={address.id === addressId} onChange={() => void chooseAddress(address.id)} />
                      <div className="option-body">
                        <strong>{address.recipient_name}{address.label ? <span className="badge badge-neutral" style={{ marginLeft: 8 }}>{address.label}</span> : null}</strong>
                        <p>{formatAddressLine(address)}</p>
                        <p>{formatPhone(address.phone_e164)}</p>
                      </div>
                      <div className="option-actions">
                        <button type="button" onClick={event => { event.preventDefault(); setEditing(address); }}>Edit</button>
                        <span className="sep">|</span>
                        <button type="button" onClick={async event => {
                          event.preventDefault();
                          if (!window.confirm('Delete this address?')) return;
                          try {
                            await api.deleteAddress(address.id);
                            const list = await api.addresses();
                            setAddresses(list);
                            const fallback = list.find(item => item.is_default) ?? list[0];
                            await chooseAddress(fallback?.id ?? '');
                          } catch (err) { toast(errorMessage(err), 'error'); }
                        }}>Delete</button>
                      </div>
                    </label>
                  ))}
                </div>
              )}

              {selectedAddress && (
                <>
                  <div className="panel-title" style={{ marginTop: 26 }}><h2>Delivery Option</h2></div>
                  {deliveryProblem ? <div className="alert alert-warning" role="alert">{problemText[deliveryProblem]}</div> : (
                    <div className="option-list" role="radiogroup" aria-label="Delivery option">
                      <label className={`option${delivery?.mode === 'express' ? ' selected' : ''}${quote.delivery.express.available ? '' : ' disabled'}`}>
                        <input type="radio" name="delivery" disabled={!quote.delivery.express.available} checked={delivery?.mode === 'express'} onChange={() => setDelivery({ mode: 'express' })} />
                        <Truck size={30} color="var(--red)" style={{ flex: 'none' }} />
                        <div className="option-body">
                          <strong>{quote.delivery.express.estimated_minutes ? `15-${quote.delivery.express.estimated_minutes} Minutes Delivery` : '15-30 Minutes Delivery'}</strong>
                          <p>{quote.delivery.express.available ? 'Deliver Now — fastest delivery to your doorstep' : quote.delivery.express.reason}</p>
                        </div>
                        <span className="option-meta">{quote.delivery_fee_paise === 0 ? <span className="off">FREE</span> : formatRupees(quote.delivery_fee_paise)}</span>
                      </label>
                      {slotsByDate.length > 0 && (
                        <div className={`option${delivery?.mode === 'scheduled' ? ' selected' : ''}`} style={{ display: 'block', cursor: 'default' }}>
                          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                            <Clock size={28} color="var(--red)" />
                            <div className="option-body"><strong>Scheduled Delivery</strong><p>Choose a convenient time slot</p></div>
                            <span className="option-meta">{quote.delivery_fee_paise === 0 ? <span className="off">FREE</span> : formatRupees(quote.delivery_fee_paise)}</span>
                          </div>
                          {slotsByDate.map(([date, options]) => (
                            <div key={date} style={{ marginTop: 12 }}>
                              <strong style={{ fontSize: 13.5 }}>{formatDate(`${date}T12:00:00+05:30`)}</strong>
                              <div className="slot-grid">
                                {options.map(option => (
                                  <button key={`${option.slot_id}-${date}`} type="button" className="slot"
                                    aria-pressed={delivery?.mode === 'scheduled' && delivery.slot_id === option.slot_id && delivery.date === date}
                                    onClick={() => setDelivery({ mode: 'scheduled', slot_id: option.slot_id, date })}>
                                    {option.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <div className="panel-title"><h2>Select Payment Method</h2></div>
              {!METHODS.some(item => item !== 'cod' && quote.payment_methods[item].available) && (
                <div className="alert alert-info" style={{ marginBottom: 12 }}>Online payments are being set up. Cash on Delivery is available for your order.</div>
              )}
              <div className="option-list" role="radiogroup" aria-label="Payment method">
                {METHODS.map(item => {
                  const availability = quote.payment_methods[item];
                  return (
                    <label key={item} className={`option${method === item ? ' selected' : ''}${availability.available ? '' : ' disabled'}`}>
                      <input type="radio" name="payment" disabled={!availability.available} checked={method === item} onChange={() => setMethod(item)} />
                      <div className="option-body">
                        <strong>{item === 'upi' ? 'UPI (Google Pay, PhonePe, Paytm)' : item === 'card' ? 'Credit / Debit Card' : item === 'cod' ? 'Cash on Delivery (COD)' : PAYMENT_METHOD_LABELS[item]}</strong>
                        {item === 'upi' && <div className="pay-logos" aria-hidden="true"><span style={{ color: '#5f259f' }}>UPI</span><span style={{ color: '#1a73e8' }}>GPay</span><span style={{ color: '#5f259f' }}>PhonePe</span><span style={{ color: '#00baf2' }}>Paytm</span></div>}
                        {!availability.available && availability.reason && <p>{availability.reason}</p>}
                        {item === 'cod' && availability.available && <p>Pay in cash when your order arrives.</p>}
                      </div>
                      {item === 'card' && <div className="pay-logos" aria-hidden="true" style={{ marginTop: 0 }}><span style={{ color: '#1a1f71' }}>VISA</span><span style={{ color: '#eb001b' }}>●</span><span style={{ color: '#1a1f71' }}>RuPay</span></div>}
                    </label>
                  );
                })}
              </div>
              {onlineSelected && (
                <label className="field" style={{ marginTop: 16 }}>
                  <span>Email for payment receipt</span>
                  <input className="input" type="email" value={email} onChange={event => setEmail(event.target.value)} maxLength={254} />
                  {!emailValid && <span className="field-error">Enter a valid email address</span>}
                </label>
              )}
            </>
          )}

          {step === 3 && selectedAddress && (
            <div style={{ display: 'grid', gap: 14 }}>
              <div className="panel-title"><h2>Review Your Order</h2></div>
              <div className="box">
                <div className="panel-title" style={{ marginBottom: 6 }}><h2 style={{ fontSize: 16 }}>Delivering to</h2><button type="button" className="link-red" style={{ background: 'none', border: 0 }} onClick={() => setStep(1)}>Change</button></div>
                <p style={{ margin: 0 }}><strong>{selectedAddress.recipient_name}</strong> · {formatPhone(selectedAddress.phone_e164)}</p>
                <p className="muted" style={{ margin: '4px 0 0' }}>{formatAddressLine(selectedAddress)}</p>
              </div>
              <div className="box">
                <div className="panel-title" style={{ marginBottom: 6 }}><h2 style={{ fontSize: 16 }}>Delivery</h2><button type="button" className="link-red" style={{ background: 'none', border: 0 }} onClick={() => setStep(1)}>Change</button></div>
                <p style={{ margin: 0 }}>{deliveryDate ? `${formatDate(`${deliveryDate}T12:00:00+05:30`)} · ` : ''}{deliveryLabel}</p>
              </div>
              <div className="box">
                <div className="panel-title" style={{ marginBottom: 6 }}><h2 style={{ fontSize: 16 }}>Payment</h2><button type="button" className="link-red" style={{ background: 'none', border: 0 }} onClick={() => setStep(2)}>Change</button></div>
                <p style={{ margin: 0 }}>{method ? PAYMENT_METHOD_LABELS[method] : ''}</p>
              </div>
            </div>
          )}
        </div>

        <OrderSummary quote={quote} showBreakdown={step === 1}>
          {step === 1 && <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!canContinueAddress} onClick={() => { setError(''); setStep(2); }}>Continue to Payment <ArrowRight size={18} /></button>}
          {step === 2 && <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!method || !emailValid} onClick={() => { setError(''); setStep(3); }}>Continue <ArrowRight size={18} /></button>}
          {step === 3 && (
            <button type="button" className="btn btn-primary btn-lg btn-block" disabled={placing || !method} onClick={() => void placeOrder()}>
              {placing ? <span className="spinner" /> : method === 'cod' ? <>Place Order · {formatRupees(quote.total_paise)} <ArrowRight size={18} /></> : <>Pay {formatRupees(quote.total_paise)} <ArrowRight size={18} /></>}
            </button>
          )}
          {step > 1 && <button type="button" className="btn btn-ghost btn-block" onClick={() => setStep((step - 1) as Step)} disabled={placing}>Back</button>}
        </OrderSummary>
      </div>
      {step >= 2 && <p className="secure-note"><Lock size={16} /> Secure and encrypted payments. Your data is safe with us.</p>}
      <div style={{ height: 40 }} />
      {editing && (
        <AddressModal address={editing === 'new' ? null : editing} defaultPhone={user.phone} onClose={() => setEditing(null)}
          onSaved={async saved => {
            setEditing(null);
            const list = await api.addresses();
            setAddresses(list);
            await chooseAddress(saved.id);
          }} />
      )}
    </div>
  );
}
