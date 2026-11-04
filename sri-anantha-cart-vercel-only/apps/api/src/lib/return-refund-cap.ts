/**
 * The most that may be refunded against an order that has a return, as one SQL expression.
 *
 *  - No return, or a legacy return without item rows: the order total.
 *  - A full return (every order line returned in full): the order total, as before item-level
 *    returns existed. This keeps the delivery fee refundable on a full return.
 *  - A partial return: the value of the selected items (their stored refund snapshots).
 *
 * Whether the delivery fee should be refundable on a full return is an open business question;
 * this preserves the pre-integration behaviour until it is decided.
 *
 * @param orderId SQL expression for the order id (e.g. `$1` or `o.id`)
 * @param total   SQL expression for the order total in paise
 */
export function returnRefundCapSql(orderId: string, total: string): string {
  const items = `SELECT ri.order_item_id, ri.quantity, ri.refund_amount_paise
                   FROM order_return_items ri JOIN order_returns r ON r.id = ri.return_id WHERE r.order_id = ${orderId}`;
  return `(CASE
    WHEN NOT EXISTS (${items}) THEN (${total})::integer
    WHEN NOT EXISTS (
      SELECT 1 FROM order_items oi
       WHERE oi.order_id = ${orderId}
         AND oi.quantity > COALESCE((SELECT SUM(ret.quantity) FROM (${items}) ret WHERE ret.order_item_id = oi.id), 0)
    ) THEN (${total})::integer
    ELSE (SELECT SUM(ret.refund_amount_paise) FROM (${items}) ret)::integer
  END)`;
}
