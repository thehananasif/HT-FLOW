import type { SmartPrint } from './buffer';

export type SideFilter = 'all' | 'buy' | 'sell';

/** Tape filter. Sizes are in instrument quantity; prices in ticks. 0 / null = no bound. */
export interface TapeFilter {
  minSize: number;
  maxSize: number;
  side: SideFilter;
  minPx: number | null;
  maxPx: number | null;
}

export const DEFAULT_FILTER: TapeFilter = {
  minSize: 0,
  maxSize: 0,
  side: 'all',
  minPx: null,
  maxPx: null,
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Validates a (possibly persisted, possibly partial) filter: negatives → 0, swapped bounds → sorted. */
export function normalizeFilter(raw: Partial<Record<keyof TapeFilter, unknown>> = {}): TapeFilter {
  let minSize = Math.max(0, num(raw.minSize) ?? 0);
  let maxSize = Math.max(0, num(raw.maxSize) ?? 0);
  if (maxSize > 0 && minSize > maxSize) [minSize, maxSize] = [maxSize, minSize];
  const side: SideFilter = raw.side === 'buy' || raw.side === 'sell' ? raw.side : 'all';
  let minPx = num(raw.minPx);
  let maxPx = num(raw.maxPx);
  if (minPx !== null && maxPx !== null && minPx > maxPx) [minPx, maxPx] = [maxPx, minPx];
  return { minSize, maxSize, side, minPx, maxPx };
}

export function isFilterActive(f: TapeFilter): boolean {
  return f.minSize > 0 || f.maxSize > 0 || f.side !== 'all' || f.minPx !== null || f.maxPx !== null;
}

/** Allocation-free test on the raw fields of a print (side code: 1 buy, −1 sell, 0 unknown). */
export function passesRaw(f: TapeFilter, qty: number, sideCode: number, px: number): boolean {
  if (qty < f.minSize) return false;
  if (f.maxSize > 0 && qty > f.maxSize) return false;
  if (f.side === 'buy' && sideCode !== 1) return false;
  if (f.side === 'sell' && sideCode !== -1) return false;
  if (f.minPx !== null && px < f.minPx) return false;
  if (f.maxPx !== null && px > f.maxPx) return false;
  return true;
}

export function passes(f: TapeFilter, p: Pick<SmartPrint, 'qty' | 'side' | 'px'>): boolean {
  return passesRaw(f, p.qty, p.side === 'buy' ? 1 : p.side === 'sell' ? -1 : 0, p.px);
}

export function filterPrints<T extends Pick<SmartPrint, 'qty' | 'side' | 'px'>>(
  prints: readonly T[],
  f: TapeFilter,
): T[] {
  return prints.filter((p) => passes(f, p));
}
