export type RefundOrderContext = {
  currentStatus: string;
  cancellationReason: string | null;
  returnReason: string | null;
  orderTotalPaise: number;
  completedRefundPaise: number;
  pendingRefundPaise: number;
};

export type RefundOrderState = {
  paymentStatus: 'paid' | 'refund_pending' | 'refunded';
  orderStatus: string;
  fullyRefunded: boolean;
  hasPendingRefund: boolean;
  completedRefundPaise: number;
  totalRefundExposurePaise: number;
};

/** Derives order/payment state from persisted refund totals after the current refund update. */
export function deriveRefundOrderState(context: RefundOrderContext): RefundOrderState {
  const completed = Math.max(0, Math.trunc(context.completedRefundPaise));
  const pending = Math.max(0, Math.trunc(context.pendingRefundPaise));
  const total = Math.max(0, Math.trunc(context.orderTotalPaise));
  const hasPendingRefund = pending > 0;
  const fullyRefunded = total > 0 && completed >= total && !hasPendingRefund;

  let orderStatus = context.currentStatus;
  if (fullyRefunded) orderStatus = 'refunded';
  else if (hasPendingRefund) orderStatus = 'refund_initiated';
  else if (context.cancellationReason) orderStatus = 'cancelled';
  else if (context.returnReason) orderStatus = 'delivered';

  return {
    paymentStatus: fullyRefunded ? 'refunded' : hasPendingRefund ? 'refund_pending' : 'paid',
    orderStatus,
    fullyRefunded,
    hasPendingRefund,
    completedRefundPaise: completed,
    totalRefundExposurePaise: completed + pending,
  };
}
