import type { Bar, Trade } from '@htflow/market-data';
import { ListOut, SeriesOut, isSeriesKind } from './buffers';
import { resolveInputs } from './inputs';
import type {
  AnyIndicator,
  BarData,
  CalcContext,
  InputDefs,
  InputValues,
  Level,
  Marker,
  OutputDefs,
  Outputs,
  RawInputs,
  SeriesKind,
  SourceId,
  Zone,
} from './types';

export type UpdateKind = 'none' | 'incremental' | 'full';

const NO_TRADES: readonly Trade[] = [];

function sourceValue(b: Bar, id: SourceId, prevCvd: number): number {
  switch (id) {
    case 'open':
      return b.o;
    case 'high':
      return b.h;
    case 'low':
      return b.l;
    case 'close':
      return b.c;
    case 'hl2':
      return (b.h + b.l) / 2;
    case 'hlc3':
      return (b.h + b.l + b.c) / 3;
    case 'ohlc4':
      return (b.o + b.h + b.l + b.c) / 4;
    case 'volume':
      return b.vol;
    case 'delta':
      return b.delta;
    case 'cvd':
      return (Number.isNaN(prevCvd) ? 0 : prevCvd) + b.delta;
    case 'buy':
      return b.buy;
    case 'sell':
      return b.sell;
    case 'trades':
      return b.trades;
  }
}

function growF64(a: Float64Array, cap: number): Float64Array {
  if (a.length >= cap) return a;
  const b = new Float64Array(cap);
  b.set(a);
  b.fill(Number.NaN, a.length);
  return b;
}

/**
 * Runs one indicator over a bar series. update() decides between nothing (same version),
 * incremental (bars only appended / last bar changed → recompute from the previous last bar) and
 * full recompute (bars replaced, inputs changed). Results stay in typed arrays.
 */
export class IndicatorRuntime {
  readonly inputs: InputValues<InputDefs>;
  readonly outputs: Record<string, SeriesOut | ListOut<Marker | Level | Zone>>;
  /** Number of bars computed. */
  count = 0;
  /** Stats for tests / debug overlay. */
  stats = { full: 0, incremental: 0, barsComputed: 0 };
  private version = Number.NaN;
  private first: Bar | undefined;
  private anchor: Bar | undefined;
  private cap = 0;
  private bufs = new Map<string, Float64Array>();
  private srcs = new Map<SourceId, Float64Array>();
  private state: unknown;
  private data: BarData | null = null;
  private ctx: CalcContext<InputDefs, OutputDefs, unknown>;

  constructor(
    readonly def: AnyIndicator,
    raw: RawInputs | undefined = undefined,
  ) {
    this.inputs = resolveInputs(def.inputs, raw);
    this.outputs = {};
    for (const [k, o] of Object.entries(def.outputs)) {
      this.outputs[k] = isSeriesKind(o.kind) ? new SeriesOut(o.kind as SeriesKind) : new ListOut();
    }
    this.ctx = {
      i: 0,
      bars: [],
      bar: undefined as unknown as Bar,
      count: 0,
      final: false,
      inputs: this.inputs,
      out: this.outputs as unknown as Outputs<OutputDefs>,
      buf: (name) => this.buf(name),
      src: (id) => this.src(id),
      trades: (i) => this.trades(i),
      tickSize: 1,
      state: undefined,
    };
  }

  /** Brings results up to date with `data`. Cheap when nothing changed. */
  update(data: BarData): UpdateKind {
    const bars = data.bars;
    if (data.version === this.version && bars.length === this.count && bars[0] === this.first) {
      this.data = data;
      return 'none';
    }
    const n = bars.length;
    const m = this.count;
    const appendOnly =
      m > 0 && n >= m && bars[0] === this.first && (m < 2 || bars[m - 2] === this.anchor);
    if (!appendOnly) {
      this.recompute(data);
      return 'full';
    }
    this.data = data;
    this.version = data.version;
    this.run(data, m - 1, n);
    this.stats.incremental++;
    return 'incremental';
  }

  /** Full recompute from bar 0. */
  recompute(data: BarData): void {
    this.data = data;
    this.version = data.version;
    this.ensure(data.bars.length);
    for (const o of Object.values(this.outputs)) {
      if (o instanceof SeriesOut) o.clear(0);
      else o.clear();
    }
    for (const b of this.bufs.values()) b.fill(Number.NaN);
    for (const s of this.srcs.values()) s.fill(Number.NaN);
    this.state = this.def.init?.(this.inputs);
    this.count = 0;
    this.run(data, 0, data.bars.length);
    this.stats.full++;
  }

  private run(data: BarData, from: number, to: number): void {
    const bars = data.bars;
    this.ensure(to);
    const ctx = this.ctx;
    ctx.bars = bars;
    ctx.count = to;
    ctx.tickSize = data.tickSize;
    ctx.state = this.state;
    const outs = Object.values(this.outputs);
    for (const o of outs) if (o instanceof ListOut) o.truncate(from);
    for (let i = from; i < to; i++) {
      const b = bars[i]!;
      ctx.i = i;
      ctx.bar = b;
      ctx.final = i < to - 1;
      for (const [id, arr] of this.srcs)
        arr[i] = sourceValue(b, id, i > 0 ? arr[i - 1]! : Number.NaN);
      for (const arr of this.bufs.values()) arr[i] = Number.NaN;
      for (const o of outs) {
        if (o instanceof SeriesOut) o.clearAt(i);
        else o.cursor = i;
      }
      this.def.calc(ctx);
      this.stats.barsComputed++;
    }
    this.count = to;
    this.first = bars[0];
    this.anchor = to >= 2 ? bars[to - 2] : undefined;
  }

  private ensure(n: number): void {
    if (n <= this.cap) return;
    const cap = Math.max(256, Math.ceil(n * 1.5));
    this.cap = cap;
    for (const o of Object.values(this.outputs)) if (o instanceof SeriesOut) o.ensure(cap);
    for (const [k, b] of this.bufs) this.bufs.set(k, growF64(b, cap));
    for (const [k, s] of this.srcs) this.srcs.set(k, growF64(s, cap));
  }

  private buf(name: string): Float64Array {
    let b = this.bufs.get(name);
    if (!b) {
      b = new Float64Array(this.cap).fill(Number.NaN);
      this.bufs.set(name, b);
    }
    return b;
  }

  private src(id: SourceId): Float64Array {
    let s = this.srcs.get(id);
    if (!s) {
      s = new Float64Array(this.cap).fill(Number.NaN);
      const bars = this.ctx.bars;
      for (let k = 0; k <= this.ctx.i && k < bars.length; k++)
        s[k] = sourceValue(bars[k]!, id, k > 0 ? s[k - 1]! : Number.NaN);
      this.srcs.set(id, s);
    }
    return s;
  }

  private trades(i: number): readonly Trade[] {
    const d = this.data;
    const b = d?.bars[i];
    if (!d?.tradesBetween || !b) return NO_TRADES;
    return d.tradesBetween(b.t, b.tEnd);
  }

  series(id: string): SeriesOut | undefined {
    const o = this.outputs[id];
    return o instanceof SeriesOut ? o : undefined;
  }

  list<T extends Marker | Level | Zone>(id: string): ListOut<T> | undefined {
    const o = this.outputs[id];
    return o instanceof ListOut ? (o as unknown as ListOut<T>) : undefined;
  }

  /** Value of a series output at bar i (NaN when absent). For bars outputs: the close. */
  valueAt(id: string, i: number): number {
    const s = this.series(id);
    if (!s || i < 0 || i >= this.count) return Number.NaN;
    return s.kind === 'bars' ? s.v4[i]! : s.v[i]!;
  }
}

/** Convenience: computes an indicator over bars in one go (tests, scripts). */
export function computeIndicator(
  def: AnyIndicator,
  bars: readonly Bar[],
  raw?: RawInputs,
  opts: { tickSize?: number; tradesBetween?: BarData['tradesBetween'] } = {},
): IndicatorRuntime {
  const rt = new IndicatorRuntime(def, raw);
  rt.recompute({
    bars,
    version: 1,
    tickSize: opts.tickSize ?? 1,
    tradesBetween: opts.tradesBetween,
  });
  return rt;
}
