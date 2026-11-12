import type { Proj } from './proj';
import { textBox, type Shape } from './shapes';
import { toolDef } from './tools';
import type { Drawing } from './types';

/** Multi-selection helpers (P12): Shift+click toggling, box select, group translate. */

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const normRect = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => ({
  x0: Math.min(a.x, b.x),
  y0: Math.min(a.y, b.y),
  x1: Math.max(a.x, b.x),
  y1: Math.max(a.y, b.y),
});

/** Shift+click: toggles id in the selection (keeps order, newest last). */
export function toggleSelection(sel: readonly string[], id: string): string[] {
  return sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
}

/** Bounding box of a display list (null when empty / all points are NaN). */
export function shapesBounds(shapes: readonly Shape[], P: Pick<Proj, 'measure'>): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const s of shapes) {
    if (s.k === 'path') {
      if ((s.hit ?? 'stroke') === 'none') continue;
      for (let i = 0; i + 1 < s.pts.length; i += 2) add(s.pts[i]!, s.pts[i + 1]!);
    } else if (s.k === 'ellipse') {
      add(s.cx - s.rx, s.cy - s.ry);
      add(s.cx + s.rx, s.cy + s.ry);
    } else if (s.k === 'marker') {
      add(s.x - s.size / 2, s.y - s.size / 2);
      add(s.x + s.size / 2, s.y + s.size / 2);
    } else if (s.hit !== false) {
      const b = textBox(s, P.measure);
      add(b.x, b.y);
      add(b.x + b.w, b.y + b.h);
    }
  }
  return x1 < x0 ? null : { x0, y0, x1, y1 };
}

const overlaps = (a: Rect, b: Rect) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;

/** Ids of the drawings whose bounds intersect the rectangle. */
export function selectInBox(items: readonly Drawing[], P: Proj, box: Rect): string[] {
  const out: string[] = [];
  for (const d of items) {
    if (d.hidden) continue;
    const def = toolDef(d.type);
    if (!def) continue;
    const b = shapesBounds(def.build(d, P), P);
    if (b && overlaps(b, box)) out.push(d.id);
  }
  return out;
}

type MoveProj = Pick<Proj, 'plot' | 'slotWidth' | 'axis' | 'px'>;

/**
 * Moves a drawing by a screen delta (px). Screen-fixed tools use plot fractions; time / price
 * tools move by whole slots in time and by the price delta (optionally rounded to ticks).
 */
export function translateDrawing(
  d: Drawing,
  P: MoveProj,
  dx: number,
  dy: number,
  y0: number,
  snapTicks = false,
): Drawing {
  const def = toolDef(d.type);
  if (def?.screen) {
    const fx = dx / P.plot.w;
    const fy = dy / P.plot.h;
    return { ...d, anchors: d.anchors.map((a) => ({ t: a.t + fx, px: a.px + fy })) };
  }
  const ds = dx / P.slotWidth;
  let dp = P.px(y0 + dy) - P.px(y0);
  if (snapTicks) dp = Math.round(dp);
  return {
    ...d,
    anchors: d.anchors.map((a) => ({
      t: ds ? P.axis.timeOf(P.axis.slotOf(a.t) + ds) : a.t,
      px: a.px + dp,
    })),
  };
}

/** Applies a translation to every unlocked drawing of the group. */
export function translateGroup(
  items: readonly Drawing[],
  ids: ReadonlySet<string>,
  P: MoveProj,
  dx: number,
  dy: number,
  y0: number,
  snapTicks = false,
): Drawing[] {
  return items.map((d) =>
    ids.has(d.id) && !d.locked ? translateDrawing(d, P, dx, dy, y0, snapTicks) : d,
  );
}

/** Removes the unlocked members of the group. */
export function deleteGroup(items: readonly Drawing[], ids: ReadonlySet<string>): Drawing[] {
  return items.filter((d) => !(ids.has(d.id) && !d.locked));
}

/** Applies a style patch to every member of the group. */
export function styleGroup(
  items: readonly Drawing[],
  ids: ReadonlySet<string>,
  patch: Partial<Drawing['style']>,
): Drawing[] {
  return items.map((d) => (ids.has(d.id) ? { ...d, style: { ...d.style, ...patch } } : d));
}

/** Applies an arbitrary change to every member of the group. */
export function mapGroup(
  items: readonly Drawing[],
  ids: ReadonlySet<string>,
  fn: (d: Drawing) => Drawing,
): Drawing[] {
  return items.map((d) => (ids.has(d.id) ? fn(d) : d));
}
