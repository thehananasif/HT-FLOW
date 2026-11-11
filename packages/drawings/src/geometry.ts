/** Screen-space geometry helpers (CSS px). */

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** Distance from point p to segment ab. */
export function distToSeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance from a point to a polyline given as flat [x0,y0,x1,y1,…]. */
export function distToPolyline(px: number, py: number, pts: readonly number[], closed = false) {
  let best = Infinity;
  const n = pts.length / 2;
  if (n === 1) return Math.hypot(px - pts[0]!, py - pts[1]!);
  for (let i = 0; i < n - 1; i++) {
    const d = distToSeg(px, py, pts[2 * i]!, pts[2 * i + 1]!, pts[2 * i + 2]!, pts[2 * i + 3]!);
    if (d < best) best = d;
  }
  if (closed && n > 2) {
    const d = distToSeg(px, py, pts[2 * n - 2]!, pts[2 * n - 1]!, pts[0]!, pts[1]!);
    if (d < best) best = d;
  }
  return best;
}

/** Even-odd point-in-polygon test (flat point list). */
export function pointInPoly(px: number, py: number, pts: readonly number[]): boolean {
  const n = pts.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i]!;
    const yi = pts[2 * i + 1]!;
    const xj = pts[2 * j]!;
    const yj = pts[2 * j + 1]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-12) + xi)
      inside = !inside;
  }
  return inside;
}

/** Normalised ellipse distance: < 1 inside, 1 on the outline. */
export function ellipseNorm(
  px: number,
  py: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): number {
  const nx = (px - cx) / Math.max(1e-9, rx);
  const ny = (py - cy) / Math.max(1e-9, ry);
  return Math.sqrt(nx * nx + ny * ny);
}

/** Approximate distance to an ellipse outline (good enough for hit-testing). */
export function distToEllipse(
  px: number,
  py: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): number {
  const n = ellipseNorm(px, py, cx, cy, rx, ry);
  return Math.abs(n - 1) * Math.min(Math.max(rx, 1), Math.max(ry, 1));
}

/**
 * Extends segment a→b to the box. extendLeft extends beyond a, extendRight beyond b
 * ("left"/"right" in parameter direction). Returns the clipped segment or null when outside.
 */
export function extendSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  box: Box,
  extendLeft: boolean,
  extendRight: boolean,
): [number, number, number, number] | null {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return [ax, ay, bx, by];
  let t0 = extendLeft ? -Infinity : 0;
  let t1 = extendRight ? Infinity : 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  const x0 = box.x;
  const x1 = box.x + box.w;
  const y0 = box.y;
  const y1 = box.y + box.h;
  if (
    !clip(-dx, ax - x0) ||
    !clip(dx, x1 - ax) ||
    !clip(-dy, ay - y0) ||
    !clip(dy, y1 - ay) ||
    t0 > t1
  )
    return null;
  // Infinite only if no extension was requested and the segment lies inside.
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy];
}

/** Ray from a through b, clipped to the box. */
export function ray(ax: number, ay: number, bx: number, by: number, box: Box) {
  return extendSegment(ax, ay, bx, by, box, false, true);
}

export function inBox(x: number, y: number, b: Box, pad = 0): boolean {
  return x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
}

export function rectPts(x0: number, y0: number, x1: number, y1: number): number[] {
  return [x0, y0, x1, y0, x1, y1, x0, y1];
}

/** Screen angle of a→b in degrees (up = positive). */
export function angleDeg(ax: number, ay: number, bx: number, by: number): number {
  return (Math.atan2(ay - by, bx - ax) * 180) / Math.PI;
}
