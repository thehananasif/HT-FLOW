import { ema, rma, sma, wma, type Series } from '@htflow/indicator-sdk';

export type MaType = 'sma' | 'ema' | 'wma' | 'rma';
export const MA_TYPES = [
  ['sma', 'SMA'],
  ['ema', 'EMA'],
  ['wma', 'WMA'],
  ['rma', 'SMMA / RMA'],
] as const;

/** Moving average of the given type at bar i; `out` holds the MA's previous values (EMA/RMA). */
export function maAt(type: MaType, out: Float64Array, src: Series, i: number, n: number): number {
  switch (type) {
    case 'sma':
      return sma(src, i, n);
    case 'ema':
      return ema(out, src, i, n);
    case 'wma':
      return wma(src, i, n);
    case 'rma':
      return rma(out, src, i, n);
  }
}

export const srcLabel = (s: string) => (s === 'close' ? '' : ` ${s}`);

/**
 * Index of the first list item that may still be open at bar i (zones / levels that end with
 * `to >= 0`). Items closed before bar i are never touched again, so scanning can start here
 * instead of at 0 — O(open items) per bar instead of O(all items), i.e. no O(n²) full recompute.
 * `ptr` is a per-bar scratch buffer (ctx.buf), which keeps the live-bar recompute exact.
 */
export function openFrom(items: readonly { to: number }[], ptr: Float64Array, i: number): number {
  const prev = i > 0 ? ptr[i - 1]! : 0;
  let p = Number.isNaN(prev) ? 0 : Math.min(prev, items.length);
  while (p < items.length && items[p]!.to >= 0 && items[p]!.to < i) p++;
  ptr[i] = p;
  return p;
}
