/**
 * Overlay another symbol (P13): the indicator is computed on a second instrument's bars and its
 * values are mapped onto the chart's bars by time (each chart bar shows the value of the other
 * instrument's last bar that opened at or before it). Price outputs are rescaled from the other
 * instrument's ticks to the chart's ticks, so they read as real prices on the legend and scales.
 */
import type { Bar } from '@htflow/market-data';
import { ListOut, SeriesOut, isSeriesKind } from './buffers';
import type { RuntimeLike } from './engine';
import { IndicatorRuntime, type UpdateKind } from './runtime';
import {
  isPriceSource,
  type AnyIndicator,
  type BarData,
  type InputDefs,
  type InputValues,
  type Level,
  type Marker,
  type RawInputs,
  type SeriesKind,
  type SourceId,
  type Zone,
} from './types';

type Item = Marker | Level | Zone;

/** Index of the last bar with t <= time (-1 when none). */
export function barAtOrBefore(bars: readonly Bar[], time: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let r = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t <= time) {
      r = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return r;
}

/** Index of the first bar with t >= time (bars.length when none). */
function firstAtOrAfter(bars: readonly Bar[], time: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class ForeignRuntime implements RuntimeLike {
  readonly inner: IndicatorRuntime;
  readonly outputs: Record<string, SeriesOut | ListOut<Item>> = {};
  count = 0;
  notice: string | null = null;
  private key = '';
  private first: Bar | undefined;
  private scale: Record<string, number> = {};

  constructor(
    readonly def: AnyIndicator,
    raw: RawInputs | undefined,
    private readonly foreign: () => BarData | null,
    private readonly chartTick: number,
    private readonly symbol: string,
  ) {
    this.inner = new IndicatorRuntime(def, raw);
    for (const [k, o] of Object.entries(def.outputs))
      this.outputs[k] = isSeriesKind(o.kind) ? new SeriesOut(o.kind as SeriesKind) : new ListOut();
    const src = (this.inner.inputs as Record<string, unknown>).source;
    const priceSrc = typeof src !== 'string' || isPriceSource(src as SourceId);
    for (const [k, o] of Object.entries(def.outputs))
      this.scale[k] = o.unit === 'price' && priceSrc ? 1 : 0;
  }

  get inputs(): InputValues<InputDefs> {
    return this.inner.inputs;
  }

  update(chart: BarData): UpdateKind {
    const f = this.foreign();
    if (!f || !f.bars.length) {
      this.notice = `waiting for ${this.symbol}`;
      return 'none';
    }
    const k = this.inner.update(f);
    const bars = chart.bars;
    const n = bars.length;
    const key = `${chart.version}|${f.version}|${n}|${f.bars.length}`;
    if (key === this.key && k === 'none' && bars[0] === this.first) return 'none';
    this.key = key;
    const replaced = bars[0] !== this.first || n < this.count;
    this.first = bars[0];
    const start = replaced || k === 'full' ? 0 : Math.max(0, this.count - 1);
    const fb = f.bars;
    const fac = f.tickSize / this.chartTick;
    for (const [id, o] of Object.entries(this.outputs)) {
      if (!(o instanceof SeriesOut)) continue;
      const src = this.inner.outputs[id] as SeriesOut;
      const mul = this.scale[id] ? fac : 1;
      o.ensure(Math.max(256, Math.ceil(n * 1.5)));
      if (start === 0) o.clear(0);
      let j = start < n ? barAtOrBefore(fb, bars[start]!.t) : -1;
      for (let i = start; i < n; i++) {
        const t = bars[i]!.t;
        while (j + 1 < fb.length && fb[j + 1]!.t <= t) j++;
        if (j < 0 || j >= this.inner.count) {
          o.clearAt(i);
          continue;
        }
        o.v[i] = src.v[j]! * mul;
        if (o.v2.length) o.v2[i] = src.v2[j]! * mul;
        if (o.v3.length) o.v3[i] = src.v3[j]! * mul;
        if (o.v4.length) o.v4[i] = src.v4[j]! * mul;
        o.tone[i] = src.tone[j]!;
      }
    }
    // Sparse outputs: remap bar indices by time (rebuilt; lists are short).
    const map = (fi: number) =>
      fi < 0 ? fi : fi < fb.length ? firstAtOrAfter(bars, fb[fi]!.t) : n;
    for (const [id, o] of Object.entries(this.outputs)) {
      if (o instanceof SeriesOut) continue;
      const mul = this.scale[id] ? fac : 1;
      o.clear();
      for (const it of (this.inner.outputs[id] as ListOut<Item>).items) {
        const bar = map(it.bar);
        if (bar >= n) continue;
        if ('top' in it)
          o.add({
            ...it,
            bar,
            to: it.to < 0 ? -1 : map(it.to),
            top: it.top * mul,
            bottom: it.bottom * mul,
          });
        else if ('to' in it)
          o.add({ ...it, bar, to: it.to < 0 ? -1 : map(it.to), value: it.value * mul });
        else o.add({ ...it, bar, value: it.value * mul });
      }
    }
    this.count = n;
    this.notice = this.inner.notice ? `${this.symbol}: ${this.inner.notice}` : null;
    return start === 0 ? 'full' : 'incremental';
  }

  series(id: string): SeriesOut | undefined {
    const o = this.outputs[id];
    return o instanceof SeriesOut ? o : undefined;
  }
  list<T extends Item>(id: string): ListOut<T> | undefined {
    const o = this.outputs[id];
    return o instanceof ListOut ? (o as unknown as ListOut<T>) : undefined;
  }
  valueAt(id: string, i: number): number {
    const s = this.series(id);
    if (!s || i < 0 || i >= this.count) return Number.NaN;
    return s.kind === 'bars' ? s.v4[i]! : s.v[i]!;
  }
}
