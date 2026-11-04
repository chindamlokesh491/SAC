'use client';

import { type QuoteLine } from '@sac/contracts';
import { formatRupees } from '@sac/shared';
import { ArrowRight, ShoppingCart, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Breadcrumbs } from '@/components/store/Breadcrumbs';
import { QuantityStepper } from '@/components/store/ProductPurchase';
import { Modal } from '@sac/ui-web';
import { useStore } from '@/components/store/StoreProvider';

const ISSUE_TEXT: Record<NonNullable<QuoteLine['issue']>, string> = {
  unavailable: 'This item is no longer available — please remove it.',
  insufficient_stock: 'Not enough stock for this quantity.',
  choose_variant: 'Please choose a pack size on the product page.',
};

export default function CartPage() {
  const router = useRouter();
  const { user, ready, cart, setQuantity, clearCart, refreshCart, toast } = useStore();
  const [pending, setPending] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => { if (ready) void refreshCart(); }, [ready, refreshCart]);

  const update = async (line: QuoteLine, quantity: number) => {
    setPending(line.cart_item_id);
    await setQuantity(line.product_id, line.variant_id, quantity);
    setPending(null);
  };
  const remove = async (line: QuoteLine) => {
    setPending(line.cart_item_id);
    if (await setQuantity(line.product_id, line.variant_id, 0)) toast('Removed from cart');
    setPending(null);
  };
  // Browsing and the cart work without an account; signing in is needed only to place the order.
  const checkout = () => {
    if (user) { router.push('/checkout'); return; }
    toast('Sign in to place your order. Your cart is kept.', 'info');
    router.push('/login?next=/checkout');
  };

  if (!ready || !cart) {
    return <div className="container" style={{ padding: '40px 24px' }}><div className="skeleton" style={{ height: 320 }} /></div>;
  }
  const hasIssues = cart.lines.some(line => !line.available);

  return (
    <div className="container">
      <Breadcrumbs items={[{ label: 'Cart' }]} />
      <div className="account-head" style={{ marginTop: 8 }}>
        <h1 className="page-title" style={{ margin: 0 }}>My Cart <small className="muted" style={{ fontSize: 16, fontFamily: 'var(--font-sans)', fontWeight: 500 }}>({cart.item_count} {cart.item_count === 1 ? 'item' : 'items'})</small></h1>
        {cart.lines.length > 0 && <button type="button" className="link-red" style={{ background: 'none', border: 0 }} onClick={() => setConfirmClear(true)}>Clear All</button>}
      </div>
      {cart.lines.length === 0 ? (
        <div className="empty" style={{ marginBottom: 60 }}>
          <ShoppingCart size={48} style={{ margin: '0 auto 10px', color: 'var(--saffron)' }} />
          <h2>Your cart is empty</h2>
          <p>Add pooja essentials to get started.</p>
          <Link href="/categories" className="btn btn-primary">Start Shopping</Link>
        </div>
      ) : (
        <div className="checkout-grid">
          <div style={{ display: 'grid', gap: 14 }}>
            {hasIssues && <div className="alert alert-warning" role="alert">Some items need your attention before checkout.</div>}
            <div className="cart-list">
              {cart.lines.map(line => (
                <div key={line.cart_item_id} className="cart-row" aria-busy={pending === line.cart_item_id}>
                  {line.thumb_url ? <img src={line.thumb_url} alt="" width={84} height={84} /> : <span />}
                  <div className="cart-info">
                    <h3><Link href={`/products/${line.slug}`}>{line.name}</Link></h3>
                    {line.variant_label && <p className="muted" style={{ margin: '2px 0 0', fontSize: 13.5 }}>{line.variant_label}</p>}
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginTop: 5 }}>
                      <strong>{formatRupees(line.unit_price_paise)}</strong>
                      {line.mrp_paise > line.unit_price_paise && <><span className="muted" style={{ textDecoration: 'line-through', fontSize: 12 }}>{formatRupees(line.mrp_paise)}</span><span className="off" style={{ fontSize: 12 }}>Save {formatRupees(line.mrp_paise - line.unit_price_paise)} / item</span></>}
                      <span className="muted" style={{ fontSize: 12 }}>Line total: {formatRupees(line.line_total_paise)}</span>
                    </div>
                    {line.issue && <p className="issue">{ISSUE_TEXT[line.issue]}</p>}
                  </div>
                  <QuantityStepper small value={line.quantity} max={Math.max(line.quantity, line.max_quantity)} onChange={value => void update(line, value)} label={`Quantity of ${line.name}`} />
                  <button type="button" className="icon-btn remove" style={{ color: 'var(--red)' }} onClick={() => void remove(line)} aria-label={`Remove ${line.name}`}><Trash2 size={19} /></button>
                </div>
              ))}
            </div>
          </div>
          <aside className="summary" aria-label="Cart actions">
            <div className="summary-head">Price Details</div>
            <div className="summary-rows">
              <div><span>Item subtotal</span><span>{formatRupees(cart.subtotal_paise)}</span></div>
              {cart.savings_paise > 0 && <div><span>You save</span><span className="off">− {formatRupees(cart.savings_paise)}</span></div>}
              <div><span>Delivery fee</span><span className="muted">Calculated at checkout</span></div>
              {cart.tax_paise > 0 && <div><span className="muted" style={{ fontSize: 13 }}>Includes GST</span><span className="muted" style={{ fontSize: 13 }}>{formatRupees(cart.tax_paise)}</span></div>}
            </div>
            <div className="summary-total"><span>Current total</span><span className="price">{formatRupees(cart.total_paise)}</span></div>
            <div className="summary-foot">
              <button type="button" className="btn btn-primary btn-lg btn-block" disabled={hasIssues} onClick={checkout}>{user ? 'Proceed to Checkout' : 'Sign in to Checkout'} <ArrowRight size={18} /></button>
              {!user && <p className="field-hint" style={{ margin: '8px 0 0', textAlign: 'center' }}>Your cart is saved on this device and moves to your account when you sign in.</p>}
              <p className="summary-note">Final delivery fee and payable amount are confirmed after you select your delivery address. GST is included in item prices.</p>
            </div>
          </aside>
        </div>
      )}
      {confirmClear && (
        <Modal title="Clear cart?" onClose={() => setConfirmClear(false)} footer={<>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirmClear(false)}>Keep items</button>
          <button type="button" className="btn btn-primary" onClick={() => { setConfirmClear(false); void clearCart(); }}>Remove all</button>
        </>}>
          <div className="modal-body"><p style={{ margin: 0 }}>Remove all {cart.item_count} items from your cart?</p></div>
        </Modal>
      )}
    </div>
  );
}
