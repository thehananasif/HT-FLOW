/**
 * Geometry for workspaces: layout thumbnails, grid snapping, and multi-monitor restore (P25 / P37).
 * All functions are pure; rectangles are in pixels unless noted.
 */
import type { MonitorInfo, PanelSpec, Rect, WindowState, WorkspaceTab } from './model';

// ------------------------------------------------------------------ thumbnails

/** A window tile in a thumbnail, in 0..1 units of the layout. */
export interface ThumbTile {
  id: string;
  kind: WindowState['kind'];
  x: number;
  y: number;
  w: number;
  h: number;
  floating?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Tiles from PanelSpecs: each spec splits its reference tile in the given direction. */
export function specTiles(specs: PanelSpec[]): ThumbTile[] {
  const tiles = new Map<string, ThumbTile>();
  const order: string[] = [];
  for (const s of specs) {
    const ref = s.position && tiles.get(s.position.ref);
    if (!ref || !s.position || s.position.dir === 'within') {
      if (ref && s.position?.dir === 'within') {
        tiles.set(s.id, { ...ref, id: s.id, kind: s.state.kind });
        order.push(s.id);
        continue;
      }
      if (tiles.size === 0) {
        tiles.set(s.id, { id: s.id, kind: s.state.kind, x: 0, y: 0, w: 1, h: 1 });
        order.push(s.id);
      }
      continue;
    }
    const share = s.size ?? 0.5;
    const dir = s.position.dir;
    const t: ThumbTile = { id: s.id, kind: s.state.kind, x: ref.x, y: ref.y, w: ref.w, h: ref.h };
    if (dir === 'right' || dir === 'left') {
      const w = ref.w * share;
      ref.w -= w;
      t.w = w;
      if (dir === 'right') t.x = ref.x + ref.w;
      else ref.x += w;
    } else {
      const h = ref.h * share;
      ref.h -= h;
      t.h = h;
      if (dir === 'below') t.y = ref.y + ref.h;
      else ref.y += h;
    }
    tiles.set(s.id, t);
    order.push(s.id);
  }
  return order.map((id) => tiles.get(id)!);
}

/**
 * Tiles from a dockview `toJSON()` layout: walks the grid (orientation alternates per level, sizes
 * are relative), one tile per group (first view of the group), plus floating groups.
 */
export function layoutTiles(layout: unknown, windows: Record<string, WindowState>): ThumbTile[] {
  if (!isObj(layout) || !isObj(layout.grid)) return [];
  const grid = layout.grid;
  const out: ThumbTile[] = [];
  const W = typeof grid.width === 'number' && grid.width > 0 ? grid.width : 1;
  const H = typeof grid.height === 'number' && grid.height > 0 ? grid.height : 1;
  const leaf = (data: unknown, x: number, y: number, w: number, h: number, floating = false) => {
    if (!isObj(data) || !Array.isArray(data.views) || data.views.length === 0) return;
    const active = typeof data.activeView === 'string' ? data.activeView : data.views[0];
    const id = typeof active === 'string' ? active : String(data.views[0]);
    const kind = windows[id]?.kind ?? 'module';
    out.push({ id, kind, x, y, w, h, ...(floating ? { floating } : {}) });
  };
  const walk = (
    node: unknown,
    horizontal: boolean,
    x: number,
    y: number,
    w: number,
    h: number,
    depth: number,
  ) => {
    if (!isObj(node) || depth > 32) return;
    if (node.type === 'leaf') return leaf(node.data, x, y, w, h);
    if (!Array.isArray(node.data)) return;
    const kids = node.data.filter(isObj);
    const total = kids.reduce((a, k) => a + (typeof k.size === 'number' ? k.size : 0), 0) || 1;
    let off = 0;
    for (const k of kids) {
      const share = (typeof k.size === 'number' ? k.size : 0) / total;
      if (horizontal) walk(k, !horizontal, x + off * w, y, w * share, h, depth + 1);
      else walk(k, !horizontal, x, y + off * h, w, h * share, depth + 1);
      off += share;
    }
  };
  walk(grid.root, grid.orientation === 'HORIZONTAL', 0, 0, 1, 1, 0);
  for (const f of Array.isArray(layout.floatingGroups) ? layout.floatingGroups : []) {
    if (!isObj(f) || !isObj(f.position)) continue;
    const p = f.position;
    const w = (typeof p.width === 'number' ? p.width : 300) / W;
    const h = (typeof p.height === 'number' ? p.height : 200) / H;
    const x =
      typeof p.left === 'number'
        ? p.left / W
        : typeof p.right === 'number'
          ? 1 - w - p.right / W
          : 0;
    const y =
      typeof p.top === 'number'
        ? p.top / H
        : typeof p.bottom === 'number'
          ? 1 - h - p.bottom / H
          : 0;
    leaf(f.data, clamp01(x), clamp01(y), Math.min(1, w), Math.min(1, h), true);
  }
  return out;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Thumbnail tiles of a workspace tab, whichever form it is stored in. */
export function tabTiles(tab: WorkspaceTab): ThumbTile[] {
  if (tab.layout) {
    const t = layoutTiles(tab.layout, tab.windows);
    if (t.length) return t;
  }
  return specTiles(tab.specs ?? []);
}

// ------------------------------------------------------------------ grid snapping

export function snap(v: number, grid: number): number {
  return grid > 1 ? Math.round(v / grid) * grid : Math.round(v);
}

/** Snaps a rectangle's position and size to the grid (size never below one cell). */
export function snapRect(r: Rect, grid: number): Rect {
  if (grid <= 1) return r;
  return {
    x: snap(r.x, grid),
    y: snap(r.y, grid),
    width: Math.max(grid, snap(r.width, grid)),
    height: Math.max(grid, snap(r.height, grid)),
  };
}

// ------------------------------------------------------------------ multi-monitor restore

const area = (r: Rect) => Math.max(0, r.width) * Math.max(0, r.height);

export function intersection(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, r - x), height: Math.max(0, btm - y) };
}

/** The monitor that shows most of the rectangle (or null when it is entirely off-screen). */
export function monitorFor<M extends Rect>(r: Rect, monitors: M[]): M | null {
  let best: M | null = null;
  let bestArea = 0;
  for (const m of monitors) {
    const a = area(intersection(r, m));
    if (a > bestArea) {
      best = m;
      bestArea = a;
    }
  }
  return best;
}

/** Fits a rectangle inside an area: shrinks it if too large, then moves it fully inside. */
export function clampRect(r: Rect, into: Rect): Rect {
  const width = Math.min(r.width, into.width);
  const height = Math.min(r.height, into.height);
  const x = Math.min(Math.max(r.x, into.x), into.x + into.width - width);
  const y = Math.min(Math.max(r.y, into.y), into.y + into.height - height);
  return { x, y, width, height };
}

export type RestoreMode = 'exact' | 'fit';

export interface RestoreResult {
  rect: Rect;
  /** Name of the monitor the window ends up on. */
  monitor: string;
  /** True when the saved monitor is gone and the window was moved. */
  moved: boolean;
}

/**
 * Where to put a window saved at `saved` (on monitor `savedMonitor`) given today's monitors.
 * - Saved monitor still present (matched by name, else by geometry): keep the rectangle, clamped to
 *   that monitor ("exact"), or scaled into it when its resolution changed ("fit").
 * - Monitor missing: the same relative position on the primary monitor, clamped so the whole
 *   window is visible.
 */
export function restoreBounds(
  saved: Rect,
  savedMonitor: MonitorInfo | null,
  monitors: MonitorInfo[],
  mode: RestoreMode = 'exact',
): RestoreResult {
  if (monitors.length === 0)
    return { rect: saved, monitor: savedMonitor?.name ?? '', moved: false };
  const primary = monitors.find((m) => m.primary) ?? monitors[0]!;
  const same =
    savedMonitor &&
    (monitors.find((m) => m.name && m.name === savedMonitor.name) ??
      monitors.find(
        (m) =>
          m.x === savedMonitor.x &&
          m.y === savedMonitor.y &&
          m.width === savedMonitor.width &&
          m.height === savedMonitor.height,
      ));
  const from = savedMonitor ?? monitorFor(saved, monitors) ?? primary;
  const target = same ?? (savedMonitor ? primary : (monitorFor(saved, monitors) ?? primary));
  let rect = saved;
  if (target !== from || mode === 'fit') {
    // Same relative position (and, in fit mode, the same relative size) on the target monitor.
    const sx = mode === 'fit' ? target.width / from.width : 1;
    const sy = mode === 'fit' ? target.height / from.height : 1;
    rect = {
      x: target.x + (saved.x - from.x) * (target.width / from.width),
      y: target.y + (saved.y - from.y) * (target.height / from.height),
      width: saved.width * sx,
      height: saved.height * sy,
    };
  }
  rect = clampRect(rect, target);
  return {
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    monitor: target.name,
    moved: !same && !!savedMonitor,
  };
}

/** Anchored box as stored by dockview for floating groups. */
export interface AnchoredBoxLike {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  width: number;
  height: number;
}

export function anchoredToRect(
  p: AnchoredBoxLike,
  container: { width: number; height: number },
): Rect {
  const width = p.width;
  const height = p.height;
  const x = typeof p.left === 'number' ? p.left : container.width - width - (p.right ?? 0);
  const y = typeof p.top === 'number' ? p.top : container.height - height - (p.bottom ?? 0);
  return { x, y, width, height };
}

/**
 * Rewrites the floating groups of a dockview layout so they fit today's docking area: "fit" scales
 * positions and sizes from the saved container, "exact" keeps them and only clamps; both snap to
 * the grid when `grid` > 1. Returns a new layout object (the input is not changed).
 */
export function fitFloatingGroups(
  layout: unknown,
  container: { width: number; height: number },
  opts: { saved?: { width: number; height: number }; mode?: RestoreMode; grid?: number } = {},
): unknown {
  if (!isObj(layout) || !Array.isArray(layout.floatingGroups) || container.width <= 0)
    return layout;
  const saved = opts.saved ?? container;
  const sx = opts.mode === 'fit' && saved.width > 0 ? container.width / saved.width : 1;
  const sy = opts.mode === 'fit' && saved.height > 0 ? container.height / saved.height : 1;
  const area: Rect = { x: 0, y: 0, width: container.width, height: container.height };
  const floatingGroups = layout.floatingGroups.map((f) => {
    if (!isObj(f) || !isObj(f.position)) return f;
    const p = f.position as unknown as AnchoredBoxLike;
    if (typeof p.width !== 'number' || typeof p.height !== 'number') return f;
    let r = anchoredToRect(p, saved);
    r = { x: r.x * sx, y: r.y * sy, width: r.width * sx, height: r.height * sy };
    if (opts.grid && opts.grid > 1) r = snapRect(r, opts.grid);
    r = clampRect(r, area);
    return {
      ...f,
      position: {
        left: Math.round(r.x),
        top: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    };
  });
  return { ...layout, floatingGroups };
}

/** Screen bounds of each floating window, from the layout and the main window's screen position. */
export function floatingScreenBounds(
  layout: unknown,
  container: { width: number; height: number },
  containerOnScreen: { x: number; y: number },
  monitors: MonitorInfo[],
): Record<string, Rect & { monitor: string }> {
  const out: Record<string, Rect & { monitor: string }> = {};
  if (!isObj(layout) || !Array.isArray(layout.floatingGroups)) return out;
  for (const f of layout.floatingGroups) {
    if (!isObj(f) || !isObj(f.position) || !isObj(f.data) || !Array.isArray(f.data.views)) continue;
    const r = anchoredToRect(f.position as unknown as AnchoredBoxLike, container);
    const screen = { ...r, x: r.x + containerOnScreen.x, y: r.y + containerOnScreen.y };
    const m = monitorFor(screen, monitors);
    for (const v of f.data.views)
      if (typeof v === 'string') out[v] = { ...screen, monitor: m?.name ?? '' };
  }
  return out;
}
