import type { Bar } from '@htflow/market-data';
import type { Anchor } from './types';
import type { Proj } from './proj';

export interface MagnetOptions {
  /** Magnet to OHLC / cluster prices. */
  magnet: boolean;
  /** Sensitivity in px. */
  px: number;
  /** Round prices to whole ticks. */
  snapTicks: boolean;
}

export const DEFAULT_MAGNET: MagnetOptions = { magnet: true, px: 8, snapTicks: true };

/** Candidate prices of a bar: OHLC first (strong), then POC and every traded price (weak). */
export function barPrices(b: Bar): { strong: number[]; weak: number[] } {
  let poc = Number.NaN;
  let max = -1;
  for (const [px, c] of b.clusters) {
    const v = c.bid + c.ask;
    if (v > max) {
      max = v;
      poc = px;
    }
  }
  const weak = [...b.clusters.keys()];
  if (Number.isFinite(poc)) weak.unshift(poc);
  return { strong: [b.o, b.h, b.l, b.c], weak };
}

/**
 * Converts a screen point to an anchor with magnet (to OHLC, then cluster prices of the bar under
 * the cursor, within `px` pixels) and tick snapping. When the magnet catches, x snaps to the bar centre.
 */
export function anchorAt(
  P: Pick<Proj, 't' | 'px' | 'y' | 'slotAtX' | 'axis' | 'bars'>,
  x: number,
  y: number,
  opt: MagnetOptions,
): Anchor {
  let px = P.px(y);
  let t = P.t(x);
  const bars = P.bars;
  if (opt.magnet && bars && bars.length) {
    const i = Math.round(P.slotAtX(x));
    const b = bars[i];
    if (b) {
      const { strong, weak } = barPrices(b);
      const pick = (list: number[]) => {
        let best = Number.NaN;
        let bd = Infinity;
        for (const p of list) {
          const d = Math.abs(P.y(p) - y);
          if (d <= opt.px && d < bd) {
            bd = d;
            best = p;
          }
        }
        return best;
      };
      let hit = pick(strong);
      if (!Number.isFinite(hit)) hit = pick(weak);
      if (Number.isFinite(hit)) {
        px = hit;
        t = P.axis.timeOf(i);
      }
    }
  }
  if (opt.snapTicks) px = Math.round(px);
  return { t, px };
}
