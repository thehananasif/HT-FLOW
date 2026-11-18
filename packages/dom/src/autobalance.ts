/**
 * Auto-balance maths for the Smart DOM ladder (round 7): when to re-centre, how many rows fit,
 * the row height that fills the window, the columns that fit without horizontal scroll and the
 * size-bar scale. Pure functions so they are unit-tested without a canvas.
 */

/** When the ladder follows the last traded price. */
export type CentreMode = 'off' | 'out-of-view' | 'always';

/**
 * Next centre price. `rows` visible rows, `g` ticks per row. `out-of-view` re-centres only when the
 * reference price is outside the visible rows (one row of margin so the tag is never half cut);
 * `always` keeps it on the middle row. `paused` (user scrolled) suppresses both.
 */
export function nextCentre(opts: {
  mode: CentreMode;
  centre: number;
  ref: number;
  rows: number;
  g: number;
  paused: boolean;
}): number {
  const { mode, centre, ref, rows, g, paused } = opts;
  if (Number.isNaN(ref)) return centre;
  const snapped = Math.round(ref / g) * g;
  if (Number.isNaN(centre)) return snapped;
  if (paused || mode === 'off') return centre;
  if (mode === 'always') return snapped;
  const half = Math.floor(rows / 2);
  // Whole rows above / below the centre row that stay clear of the edge (one row of margin).
  const up = Math.max(0, half - 1);
  const down = Math.max(0, rows - 1 - half - 1);
  const rowsFromCentre = (ref - centre) / g;
  return rowsFromCentre > up || rowsFromCentre < -down ? snapped : centre;
}

/** Rows that fit: always odd so there are as many price rows above the centre as below it. */
export function symmetricRows(availableHeight: number, rowHeight: number): number {
  const n = Math.max(1, Math.floor(availableHeight / Math.max(1, rowHeight)));
  return n > 1 && n % 2 === 0 ? n - 1 : n;
}

/**
 * Row height that fills the window: the number of rows follows the preferred height, then the
 * height grows (up to 1.35x) or shrinks (down to `min`) so no blank strip is left at the bottom.
 */
export function fitRowHeight(
  availableHeight: number,
  preferred: number,
  min = 12,
): { rowHeight: number; rows: number } {
  if (availableHeight <= 0) return { rowHeight: preferred, rows: 1 };
  const rows = symmetricRows(availableHeight, preferred);
  const fitted = Math.floor(availableHeight / rows);
  const rowHeight = Math.max(min, Math.min(Math.round(preferred * 1.35), fitted));
  return { rowHeight, rows: Math.max(1, Math.min(rows, Math.floor(availableHeight / rowHeight))) };
}

/** Font size that always fits inside a row (2 px breathing room above and below). */
export const fitFontSize = (fontSize: number, rowHeight: number): number =>
  Math.max(8, Math.min(fontSize, rowHeight - 4));

/** Characters the widest value of a column needs (generous, for the minimum width). */
const COLUMN_CHARS: Record<string, number> = {
  price: 7,
  bid: 4,
  ask: 4,
  orders: 6,
  limits: 7,
  markers: 6,
  notes: 4,
  pnl: 5,
  vapoc: 3,
};

/** Drop order when the window is too narrow: first entries go first. */
const DROP_ORDER = [
  'notes',
  'markers',
  'limits',
  'pnl',
  'bidChg',
  'askChg',
  'vapoc',
  'cumBid',
  'cumAsk',
  'delta',
  'volume',
  'sells',
  'buys',
  'lastSize',
  'orders',
];

/** Minimum readable width of a column at this font size. */
export const columnMinWidth = (id: string, fontSize: number): number =>
  Math.ceil((COLUMN_CHARS[id] ?? 4) * fontSize * 0.6 + 6);

/**
 * Columns that fit `width` without horizontal scroll: lowest-priority columns are hidden until the
 * rest each reach their minimum width, then the survivors share the width in proportion to their
 * configured widths (never below their minimum). The returned widths sum to exactly `width`.
 */
export function fitColumns(
  cols: readonly { id: string; width: number }[],
  width: number,
  fontSize: number,
): { id: string; w: number }[] {
  let kept = cols.slice();
  const min = (id: string) => columnMinWidth(id, fontSize);
  const need = () => kept.reduce((a, c) => a + min(c.id), 0);
  for (const drop of DROP_ORDER) {
    if (need() <= width || kept.length <= 3) break;
    kept = kept.filter((c) => c.id !== drop);
  }
  while (need() > width && kept.length > 1) kept.pop();
  if (kept.length === 0) return [];
  const total = kept.reduce((a, c) => a + c.width, 0) || 1;
  const w = kept.map((c) => Math.max(min(c.id), Math.floor((c.width * width) / total)));
  let diff = width - w.reduce((a, x) => a + x, 0);
  // Hand the remainder to (or take the excess from) the widest columns, one pixel at a time.
  while (diff !== 0) {
    let idx = -1;
    for (let i = 0; i < w.length; i++) {
      if (diff < 0 && w[i]! <= min(kept[i]!.id)) continue;
      if (idx < 0 || w[i]! > w[idx]!) idx = i;
    }
    if (idx < 0) break;
    const step = diff > 0 ? 1 : -1;
    w[idx] = w[idx]! + step;
    diff -= step;
  }
  return kept.map((c, i) => ({ id: c.id, w: w[i]! }));
}

/** Largest value among the visible rows (the size bars scale to it so it exactly fits). */
export function visibleMax(values: Iterable<number>): number {
  let m = 0;
  for (const v of values) if (v > m) m = v;
  return m;
}

/** Bar length for `size` in a cell `cellWidth` wide: the largest visible level fills the cell. */
export function barLength(size: number, max: number, cellWidth: number): number {
  if (size <= 0 || max <= 0) return 0;
  return Math.max(2, Math.min(cellWidth, (size / max) * cellWidth));
}
