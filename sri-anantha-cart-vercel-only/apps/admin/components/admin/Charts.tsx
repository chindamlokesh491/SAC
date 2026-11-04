import Link from 'next/link';
import { formatRupees } from '@sac/shared';

/** Bar (sales) + line (orders) combo chart, dependency-free SVG. */
export function SalesOrdersChart({ data, hrefFor }: { data: { day: string; sales_paise: number; orders: number }[]; hrefFor?: (day: string) => string }) {
  const width = data.length > 10 ? 1100 : 640; const height = 230; const left = 52; const right = 40; const top = 14; const bottom = 30;
  const plotW = width - left - right; const plotH = height - top - bottom;
  const maxSales = Math.max(100_00, ...data.map(item => item.sales_paise));
  const salesStep = niceStep(maxSales / 4);
  const salesMax = salesStep * 4;
  const maxOrders = Math.max(4, ...data.map(item => item.orders));
  const ordersStep = Math.max(1, Math.ceil(maxOrders / 3));
  const ordersMax = ordersStep * 3;
  const band = plotW / Math.max(1, data.length);
  const x = (index: number) => left + band * index + band / 2;
  const ySales = (value: number) => top + plotH - (value / salesMax) * plotH;
  const yOrders = (value: number) => top + plotH - (value / ordersMax) * plotH;
  const label = (iso: string) => new Date(`${String(iso).slice(0, 10)}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const points = data.map((item, index) => `${x(index)},${yOrders(item.orders)}`).join(' ');
  return (
    <div className="chart">
      <div className="chart-legend"><span><i style={{ background: '#fbe0cc' }} />Sales (₹)</span><span><i style={{ background: '#8f0a05', height: 3 }} />Orders</span></div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Sales and orders for the last 7 days">
        {[0, 1, 2, 3, 4].map(step => (
          <g key={step}>
            <line x1={left} x2={width - right} y1={ySales(salesStep * step)} y2={ySales(salesStep * step)} stroke="#efe6dc" />
            <text x={left - 8} y={ySales(salesStep * step) + 4} textAnchor="end">{step === 0 ? '0' : `₹ ${compact(salesStep * step / 100)}`}</text>
          </g>
        ))}
        {[0, 1, 2, 3].map(step => <text key={step} x={width - right + 8} y={yOrders(ordersStep * step) + 4}>{ordersStep * step}</text>)}
        {data.map((item, index) => (
          <g key={item.day}>
            <rect x={x(index) - band * 0.26} y={ySales(item.sales_paise)} width={band * 0.52} height={Math.max(0, top + plotH - ySales(item.sales_paise))} rx="4" fill="#fbe0cc">
              <title>{`${label(item.day)}: ${formatRupees(item.sales_paise)} · ${item.orders} orders`}</title>
            </rect>
            {index % Math.max(1, Math.ceil(data.length / 10)) === 0 && <text x={x(index)} y={height - 8} textAnchor="middle">{label(item.day)}</text>}
          </g>
        ))}
        <polyline points={points} fill="none" stroke="#8f0a05" strokeWidth="2" />
        {data.length <= 14 && data.map((item, index) => <circle key={item.day} cx={x(index)} cy={yOrders(item.orders)} r="4.5" fill="#8f0a05" />)}
        {hrefFor && data.map((item, index) => (
          <a key={`link-${item.day}`} href={hrefFor(String(item.day).slice(0, 10))} className="chart-hit" aria-label={`${label(item.day)}: ${formatRupees(item.sales_paise)}, ${item.orders} orders. Open report`}>
            <rect x={x(index) - band / 2} y={top} width={band} height={plotH} fill="transparent" />
          </a>
        ))}
      </svg>
    </div>
  );
}

function niceStep(raw: number) {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const normalized = raw / magnitude;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
}
function compact(rupees: number) { return rupees >= 1000 ? `${(rupees / 1000).toFixed(rupees % 1000 ? 1 : 0)}K` : String(Math.round(rupees)); }

export const STATUS_COLORS: Record<string, string> = { pending: '#f6b800', accepted: '#1f6fd1', packed: '#7b3fd0', out_for_delivery: '#19c79a', delivered: '#1e9e4a', cancelled: '#e53935' };
export const STATUS_NAMES: Record<string, string> = { pending: 'Pending', accepted: 'Accepted', packed: 'Packed', out_for_delivery: 'Out for Delivery', delivered: 'Delivered', cancelled: 'Cancelled' };

export function StatusDonut({ data, hrefFor }: { data: { status: string; count: number }[]; hrefFor?: (status: string) => string }) {
  const total = data.reduce((sum, item) => sum + item.count, 0);
  const radius = 70; const stroke = 26; const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 200 200" width="200" height="200" role="img" aria-label={`${total} orders by status`}>
        <circle cx="100" cy="100" r={radius} fill="none" stroke="#f1ede8" strokeWidth={stroke} />
        {total > 0 && data.filter(item => item.count > 0).map(item => {
          const length = (item.count / total) * circumference;
          const circle = <circle cx="100" cy="100" r={radius} fill="none" stroke={STATUS_COLORS[item.status]} strokeWidth={stroke}
            strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-offset} transform="rotate(-90 100 100)" />;
          const segment = hrefFor
            ? <a key={item.status} href={hrefFor(item.status)} className="donut-segment" aria-label={`${STATUS_NAMES[item.status]}: ${item.count} orders`}>{circle}</a>
            : <g key={item.status}>{circle}</g>;
          offset += length;
          return segment;
        })}
        <text x="100" y="98" textAnchor="middle" style={{ fontFamily: 'var(--font-serif)', fontSize: 26, fontWeight: 700, fill: '#1d1714' }}>{total}</text>
        <text x="100" y="120" textAnchor="middle" style={{ fontSize: 12.5, fill: '#6f655d' }}>Total Orders</text>
      </svg>
      <div className="donut-legend">
        {data.map(item => {
          const row = <><i style={{ background: STATUS_COLORS[item.status] }} /><span>{STATUS_NAMES[item.status]}</span><strong>{item.count}</strong>
            <span>({total ? ((item.count / total) * 100).toFixed(1) : '0.0'}%)</span></>;
          return hrefFor ? <Link key={item.status} href={hrefFor(item.status)} className="legend-link">{row}</Link> : <div key={item.status}>{row}</div>;
        })}
      </div>
    </div>
  );
}
