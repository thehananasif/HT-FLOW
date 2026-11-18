import type { SeriesKind } from './types';

const EMPTY = new Float64Array(0);

function grow(a: Float64Array, cap: number): Float64Array {
  const b = new Float64Array(cap);
  b.set(a);
  b.fill(Number.NaN, a.length);
  return b;
}

/**
 * Per-bar output stored in typed arrays (NaN = no value).
 * - line / step / area / dots: `v`
 * - histogram: `v` (+ optional `v2` max / `v3` min wicks)
 * - band (filled cloud): `v` upper, `v2` lower
 * - bars: `v` open, `v2` high, `v3` low, `v4` close
 * `tone` selects the style colour per bar (0 = color, 1 = color2, 2 = color3).
 */
export class SeriesOut {
  v: Float64Array = EMPTY;
  v2: Float64Array = EMPTY;
  v3: Float64Array = EMPTY;
  v4: Float64Array = EMPTY;
  tone: Uint8Array = new Uint8Array(0);
  private readonly cols: number;

  constructor(readonly kind: SeriesKind) {
    this.cols = kind === 'bars' ? 4 : kind === 'histogram' ? 3 : kind === 'band' ? 2 : 1;
  }

  /** Capacity in bars. */
  get capacity(): number {
    return this.v.length;
  }

  ensure(cap: number): void {
    if (this.v.length >= cap) return;
    this.v = grow(this.v, cap);
    if (this.cols >= 2) this.v2 = grow(this.v2, cap);
    if (this.cols >= 3) this.v3 = grow(this.v3, cap);
    if (this.cols >= 4) this.v4 = grow(this.v4, cap);
    const t = new Uint8Array(cap);
    t.set(this.tone);
    this.tone = t;
  }

  /** Clears bars [from, end). */
  clear(from = 0): void {
    this.v.fill(Number.NaN, from);
    if (this.cols >= 2) this.v2.fill(Number.NaN, from);
    if (this.cols >= 3) this.v3.fill(Number.NaN, from);
    if (this.cols >= 4) this.v4.fill(Number.NaN, from);
    this.tone.fill(0, from);
  }

  clearAt(i: number): void {
    this.v[i] = Number.NaN;
    if (this.cols >= 2) this.v2[i] = Number.NaN;
    if (this.cols >= 3) this.v3[i] = Number.NaN;
    if (this.cols >= 4) this.v4[i] = Number.NaN;
    this.tone[i] = 0;
  }

  set(i: number, value: number, tone = 0): void {
    this.v[i] = value;
    this.tone[i] = tone;
  }

  /** Band upper/lower or histogram max/min wick. */
  setPair(i: number, a: number, b: number, tone = 0): void {
    if (this.kind === 'histogram') {
      this.v2[i] = a;
      this.v3[i] = b;
      return;
    }
    this.v[i] = a;
    this.v2[i] = b;
    this.tone[i] = tone;
  }

  setBar(i: number, o: number, h: number, l: number, c: number, tone?: number): void {
    this.v[i] = o;
    this.v2[i] = h;
    this.v3[i] = l;
    this.v4[i] = c;
    this.tone[i] = tone ?? (c >= o ? 0 : 1);
  }

  get(i: number): number {
    return i >= 0 && i < this.v.length ? this.v[i]! : Number.NaN;
  }

  /** Values that matter for scaling at bar i (NaN filtered by caller). */
  rangeAt(i: number): [number, number] {
    let lo = this.v[i]!;
    let hi = lo;
    const consider = (x: number) => {
      if (Number.isNaN(x)) return;
      if (Number.isNaN(lo) || x < lo) lo = x;
      if (Number.isNaN(hi) || x > hi) hi = x;
    };
    if (this.cols >= 2) consider(this.v2[i]!);
    if (this.cols >= 3) consider(this.v3[i]!);
    if (this.cols >= 4) consider(this.v4[i]!);
    return [lo, hi];
  }
}

/**
 * Sparse output (markers, levels, zones). Items are kept in the order calc() produced them;
 * each remembers the bar whose calc added it, so recomputing a bar first removes its items.
 */
export class ListOut<T extends { bar: number }> {
  items: T[] = [];
  private origins: number[] = [];
  /** Bar currently being computed (set by the runtime). */
  cursor = 0;

  add(item: T): T {
    this.items.push(item);
    this.origins.push(this.cursor);
    return item;
  }

  /** Last item (or undefined). */
  get last(): T | undefined {
    return this.items[this.items.length - 1];
  }

  /** Removes items added by calc of bar >= from (before that bar is recomputed). */
  truncate(from: number): void {
    let n = this.items.length;
    while (n > 0 && this.origins[n - 1]! >= from) n--;
    if (n !== this.items.length) {
      this.items.length = n;
      this.origins.length = n;
    }
  }

  /** Index of the first item added by the calc of bar >= `bar` (items.length when none). */
  indexFrom(bar: number): number {
    let lo = 0;
    let hi = this.origins.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.origins[mid]! < bar) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Keeps items [0, k) and appends `items` (applying a worker's list diff). */
  replaceFrom(k: number, items: readonly T[]): void {
    const n = Math.min(k, this.items.length);
    this.items.length = n;
    this.origins.length = n;
    for (const it of items) this.add(it);
  }

  clear(): void {
    this.items.length = 0;
    this.origins.length = 0;
  }
}

export function isSeriesKind(k: string): k is SeriesKind {
  return k !== 'markers' && k !== 'levels' && k !== 'zones';
}
