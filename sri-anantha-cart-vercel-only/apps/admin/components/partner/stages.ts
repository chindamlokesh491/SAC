import type { DeliveryStage } from '@sac/contracts';

export const STAGE_LABEL: Record<DeliveryStage, string> = {
  awaiting_acceptance: 'Waiting for you to accept',
  awaiting_pickup: 'Pick up from store',
  out_for_delivery: 'Out for delivery',
  awaiting_cod: 'Collect cash',
  delivered: 'Delivered',
};

export const STAGE_BADGE: Record<DeliveryStage, string> = {
  awaiting_acceptance: 'badge-warning', awaiting_pickup: 'badge-info', out_for_delivery: 'badge-purple', awaiting_cod: 'badge-danger', delivered: 'badge-success',
};

export const STAGE_ORDER: DeliveryStage[] = ['awaiting_acceptance', 'awaiting_pickup', 'out_for_delivery', 'awaiting_cod', 'delivered'];
