/**
 * Actions the chat can trigger on the trader's chart: draw / remove a horizontal line at a price
 * the model mentioned, and set a price alert there. Nothing here sends data anywhere.
 */
import { createDrawing, maxZ } from '@htflow/drawings';
import { hub } from '../../state/market';
import { useWindows } from '../../state/windows';
import { activeChartId, mutate, readDrawings } from '../drawings/store';
import { addAlert } from '../alerts/api';
import { alertDirection } from './levels';

export interface ChartTarget {
  windowId: string;
  instrumentId: string;
  symbol: string;
  tickSize: number;
  precision: number;
  last: number | null;
}

/** The chart the AI's price chips act on: the active chart, else the first one. */
export function chartTarget(): ChartTarget | null {
  const id = activeChartId();
  const w = id ? useWindows.getState().windows[id] : undefined;
  if (!id || !w || w.kind !== 'chart') return null;
  const s = hub.peek(w.instrumentId);
  const tickSize = s?.instrument.tickSize ?? 0;
  if (!(tickSize > 0)) return null;
  const px = s?.lastTrade?.px;
  return {
    windowId: id,
    instrumentId: w.instrumentId,
    symbol: s?.instrument.symbol ?? w.instrumentId,
    tickSize,
    precision: s?.instrument.pricePrecision ?? 2,
    last: px !== undefined ? px * tickSize : null,
  };
}

const LINE_COLOR = '#f5a623';

const sameLevel = (px: number, tick: number, price: number) =>
  Math.abs(px * tick - price) < tick / 2;

/** Whether an AI line already exists at `price` on the target chart. */
export function hasLevelLine(price: number, target = chartTarget()): boolean {
  if (!target) return false;
  return readDrawings(target.windowId).some(
    (d) => d.props.ai === true && sameLevel(d.anchors[0]?.px ?? NaN, target.tickSize, price),
  );
}

export type LineResult = 'added' | 'removed' | 'nochart';

/** Draws a horizontal line at `price` (or removes the one the AI drew there earlier). */
export function toggleLevelLine(price: number, label: string): LineResult {
  const target = chartTarget();
  if (!target) return 'nochart';
  const items = readDrawings(target.windowId);
  const existing = items.filter(
    (d) => d.props.ai === true && sameLevel(d.anchors[0]?.px ?? NaN, target.tickSize, price),
  );
  if (existing.length) {
    const ids = new Set(existing.map((d) => d.id));
    mutate(target.windowId, (all) => all.filter((d) => !ids.has(d.id)));
    return 'removed';
  }
  const line = createDrawing(
    'horizontal-line',
    [{ t: Date.now(), px: price / target.tickSize }],
    {
      showLabels: true,
      style: { color: LINE_COLOR, width: 1, dash: 'dashed', text: label },
      props: { ai: true },
    },
    maxZ(items) + 1,
  );
  mutate(target.windowId, (all) => [...all, line]);
  return 'added';
}

export type AlertResult = { ok: true } | { ok: false; error: string };

/** Price-cross alert at `price`; direction follows the side of the last price it lies on. */
export function setAlertAtLevel(price: number): AlertResult {
  const target = chartTarget();
  if (!target) return { ok: false, error: 'no chart' };
  const r = addAlert(
    {
      kind: 'price-cross',
      instrumentId: target.instrumentId,
      px: Math.round(price / target.tickSize),
      direction: alertDirection(price, target.last),
    },
    { announce: true },
  );
  return r.ok ? { ok: true } : { ok: false, error: r.errors.join('; ') };
}
