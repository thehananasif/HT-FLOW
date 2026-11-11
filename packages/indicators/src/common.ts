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
