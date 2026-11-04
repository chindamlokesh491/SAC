import { type OrderDetail } from '@sac/contracts';
import { formatTime, trackingSteps } from '@sac/shared';
import { Check } from 'lucide-react';

export function Tracker({ order }: { order: Pick<OrderDetail, 'status' | 'timeline' | 'estimated_delivery_at'> }) {
  if (order.status === 'cancelled') return <div className="alert alert-danger" style={{ margin: '18px 0' }}>This order was cancelled.</div>;
  const steps = trackingSteps(order.status, order.timeline, order.estimated_delivery_at);
  return (
    <ol className="tracker" style={{ listStyle: 'none', padding: 0 }} aria-label="Order progress">
      {steps.map(step => (
        <li key={step.key} className={`tracker-step ${step.state}`} aria-current={step.state === 'current' ? 'step' : undefined}>
          <span className="dot">{step.state === 'done' ? <Check size={16} strokeWidth={3} /> : step.state === 'current' ? <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--green)' }} /> : <Check size={14} />}</span>
          <strong>{step.label}</strong>
          <small>{step.at ? formatTime(step.at) : step.expected ? `Expected ${formatTime(step.expected)}` : ''}</small>
        </li>
      ))}
    </ol>
  );
}
