/** Customer-facing order reference, e.g. order_number 2345 => "SA12345". */
export function displayOrderNumber(orderNumber: number | string): string {
  return `SA${10_000 + Number(orderNumber)}`;
}

/** Parses "SA12345", "#SA12345" or "12345" back to the internal sequence number. */
export function parseOrderReference(reference: string): number | null {
  const match = /^#?\s*(?:SA)?(\d{5,12})$/i.exec(reference.trim());
  if (!match) return null;
  const value = Number(match[1]) - 10_000;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export const RETURN_WINDOW_HOURS = 48;

export const STATUS_GROUPS: Record<string, string[]> = {
  processing: ['pending_payment', 'placed', 'accepted', 'packed', 'dispatched'],
  delivered: ['delivered', 'return_requested', 'refund_initiated', 'refund_completed', 'refunded'],
  cancelled: ['cancelled'],
};
