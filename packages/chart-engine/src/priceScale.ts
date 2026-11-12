import { nicePriceStep } from './scale';

/**
 * Price scale maths (P08): linear, logarithmic, percent and indexed scales, optionally inverted.
 *
 * Prices stay in integer ticks. `log` changes the y mapping; `percent` and `indexed` keep a linear
 * mapping but label the axis relative to a base price (the first visible bar's close).
 */
export type PriceScaleMode = 'linear' | 'log' | 'percent' | 'indexed';

export const PRICE_SCALE_MODES: { value: PriceScaleMode; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'log', label: 'Logarithmic' },
  { value: 'percent', label: 'Percent' },
  { value: 'indexed', label: 'Indexed to 100' },
];

const LOG_FLOOR = 1e-6;

/** Forward transform (ticks → scale units). */
export function toScale(px: number, mode: PriceScaleMode): number {
  return mode === 'log' ? Math.log(Math.max(LOG_FLOOR, px)) : px;
}

/** Inverse transform (scale units → ticks). */
export function fromScale(u: number, mode: PriceScaleMode): number {
  return mode === 'log' ? Math.exp(u) : u;
}

export interface PriceMapping {
  yOf(px: number): number;
  pxAt(y: number): number;
}

/**
 * Builds the y mapping for a pane [top, top + h] showing prices [pmin, pmax].
 * Inverted scales put pmin at the top.
 */
export function priceMapping(
  pmin: number,
  pmax: number,
  top: number,
  h: number,
  mode: PriceScaleMode,
  inverted: boolean,
): PriceMapping {
  const a = toScale(pmin, mode);
  const b = toScale(pmax, mode);
  const span = Math.max(1e-12, b - a);
  if (!inverted) {
    return {
      yOf: (px) => top + ((b - toScale(px, mode)) / span) * h,
      pxAt: (y) => fromScale(b - ((y - top) / h) * span, mode),
    };
  }
  return {
    yOf: (px) => top + ((toScale(px, mode) - a) / span) * h,
    pxAt: (y) => fromScale(a + ((y - top) / h) * span, mode),
  };
}

/** Percent change of px vs base (0 when base is not positive). */
export function percentOf(px: number, base: number): number {
  return base > 0 ? (px / base - 1) * 100 : 0;
}

/** Indexed value of px where base = 100. */
export function indexedOf(px: number, base: number): number {
  return base > 0 ? (px / base) * 100 : 100;
}

/** Axis label for a price in ticks under the given mode (price itself is formatted by the caller). */
export function scaleLabel(
  px: number,
  mode: PriceScaleMode,
  base: number,
  formatPrice: (px: number) => string,
): string {
  if (mode === 'percent') {
    const v = percentOf(px, base);
    return `${v > 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 10 ? 2 : 1)}%`;
  }
  if (mode === 'indexed') return indexedOf(px, base).toFixed(2);
  return formatPrice(px);
}

/**
 * Price levels (ticks) for axis labels / grid lines between pmin and pmax, at least minPx apart.
 * Linear scales use one nice step; log scales pick a nice step per decade-ish band so labels
 * stay evenly spaced in pixels.
 */
export function scaleLevels(
  pmin: number,
  pmax: number,
  h: number,
  mode: PriceScaleMode,
  minPx = 56,
): number[] {
  const out: number[] = [];
  if (!(pmax > pmin) || h <= 0) return out;
  if (mode !== 'log') {
    const step = nicePriceStep(h / (pmax - pmin), minPx);
    const first = Math.ceil(pmin / step) * step;
    for (let px = first; px <= pmax && out.length < 500; px += step) out.push(px);
    return out;
  }
  const map = priceMapping(pmin, pmax, 0, h, 'log', false);
  let y = h;
  let last = -Infinity;
  while (y > 0 && out.length < 500) {
    const px = map.pxAt(y);
    // Local ticks-per-pixel → nice step at this height.
    const local = Math.max(1e-9, Math.abs(map.pxAt(y - 1) - px));
    const step = nicePriceStep(1 / local, minPx);
    const level = Math.ceil(px / step) * step;
    if (level > last && level <= pmax && level >= pmin) {
      out.push(level);
      last = level;
    }
    const ny = map.yOf(level) - minPx;
    y = Math.min(y - 1, ny);
  }
  return out;
}

/** Returns [pmin, pmax] padded by `pad` (fraction of the span), in scale space for log. */
export function padRange(
  lo: number,
  hi: number,
  pad: number,
  mode: PriceScaleMode,
): [number, number] {
  const a = toScale(lo, mode);
  const b = toScale(hi, mode);
  const p = (b - a) * pad;
  return [fromScale(a - p, mode), fromScale(b + p, mode)];
}
