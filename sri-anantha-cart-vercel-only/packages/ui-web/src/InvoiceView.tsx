'use client';

import { type Invoice } from '@sac/contracts';
import { formatDate, formatRupees, PAYMENT_METHOD_LABELS } from '@sac/shared';
import { Printer } from 'lucide-react';

/** Printable GST tax invoice shared by the customer account and the admin panel. */
export function InvoiceView({ invoice }: { invoice: Invoice }) {
  const intra = invoice.supply_type === 'intra_state';
  const buyer = invoice.buyer;
  return (
    <div className="container invoice" style={{ maxWidth: 900, padding: '30px 24px 60px' }}>
      <style>{`@media print { .topbar, .site-header, .site-footer, .assistant-fab, .no-print { display: none !important; } body { background: #fff; } }
        .invoice table { width: 100%; border-collapse: collapse; font-size: 13.5px; } .invoice th, .invoice td { border: 1px solid var(--line); padding: 8px; text-align: left; } .invoice th { background: var(--cream); } .invoice td.n, .invoice th.n { text-align: right; }`}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, marginBottom: 20 }}>
        <div><img src="/brand/logo-full.webp" alt="Sri Anantha Cart" width={214} height={50} /><p style={{ margin: '10px 0 0', fontSize: 13.5 }}><strong>{invoice.seller.name}</strong><br />{invoice.seller.address}{invoice.seller.gstin ? <><br />GSTIN: {invoice.seller.gstin}</> : null}</p></div>
        <div style={{ textAlign: 'right' }}><h1 style={{ fontSize: 24 }}>Tax Invoice</h1><p style={{ margin: '6px 0 0', fontSize: 13.5 }}>Invoice: {invoice.invoice_number}<br />Order: #{invoice.order_number}<br />Date: {formatDate(invoice.issued_at)}</p></div>
      </div>
      <p style={{ fontSize: 13.5 }}><strong>Bill / Ship to:</strong> {buyer.recipient_name}, {[buyer.line1, buyer.line2, buyer.locality, buyer.city, buyer.state, buyer.postal_code].filter(Boolean).join(', ')}</p>
      <table>
        <thead><tr><th>Item</th><th>HSN</th><th className="n">Qty</th><th className="n">Rate</th><th className="n">Taxable</th>{invoice.show_tax_breakup && (intra ? <><th className="n">CGST</th><th className="n">SGST</th></> : <th className="n">IGST</th>)}<th className="n">Amount</th></tr></thead>
        <tbody>
          {invoice.lines.map((line, index) => (
            <tr key={index}>
              <td>{line.name}{line.variant_label ? ` (${line.variant_label})` : ''}<br /><small className="muted">GST {line.gst_rate_basis_points / 100}%</small></td>
              <td>{line.hsn_code ?? '—'}</td><td className="n">{line.quantity}</td><td className="n">{formatRupees(line.unit_price_paise)}</td>
              <td className="n">{formatRupees(line.taxable_value_paise)}</td>
              {invoice.show_tax_breakup && (intra ? <><td className="n">{formatRupees(line.cgst_paise)}</td><td className="n">{formatRupees(line.sgst_paise)}</td></> : <td className="n">{formatRupees(line.igst_paise)}</td>)}
              <td className="n">{formatRupees(line.line_total_paise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginLeft: 'auto', maxWidth: 320, marginTop: 14 }}>
        <div className="kv"><span>Items (incl. GST)</span><span>{formatRupees(invoice.totals.items_paise)}</span></div>
        <div className="kv"><span>GST included</span><span>{formatRupees(invoice.totals.tax_included_paise)}</span></div>
        <div className="kv"><span>Delivery</span><span>{formatRupees(invoice.totals.delivery_fee_paise)}</span></div>
        <div className="kv total"><span>Total</span><span>{formatRupees(invoice.totals.total_paise)}</span></div>
        <div className="kv"><span>Payment</span><span>{invoice.payment_method ? PAYMENT_METHOD_LABELS[invoice.payment_method] : '—'}</span></div>
      </div>
      <button type="button" className="btn btn-primary no-print" style={{ marginTop: 20 }} onClick={() => window.print()}><Printer size={18} /> Print / Save PDF</button>
    </div>
  );
}
