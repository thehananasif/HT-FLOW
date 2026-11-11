/** Guided tour steps and pure placement maths (P28). */

export interface TourStep {
  id: string;
  /** CSS selectors tried in order; the first visible match is spotlighted. */
  targets: string[];
  title: string;
  body: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'ribbon',
    targets: ['.ribbon'],
    title: 'Ribbon',
    body: 'Every window lives here, grouped by purpose: analysis, platform, tables, market analytics and information. Click a button to open it. Press Ctrl+K to search everything by name.',
  },
  {
    id: 'chart',
    targets: ['.chart-window', '[data-testid^="chart-"]'],
    title: 'Chart',
    body: 'Footprint, candles with volume profile, liquidity map and order-flow charts. Wheel to zoom, drag to pan, and use the side tools for modes and drawings.',
  },
  {
    id: 'dom',
    targets: ['[data-testid="dom-ladder"]', '.dom-window'],
    title: 'Depth of market',
    body: 'The ladder shows resting size at each price. Left-click the bid or ask column for a buy limit, right-click for a sell limit, hold Ctrl for stops.',
  },
  {
    id: 'trading',
    targets: ['[data-testid="trading-panel"]'],
    title: 'Trading Panel',
    body: 'Market orders, bracket stop and target, reverse, breakeven and flatten for the paper account. Press T to show or hide it.',
  },
  {
    id: 'status',
    targets: ['.statusbar'],
    title: 'Status bar',
    body: 'Connection state, latency, clock and version. Restart this tour any time from the command palette with "Start guided tour".',
  },
];

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  /** Where the card sits relative to the target; "center" when there is no usable target. */
  side: 'below' | 'above' | 'right' | 'left' | 'center';
}

const GAP = 12;
const EDGE = 8;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Chooses where to put a tooltip of `size` next to `target` inside a `vw`×`vh` viewport:
 * below, above, right, left (first that fits fully), else the centre of the screen.
 */
export function placeTooltip(
  target: Box | null,
  size: { width: number; height: number },
  vw: number,
  vh: number,
): Placement {
  const center: Placement = {
    left: Math.round((vw - size.width) / 2),
    top: Math.round((vh - size.height) / 2),
    side: 'center',
  };
  if (!target) return center;
  const cx = clamp(target.left + target.width / 2 - size.width / 2, EDGE, vw - size.width - EDGE);
  const cy = clamp(target.top + target.height / 2 - size.height / 2, EDGE, vh - size.height - EDGE);
  const below = target.top + target.height + GAP;
  const above = target.top - GAP - size.height;
  const right = target.left + target.width + GAP;
  const left = target.left - GAP - size.width;
  if (below + size.height <= vh - EDGE) return { left: cx, top: below, side: 'below' };
  if (above >= EDGE) return { left: cx, top: above, side: 'above' };
  if (right + size.width <= vw - EDGE) return { left: right, top: cy, side: 'right' };
  if (left >= EDGE) return { left, top: cy, side: 'left' };
  return center;
}

/** Spotlight rectangle: the target padded by `pad` and clipped to the viewport. */
export function spotlightBox(target: Box, vw: number, vh: number, pad = 4): Box {
  const l = clamp(target.left - pad, 0, vw);
  const t = clamp(target.top - pad, 0, vh);
  const r = clamp(target.left + target.width + pad, 0, vw);
  const b = clamp(target.top + target.height + pad, 0, vh);
  return { left: l, top: t, width: r - l, height: b - t };
}
