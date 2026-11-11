import { formatCompact, formatPrice, type Instrument } from '@htflow/market-data';
import type { ValueUnit } from './types';

/** rgba() from #RRGGBB or #RRGGBBAA. */
export function rgba(hex: string, a: number): string {
  const h = hex.charAt(0) === '#' ? hex.slice(1) : hex;
  const n = parseInt(h.slice(0, 6), 16);
  const base = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a * base))})`;
}

/** Formats an indicator value for scales and legends. 'price' values are ticks. */
export function formatValue(
  x: number,
  unit: ValueUnit,
  inst: Pick<Instrument, 'tickSize' | 'pricePrecision'>,
): string {
  if (!Number.isFinite(x)) return '—';
  switch (unit) {
    case 'price':
      return formatPrice(x, inst);
    case 'volume':
    case 'count':
      return formatCompact(Math.round(x * 1000) / 1000);
    case 'percent':
      return `${x.toFixed(Math.abs(x) >= 100 ? 1 : 2)}%`;
    case 'value': {
      const a = Math.abs(x);
      if (a >= 10_000) return formatCompact(x);
      if (a >= 100) return x.toFixed(1);
      if (a >= 1) return x.toFixed(2);
      if (a === 0) return '0';
      return x.toFixed(4);
    }
  }
}

/** "Nice" step (1/2/2.5/5 × 10^k) so that range/step ≈ target. */
export function niceStep(range: number, target: number): number {
  if (!(range > 0) || !(target > 0)) return 1;
  const raw = range / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
