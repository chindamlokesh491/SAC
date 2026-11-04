'use client';

import { type OrderStatus } from '@sac/contracts';
import { ORDER_STATUS_LABELS, ORDER_STATUS_TONES } from '@sac/shared';
import { ArrowDown, ArrowUp } from 'lucide-react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';

export function Kpi({ icon: Icon, tone, label, value, previous, note, href, format = v => v.toLocaleString('en-IN') }: {
  icon: LucideIcon; tone: string; label: string; value: number; previous?: number | null; note?: string; href?: string; format?: (value: number) => string;
}) {
  let delta: null | { up: boolean; text: string } = null;
  if (previous !== null && previous !== undefined) {
    if (previous === 0) delta = value > 0 ? { up: true, text: 'new' } : null;
    else { const change = ((value - previous) / previous) * 100; delta = { up: change >= 0, text: `${Math.abs(change).toFixed(0)}%` }; }
  }
  const content = (
    <>
      <span className={`kpi-icon ${tone}`}><Icon size={26} strokeWidth={1.9} /></span>
      <div className="kpi-body">
        <div className="kpi-label">{label}</div>
        <div className="kpi-value">{format(value)}</div>
        {delta ? (
          <span className={`kpi-delta ${delta.up ? 'up' : 'down'}`}>{delta.up ? <ArrowUp size={14} /> : <ArrowDown size={14} />}{delta.text}<small>vs yesterday</small></span>
        ) : note ? <span className="kpi-note">{note}</span> : null}
      </div>
    </>
  );
  return href ? <Link href={href} className="kpi kpi-link" aria-label={`${label}: ${format(value)}. Open details`}>{content}</Link> : <div className="kpi">{content}</div>;
}

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`badge badge-${ORDER_STATUS_TONES[status]}`}>{ORDER_STATUS_LABELS[status]}</span>;
}

export function Pager({ offset, limit, total, onChange }: { offset: number; limit: number; total: number; onChange: (offset: number) => void }) {
  if (total <= limit) return total > 0 ? <div className="pager"><span>{total} {total === 1 ? 'record' : 'records'}</span></div> : null;
  return (
    <div className="pager">
      <span>Showing {offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
      <div className="pager-buttons">
        <button type="button" className="btn btn-ghost btn-sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Previous</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next</button>
      </div>
    </div>
  );
}

export function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return <tr><td colSpan={colSpan} style={{ textAlign: 'center', padding: 30, color: 'var(--muted)' }}>{text}</td></tr>;
}

export function LoadingRows({ colSpan, rows = 5 }: { colSpan: number; rows?: number }) {
  return <>{Array.from({ length: rows }, (_, index) => <tr key={index}><td colSpan={colSpan}><div className="skeleton" style={{ height: 22 }} /></td></tr>)}</>;
}
