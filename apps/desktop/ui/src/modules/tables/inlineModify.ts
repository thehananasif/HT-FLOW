import type { Order } from '@htflow/trading';

export type ModifyField = 'price' | 'qty';
export type ModifyChanges = { px?: number; stopPx?: number; qty?: number };

/** True when the price cell of this order edits the stop trigger (stop and trigger-only stop-limit). */
export const editsStop = (o: Pick<Order, 'type' | 'px'>): boolean =>
  o.type === 'stop' || (o.type === 'stop-limit' && o.px === undefined);

/**
 * Turns the text typed into an inline price / qty cell into paper-engine `modify` changes.
 * Prices are entered as prices and converted to ticks; null means "not a valid edit".
 */
export function parseModify(
  o: Pick<Order, 'type' | 'px' | 'filled'>,
  tickSize: number,
  field: ModifyField,
  text: string,
): ModifyChanges | null {
  const v = parseFloat(text.replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0) return null;
  if (field === 'qty') return v > o.filled ? { qty: v } : null;
  if (!(tickSize > 0)) return null;
  const ticks = Math.round(v / tickSize);
  if (ticks <= 0) return null;
  return editsStop(o) ? { stopPx: ticks } : { px: ticks };
}
