import type { DepthColumn } from '@htflow/market-data';
import type { HeatScale } from './gradient';
import { columnCutoffs, type Cutoffs, type NormalizeMode } from './normalize';

/** Downsampled time × price × size grid for the 3D view (max-pooled, same normalisation as 2D). */
export interface Surface {
  cols: number;
  rows: number;
  /** Heat index 0..255 per (col, row), row 0 = lowest price. */
  idx: Uint8Array;
  /** Raw size per cell (max of merged levels). */
  qty: Float32Array;
  pxLo: number;
  pxHi: number;
  /** Times of the first / last column. */
  t0: number;
  t1: number;
}

export interface SurfaceOptions {
  maxCols: number;
  maxRows: number;
  mode: NormalizeMode;
  global: Cutoffs;
  lowerPct: number;
  upperPct: number;
  scale: HeatScale;
  minSize: number;
}

export function buildSurface(
  colAt: (i: number) => DepthColumn | undefined,
  i0: number,
  i1: number,
  pxLo: number,
  pxHi: number,
  o: SurfaceOptions,
): Surface {
  const slots = Math.max(1, i1 - i0 + 1);
  const span = Math.max(1, pxHi - pxLo + 1);
  const cols = Math.max(1, Math.min(o.maxCols, slots));
  const rows = Math.max(1, Math.min(o.maxRows, span));
  const slotsPer = slots / cols;
  const ticksPer = span / rows;
  const idx = new Uint8Array(cols * rows);
  const qty = new Float32Array(cols * rows);
  let t0 = Number.NaN;
  let t1 = Number.NaN;
  for (let i = i0; i <= i1; i++) {
    const c = colAt(i);
    if (!c) continue;
    if (Number.isNaN(t0)) t0 = c.t;
    t1 = c.t;
    const cx = Math.min(cols - 1, Math.floor((i - i0) / slotsPer));
    const cut = o.mode === 'column' ? columnCutoffs(c, o.lowerPct, o.upperPct) : o.global;
    const range = Math.max(1e-12, cut.hi - cut.lo);
    for (let k = 0; k < c.pxs.length; k++) {
      const px = c.pxs[k]!;
      if (px < pxLo || px > pxHi) continue;
      const q = c.qtys[k]!;
      if (q <= 0 || q < o.minSize) continue;
      const ry = Math.min(rows - 1, Math.floor((px - pxLo) / ticksPer));
      const cell = cx * rows + ry;
      let t = (q - cut.lo) / range;
      if (t <= 0) continue;
      if (t > 1) t = 1;
      if (o.scale === 'sqrt') t = Math.sqrt(t);
      else if (o.scale === 'log') t = Math.log1p(t * 9) / Math.log(10);
      const v = Math.max(1, Math.round(t * 255));
      if (v > idx[cell]!) idx[cell] = v;
      if (q > qty[cell]!) qty[cell] = q;
    }
  }
  return { cols, rows, idx, qty, pxLo, pxHi, t0, t1 };
}

/** Isometric projection used by the Canvas2D fallback (yaw / pitch in radians). */
export function isoProject(
  x: number,
  y: number,
  z: number,
  yaw: number,
  pitch: number,
): { sx: number; sy: number; depth: number } {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const rx = x * cy - z * sy;
  const rz = x * sy + z * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return { sx: rx, sy: -(y * cp - rz * sp), depth: rz * cp + y * sp };
}
