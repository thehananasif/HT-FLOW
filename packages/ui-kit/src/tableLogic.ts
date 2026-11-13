export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: string;
  dir: SortDir;
}

/** Click cycle on a header: none -> asc -> desc -> none. */
export function nextSort(cur: SortState | null, key: string): SortState | null {
  if (!cur || cur.key !== key) return { key, dir: 'asc' };
  if (cur.dir === 'asc') return { key, dir: 'desc' };
  return null;
}

const cmp = (a: unknown, b: unknown): number => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
};

/** Stable sort; null/undefined always sort last regardless of direction. */
export function sortRows<T>(
  rows: readonly T[],
  sort: SortState | null,
  get: (row: T, key: string) => unknown,
): T[] {
  if (!sort) return [...rows];
  const sign = sort.dir === 'asc' ? 1 : -1;
  const idx = rows.map((r, i) => [r, i] as const);
  idx.sort(([a, ai], [b, bi]) => {
    const va = get(a, sort.key);
    const vb = get(b, sort.key);
    if (va == null || vb == null) return cmp(va, vb) || ai - bi;
    return sign * cmp(va, vb) || ai - bi;
  });
  return idx.map(([r]) => r);
}

export interface VirtualRange {
  start: number;
  /** exclusive */
  end: number;
  offsetTop: number;
  totalHeight: number;
}

/** Which rows to render for a fixed row height, with `overscan` extra rows either side. */
export function virtualRange(
  count: number,
  rowH: number,
  scrollTop: number,
  viewH: number,
  overscan = 6,
): VirtualRange {
  const first = Math.floor(scrollTop / rowH);
  const visible = Math.ceil(viewH / rowH);
  const start = Math.max(0, Math.min(count, first - overscan));
  const end = Math.max(start, Math.min(count, first + visible + overscan));
  return { start, end, offsetTop: start * rowH, totalHeight: count * rowH };
}

/** Scroll offset that brings row `index` fully into view (unchanged if already visible). */
export function scrollIntoViewTop(
  index: number,
  rowH: number,
  scrollTop: number,
  viewH: number,
): number {
  const top = index * rowH;
  if (top < scrollTop) return top;
  if (top + rowH > scrollTop + viewH) return top + rowH - viewH;
  return scrollTop;
}

export interface SelectionState {
  selected: Set<string>;
  anchor: string | null;
}

/** Click selection: plain = single, ctrl/meta = toggle, shift = range from anchor. */
export function selectRow(
  ids: readonly string[],
  state: SelectionState,
  id: string,
  mods: { shift?: boolean; ctrl?: boolean },
  multi = true,
): SelectionState {
  if (!multi || (!mods.shift && !mods.ctrl)) return { selected: new Set([id]), anchor: id };
  if (mods.ctrl) {
    const next = new Set(state.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { selected: next, anchor: id };
  }
  const a = ids.indexOf(state.anchor ?? id);
  const b = ids.indexOf(id);
  if (a < 0 || b < 0) return { selected: new Set([id]), anchor: id };
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return { selected: new Set(ids.slice(lo, hi + 1)), anchor: state.anchor ?? id };
}

/* ------------------------------------------------------------------ column layout */

/** User column layout of one table: key order and pixel widths (only resized columns have one). */
export interface ColumnLayout {
  order: string[];
  widths: Record<string, number>;
}

export const MIN_COL_WIDTH = 40;
export const MAX_COL_WIDTH = 1200;

export const emptyLayout = (): ColumnLayout => ({ order: [], widths: {} });

/** Cleans untrusted persisted data; unknown shapes fall back to an empty layout. */
export function sanitizeLayout(v: unknown): ColumnLayout {
  const out = emptyLayout();
  if (typeof v !== 'object' || v === null) return out;
  const o = v as { order?: unknown; widths?: unknown };
  if (Array.isArray(o.order))
    out.order = [...new Set(o.order.filter((k): k is string => typeof k === 'string'))].slice(
      0,
      200,
    );
  if (typeof o.widths === 'object' && o.widths !== null) {
    for (const [k, w] of Object.entries(o.widths as Record<string, unknown>))
      if (typeof w === 'number' && Number.isFinite(w))
        out.widths[k] = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(w)));
  }
  return out;
}

/** Keys in display order: saved order first (unknown keys dropped), new columns go at the end. */
export function orderKeys(keys: readonly string[], layout: ColumnLayout): string[] {
  const known = new Set(keys);
  const head = layout.order.filter((k) => known.has(k));
  const seen = new Set(head);
  return [...head, ...keys.filter((k) => !seen.has(k))];
}

/** Moves `from` so it lands where `to` currently is. */
export function moveKey(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0 || a === b) return [...order];
  const next = [...order];
  next.splice(a, 1);
  next.splice(b, 0, from);
  return next;
}

/** New width after dragging a header edge by `delta` px. */
export function resizeWidth(start: number, delta: number): number {
  return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(start + delta)));
}

/** Index of the column whose range holds `x` (clamped to the ends). */
export function columnAt(rects: readonly { left: number; right: number }[], x: number): number {
  if (!rects.length) return -1;
  for (let i = 0; i < rects.length; i++) if (x < rects[i]!.right) return i;
  return rects.length - 1;
}

export interface LayoutStoreAdapter {
  get(id: string): ColumnLayout | undefined;
  set(id: string, layout: ColumnLayout | null): void;
}
