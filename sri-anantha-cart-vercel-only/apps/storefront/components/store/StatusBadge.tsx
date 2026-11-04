import { type OrderStatus } from '@sac/contracts';
import { CUSTOMER_STATUS_LABELS, ORDER_STATUS_LABELS, ORDER_STATUS_TONES } from '@sac/shared';

export function StatusBadge({ status, audience = 'customer' }: { status: OrderStatus; audience?: 'customer' | 'staff' }) {
  const label = audience === 'customer' ? CUSTOMER_STATUS_LABELS[status] : ORDER_STATUS_LABELS[status];
  return <span className={`badge badge-${ORDER_STATUS_TONES[status]}`}>{label}</span>;
}
