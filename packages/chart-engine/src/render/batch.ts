import { parseColor, type Rgba } from './color';

/** Floats per rect instance: x, y, w, h (CSS px) then r, g, b, a (straight alpha, 0..1). */
export const RECT_STRIDE = 8;

/**
 * Growable array of axis-aligned rect instances. Geometry builders fill it; the Canvas2D backend
 * replays it with `fillRect`, the WebGL2 backend uploads it as one instanced draw. Reused across
 * frames (`clear()` keeps the allocation).
 */
export class RectBatch {
  data: Float32Array;
  count = 0;

  constructor(capacity = 256) {
    this.data = new Float32Array(Math.max(1, capacity) * RECT_STRIDE);
  }

  clear(): this {
    this.count = 0;
    return this;
  }

  private grow(): void {
    const next = new Float32Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }

  /** Adds a rect; `alpha` multiplies the colour's own alpha. Empty / invalid rects are skipped. */
  rect(x: number, y: number, w: number, h: number, color: string | Rgba, alpha = 1): this {
    if (!(w > 0) || !(h > 0)) return this;
    const c = typeof color === 'string' ? parseColor(color) : color;
    const a = c[3] * alpha;
    if (a <= 0) return this;
    if ((this.count + 1) * RECT_STRIDE > this.data.length) this.grow();
    const d = this.data;
    const o = this.count * RECT_STRIDE;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = w;
    d[o + 3] = h;
    d[o + 4] = c[0];
    d[o + 5] = c[1];
    d[o + 6] = c[2];
    d[o + 7] = a;
    this.count++;
    return this;
  }

  /** 1-px (or `width`) outline as four rects — same pixels as a crisp `strokeRect`. */
  outline(x: number, y: number, w: number, h: number, color: string | Rgba, width = 1): this {
    if (w <= 0 || h <= 0) return this;
    const t = Math.min(width, w / 2, h / 2);
    this.rect(x, y, w, t, color);
    this.rect(x, y + h - t, w, t, color);
    this.rect(x, y + t, t, h - 2 * t, color);
    this.rect(x + w - t, y + t, t, h - 2 * t, color);
    return this;
  }

  /** Live instances (a view, not a copy). */
  view(): Float32Array {
    return this.data.subarray(0, this.count * RECT_STRIDE);
  }
}

/**
 * Triangle-strip vertices (x, y pairs) of a polyline of `n` points with the given width. Joins are
 * mitred (clamped to 2× the half-width so sharp turns do not spike). Separate runs joined by
 * `appendStrip` use degenerate triangles, so many lines still go out in one draw call.
 */
export function polylineStrip(pts: ArrayLike<number>, n: number, width: number): Float32Array {
  if (n < 2) return new Float32Array(0);
  const out = new Float32Array(n * 4);
  const hw = Math.max(0.5, width / 2);
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2]!;
    const y = pts[i * 2 + 1]!;
    // Direction of the incoming and outgoing segments.
    const pi = Math.max(0, i - 1);
    const ni = Math.min(n - 1, i + 1);
    let dx0 = x - pts[pi * 2]!;
    let dy0 = y - pts[pi * 2 + 1]!;
    let dx1 = pts[ni * 2]! - x;
    let dy1 = pts[ni * 2 + 1]! - y;
    const l0 = Math.hypot(dx0, dy0);
    const l1 = Math.hypot(dx1, dy1);
    if (l0 > 0) {
      dx0 /= l0;
      dy0 /= l0;
    }
    if (l1 > 0) {
      dx1 /= l1;
      dy1 /= l1;
    }
    if (l0 === 0) {
      dx0 = dx1;
      dy0 = dy1;
    }
    if (l1 === 0) {
      dx1 = dx0;
      dy1 = dy0;
    }
    // Normal of the averaged tangent, scaled to keep the stroke width across the join.
    let tx = dx0 + dx1;
    let ty = dy0 + dy1;
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-6) {
      tx = dx1;
      ty = dy1;
    } else {
      tx /= tl;
      ty /= tl;
    }
    const nx = -ty;
    const ny = tx;
    const dot = nx * -dy1 + ny * dx1;
    const k = Math.min(2, 1 / Math.max(0.5, Math.abs(dot) || 1));
    out[i * 4] = x + nx * hw * k;
    out[i * 4 + 1] = y + ny * hw * k;
    out[i * 4 + 2] = x - nx * hw * k;
    out[i * 4 + 3] = y - ny * hw * k;
  }
  return out;
}

/** Concatenates strips with degenerate triangles in between (one TRIANGLE_STRIP draw). */
export function joinStrips(strips: readonly Float32Array[]): Float32Array {
  const live = strips.filter((s) => s.length >= 4);
  if (!live.length) return new Float32Array(0);
  let len = 0;
  for (const s of live) len += s.length;
  len += (live.length - 1) * 4;
  const out = new Float32Array(len);
  let o = 0;
  live.forEach((s, k) => {
    if (k > 0) {
      // Repeat the previous last vertex and this first vertex: two zero-area triangles.
      out[o] = out[o - 2]!;
      out[o + 1] = out[o - 1]!;
      out[o + 2] = s[0]!;
      out[o + 3] = s[1]!;
      o += 4;
    }
    out.set(s, o);
    o += s.length;
  });
  return out;
}
