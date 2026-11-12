import type { DepthColumn } from '@htflow/market-data';
import type { HeatScale } from './gradient';
import { columnCutoffs, type Cutoffs, type NormalizeMode } from './normalize';

/** Age bins of the order-lifetime colour table. */
export const AGE_BINS = 16;

/** Horizontal run of a large resting order at one price row (for outlines). */
export interface LargeRun {
  /** Highest price (ticks) of the row. */
  px: number;
  slot0: number;
  slot1: number;
  maxQty: number;
}

export interface HeatFrame {
  /** Column for a slot (stride aware). */
  colAt(i: number): DepthColumn | undefined;
  /** First / last visible slot (inclusive). */
  i0: number;
  i1: number;
  /** Highest price (ticks) of the first pixel row. */
  top: number;
  /** Ticks merged per pixel row. */
  rowTicks: number;
  /** 256 colours (RGBA bytes viewed as Uint32). */
  lut32: Uint32Array;
  mode: NormalizeMode;
  /** Cut-offs used in global mode. */
  global: Cutoffs;
  lowerPct: number;
  upperPct: number;
  scale: HeatScale;
  /** Resting sizes below this are not drawn. */
  minSize: number;
  /** Collect runs of sizes ≥ this (0 = off). */
  largeSize: number;
  /** Order-lifetime colouring: AGE_BINS × 256 colours and the age that maps to the last bin. */
  lifetime: { lut: Uint32Array; maxAgeMs: number } | null;
  /** Slots looked back before i0 so ages of old orders are known (lifetime mode). */
  lookback: number;
}

const SCALE_STEPS = 1024;
const scaleTables = new Map<HeatScale, Uint8Array>();

/** t (0..1, quantised to 1/1023) → heat index 1..255 for each scale. */
function scaleTable(scale: HeatScale): Uint8Array {
  let tab = scaleTables.get(scale);
  if (tab) return tab;
  tab = new Uint8Array(SCALE_STEPS);
  for (let s = 0; s < SCALE_STEPS; s++) {
    let t = s / (SCALE_STEPS - 1);
    if (scale === 'sqrt') t = Math.sqrt(t);
    else if (scale === 'log') t = Math.log1p(t * 9) / Math.log(10);
    tab[s] = Math.max(1, Math.round(t * 255));
  }
  scaleTables.set(scale, tab);
  return tab;
}

/**
 * The heat texture as a pixel buffer: one pixel per (slot, price row). Pure (no DOM), so it can be
 * benchmarked and tested; the layer wraps `pixels` in an ImageData and scales it up without
 * smoothing.
 */
export class HeatBuffer {
  width = 0;
  height = 0;
  pixels = new Uint32Array(0);
  /** Heat index per pixel (keeps the hottest value when rows are merged). */
  private idx = new Uint8Array(0);
  private lastSeen = new Int32Array(0);
  private ageStart = new Float64Array(0);
  private runStart = new Int32Array(0);
  private runLast = new Int32Array(0);
  private runMax = new Float32Array(0);
  /** Cells written in the last render (for stats / tests). */
  cells = 0;

  resize(w: number, h: number): boolean {
    if (w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    this.pixels = new Uint32Array(w * h);
    this.idx = new Uint8Array(w * h);
    return true;
  }

  render(f: HeatFrame): LargeRun[] {
    const w = this.width;
    const h = this.height;
    const pixels = this.pixels;
    const idxBuf = this.idx;
    pixels.fill(f.lut32[0]!);
    idxBuf.fill(0);
    this.cells = 0;
    const runs: LargeRun[] = [];
    if (w <= 0 || h <= 0) return runs;
    const top = f.top;
    const rowTicks = Math.max(1, f.rowTicks | 0);
    const ticks = h * rowTicks;
    const bottom = top - ticks + 1;
    const tab = scaleTable(f.scale);
    const lut = f.lut32;
    const life = f.lifetime;
    const large = f.largeSize > 0;
    if (life) {
      if (this.lastSeen.length < ticks) {
        this.lastSeen = new Int32Array(ticks);
        this.ageStart = new Float64Array(ticks);
      }
      this.lastSeen.fill(-2, 0, ticks);
    }
    if (large) {
      if (this.runStart.length < h) {
        this.runStart = new Int32Array(h);
        this.runLast = new Int32Array(h);
        this.runMax = new Float32Array(h);
      }
      this.runStart.fill(-1, 0, h);
    }
    const lastSeen = this.lastSeen;
    const ageStart = this.ageStart;
    const runStart = this.runStart;
    const runLast = this.runLast;
    const runMax = this.runMax;
    const closeRun = (row: number) => {
      runs.push({
        px: top - row * rowTicks,
        slot0: runStart[row]!,
        slot1: runLast[row]!,
        maxQty: runMax[row]!,
      });
      runStart[row] = -1;
    };
    const ageScale = life ? (AGE_BINS - 1) / Math.max(1, life.maxAgeMs) : 0;
    const start = life ? Math.max(0, f.i0 - f.lookback) : f.i0;
    let cells = 0;
    for (let i = start; i <= f.i1; i++) {
      const c = f.colAt(i);
      if (!c) continue;
      const draw = i >= f.i0;
      const x = i - f.i0;
      const cut = f.mode === 'column' ? columnCutoffs(c, f.lowerPct, f.upperPct) : f.global;
      const lo = cut.lo;
      const inv = (SCALE_STEPS - 1) / Math.max(1e-12, cut.hi - lo);
      const pxs = c.pxs;
      const qs = c.qtys;
      const t = c.t;
      for (let k = 0; k < pxs.length; k++) {
        const px = pxs[k]!;
        if (px < bottom || px > top) continue;
        const q = qs[k]!;
        if (q <= 0 || q < f.minSize) continue;
        const off = top - px;
        let age = 0;
        if (life) {
          if (lastSeen[off] !== i - 1) ageStart[off] = t;
          lastSeen[off] = i;
          age = t - ageStart[off]!;
        }
        if (!draw) continue;
        const row = (off / rowTicks) | 0;
        if (large && q >= f.largeSize) {
          const rs = runStart[row]!;
          if (rs >= 0 && runLast[row]! < i - 1) closeRun(row);
          if (runStart[row]! < 0) {
            runStart[row] = i;
            runMax[row] = q;
          } else if (q > runMax[row]!) runMax[row] = q;
          runLast[row] = i;
        }
        let s = (q - lo) * inv;
        if (s <= 0) continue;
        if (s > SCALE_STEPS - 1) s = SCALE_STEPS - 1;
        const v = tab[s | 0]!;
        const o = row * w + x;
        if (v > idxBuf[o]!) {
          idxBuf[o] = v;
          if (life) {
            let bin = (age * ageScale) | 0;
            if (bin > AGE_BINS - 1) bin = AGE_BINS - 1;
            pixels[o] = life.lut[bin * 256 + v]!;
          } else pixels[o] = lut[v]!;
          cells++;
        }
      }
    }
    if (large) for (let r = 0; r < h; r++) if (runStart[r]! >= 0) closeRun(r);
    this.cells = cells;
    return runs;
  }
}

/**
 * Lifetime colour table: for each age bin, a ramp from the background (index 0) to a colour that
 * moves from `young` to `old`; brightness still follows the heat index.
 */
export function lifetimeLut(bg: Uint8ClampedArray, young: string, old: string): Uint32Array {
  const parse = (hex: string) => {
    const n = parseInt(hex.replace('#', '').slice(0, 6), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = parse(young);
  const b = parse(old);
  const bytes = new Uint8ClampedArray(AGE_BINS * 256 * 4);
  for (let bin = 0; bin < AGE_BINS; bin++) {
    const f = bin / (AGE_BINS - 1);
    const col = [0, 1, 2].map((j) => a[j]! + (b[j]! - a[j]!) * f);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const o = (bin * 256 + i) * 4;
      for (let j = 0; j < 3; j++) bytes[o + j] = bg[j]! + (col[j]! - bg[j]!) * t;
      bytes[o + 3] = 255;
    }
  }
  return new Uint32Array(bytes.buffer);
}

/** Uint32 view of an RGBA LUT (byte order matches ImageData on every platform). */
export function lut32Of(lut: Uint8ClampedArray): Uint32Array {
  return new Uint32Array(lut.buffer, lut.byteOffset, lut.byteLength >> 2);
}
