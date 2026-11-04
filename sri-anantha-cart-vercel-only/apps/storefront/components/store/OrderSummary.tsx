'use client';

import { type Quote } from '@sac/contracts';
import { formatRupees } from '@sac/shared';
import type { ReactNode } from 'react';

export function OrderSummary({ quote, children, deliveryKnown = true, note, showBreakdown = true }: { quote: Quote; children?: ReactNode; deliveryKnown?: boolean; note?: ReactNode; showBreakdown?: boolean }) {
  const lines = quote.lines.filter(line => line.available);
  return (
    <aside className="summary" aria-label="Order summary">
      <div className="summary-head">Order Summary</div>
      <div className="summary-items">
        {lines.map(line => (
          <div key={line.cart_item_id} className="summary-item">
            {line.thumb_url ? <img src={line.thumb_url} alt="" width={48} height={48} /> : <span />}
            <span><strong style={{ fontWeight: 600 }}>{line.name}</strong>{line.variant_label && <small className="muted" style={{ display: 'block' }}>{line.variant_label}</small>}</span>
            <span className="q">x{line.quantity}</span>
            <strong>{formatRupees(line.line_total_paise)}</strong>
          </div>
        ))}
      </div>
      {showBreakdown && <div className="summary-rows">
        <div><span>Item Total</span><span>{formatRupees(quote.subtotal_paise)}</span></div>
        {quote.savings_paise > 0 && <div><span>You save</span><span className="off">− {formatRupees(quote.savings_paise)}</span></div>}
        <div>
          <span>Delivery Fee</span>
          {!deliveryKnown && quote.amount_to_free_delivery_paise > 0
            ? <span className="muted">At checkout</span>
            : quote.delivery_fee_paise === 0 ? <span className="free">FREE</span> : <span>{formatRupees(quote.delivery_fee_paise)}</span>}
        </div>
        {quote.tax_paise > 0 && <div><span className="muted" style={{ fontSize: 13 }}>Includes GST</span><span className="muted" style={{ fontSize: 13 }}>{formatRupees(quote.tax_paise)}</span></div>}
      </div>}
      <div className="summary-total"><span>Total</span><span className="price">{formatRupees(quote.total_paise)}</span></div>
      <div className="summary-foot">
        {children}
        {note && <p className="summary-note">{note}</p>}
      </div>
    </aside>
  );
}

export function FreeDeliveryProgress({ quote }: { quote: Quote }) {
  if (!quote.free_delivery_threshold_paise || quote.amount_to_free_delivery_paise <= 0 || quote.subtotal_paise === 0) return null;
  const percent = Math.min(100, Math.round((quote.subtotal_paise / quote.free_delivery_threshold_paise) * 100));
  return (
    <div className="free-progress">
      Add <strong>{formatRupees(quote.amount_to_free_delivery_paise)}</strong> more for <strong>FREE delivery</strong>
      <div className="bar"><span style={{ width: `${percent}%` }} /></div>
    </div>
  );
}
