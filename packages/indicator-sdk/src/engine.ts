/**
 * Stage 8 — indicator engine off the main thread.
 *
 * `EngineHost` runs IndicatorRuntimes wherever it lives (a Web Worker in the app, the same thread
 * in tests). `RemoteRuntime` is its main-thread mirror: it implements the same `RuntimeLike`
 * surface the renderer reads, sends only what changed (all bars on a replace, the tail from the
 * previous last bar on append / last-bar change — the SDK's incremental contract) and applies the
 * returned output slices. `IndicatorPool` spreads runtimes over N transports (workers).
 *
 * Determinism: the host runs exactly the same IndicatorRuntime code on structured-cloned bars, so
 * pooled results equal main-thread results bit for bit (see engine.test.ts).
 */
import type { Bar } from '@htflow/market-data';
import { ListOut, SeriesOut, isSeriesKind } from './buffers';
import { resolveInputs } from './inputs';
import { defineMtf } from './mtf';
import { IndicatorRuntime, type UpdateKind } from './runtime';
import { scriptIndicator } from './script/compile';
import type {
  AnyIndicator,
  BarData,
  InputDefs,
  InputValues,
  Level,
  Marker,
  RawInputs,
  SeriesKind,
  TimeframeId,
  Zone,
} from './types';

type AnyList = ListOut<Marker | Level | Zone>;

/** What the renderer needs from a runtime (IndicatorRuntime, RemoteRuntime, ForeignRuntime). */
export interface RuntimeLike {
  readonly def: AnyIndicator;
  readonly inputs: InputValues<InputDefs>;
  readonly outputs: Record<string, SeriesOut | AnyList>;
  readonly count: number;
  readonly notice: string | null;
  update(data: BarData): UpdateKind;
  series(id: string): SeriesOut | undefined;
  list<T extends Marker | Level | Zone>(id: string): ListOut<T> | undefined;
  valueAt(id: string, i: number): number;
  dispose?(): void;
}

/** How a host builds the runtime (catalog id, or script source; optional higher timeframe). */
export interface EngineSpec {
  type: string;
  inputs: RawInputs;
  script?: { source: string; name: string };
  mtf?: { tf: TimeframeId; mode: 'closed' | 'live' };
}

export type ToEngine =
  | { op: 'create'; rid: number; spec: EngineSpec }
  | {
      op: 'bars';
      rid: number;
      seq: number;
      /** First index of `bars`; 0 with reset. */
      from: number;
      reset: boolean;
      bars: Bar[];
      version: number;
      tickSize: number;
    }
  | { op: 'dispose'; rid: number };

export interface SeriesSlice {
  v: Float64Array;
  v2: Float64Array;
  v3: Float64Array;
  v4: Float64Array;
  tone: Uint8Array;
}

export type FromEngine =
  | {
      op: 'result';
      rid: number;
      seq: number;
      from: number;
      count: number;
      series: Record<string, SeriesSlice>;
      lists: Record<string, (Marker | Level | Zone)[]>;
      notice: string | null;
      kind: UpdateKind;
    }
  | { op: 'error'; rid: number; seq: number; message: string };

/** Builds the definition a spec describes (scripts compiled with the sandboxed interpreter). */
export function resolveSpec(
  spec: EngineSpec,
  lookup: (id: string) => AnyIndicator | undefined,
): AnyIndicator {
  let def = spec.script
    ? scriptIndicator(spec.type, spec.script.source, spec.script.name)
    : lookup(spec.type);
  if (!def) throw new Error(`Unknown indicator ${spec.type}`);
  if (spec.mtf && spec.mtf.tf !== 'chart') def = mtfOf(def);
  return def;
}

const mtfCache = new WeakMap<AnyIndicator, AnyIndicator>();
/** Cached higher-timeframe wrapper of `def` (timeframe override, P13). */
export function mtfOf(def: AnyIndicator): AnyIndicator {
  let w = mtfCache.get(def);
  if (!w) {
    w = defineMtf(def, { id: `mtf:${def.id}`, name: def.name, short: def.short ?? def.name });
    mtfCache.set(def, w);
  }
  return w;
}

/** Inputs for the runtime: the base inputs plus the MTF wrapper's timeframe inputs. */
export function specInputs(spec: EngineSpec): RawInputs {
  return spec.mtf && spec.mtf.tf !== 'chart'
    ? { ...spec.inputs, mtfTimeframe: spec.mtf.tf, mtfMode: spec.mtf.mode }
    : spec.inputs;
}

function sliceSeries(o: SeriesOut, from: number, to: number): SeriesSlice {
  return {
    v: o.v.slice(from, to),
    v2: o.v2.slice(from, to),
    v3: o.v3.slice(from, to),
    v4: o.v4.slice(from, to),
    tone: o.tone.slice(from, to),
  };
}

const same = (a: number, b: number) => a === b || (Number.isNaN(a) && Number.isNaN(b));

/** First bar index < limit where a series output differs from what was last sent. */
function firstChange(
  shadow: Map<string, Float64Array[]>,
  outputs: Record<string, SeriesOut | AnyList>,
  limit: number,
): number {
  let first = limit;
  for (const [k, o] of Object.entries(outputs)) {
    if (!(o instanceof SeriesOut)) continue;
    const prev = shadow.get(k);
    if (!prev) return 0;
    const cur = [o.v, o.v2, o.v3, o.v4];
    for (let c = 0; c < 4; c++) {
      const a = prev[c]!;
      const b = cur[c]!;
      const n = Math.min(first, a.length, b.length);
      for (let i = 0; i < n; i++)
        if (!same(a[i]!, b[i]!)) {
          first = i;
          break;
        }
    }
  }
  return first;
}

/** Message handler that owns runtimes; runs in a worker (or in-thread as the fallback). */
export class EngineHost {
  private rts = new Map<
    number,
    { rt: IndicatorRuntime; bars: Bar[]; shadow: Map<string, Float64Array[]> }
  >();
  constructor(private lookup: (id: string) => AnyIndicator | undefined) {}

  handle(msg: ToEngine): FromEngine | null {
    switch (msg.op) {
      case 'create': {
        // Errors surface on the first 'bars' message (the runtime is missing).
        try {
          const def = resolveSpec(msg.spec, this.lookup);
          this.rts.set(msg.rid, {
            rt: new IndicatorRuntime(def, specInputs(msg.spec)),
            bars: [],
            shadow: new Map(),
          });
        } catch (e) {
          this.errors.set(msg.rid, e instanceof Error ? e.message : String(e));
        }
        return null;
      }
      case 'dispose':
        this.rts.delete(msg.rid);
        this.errors.delete(msg.rid);
        return null;
      case 'bars': {
        const e = this.rts.get(msg.rid);
        if (!e)
          return {
            op: 'error',
            rid: msg.rid,
            seq: msg.seq,
            message: this.errors.get(msg.rid) ?? 'Indicator not created',
          };
        if (msg.reset) e.bars = msg.bars;
        else {
          e.bars.length = Math.min(e.bars.length, msg.from);
          for (const b of msg.bars) e.bars.push(b);
        }
        try {
          const kind = e.rt.update({ bars: e.bars, version: msg.version, tickSize: msg.tickSize });
          const count = e.rt.count;
          let from = kind === 'full' ? 0 : Math.max(0, Math.min(msg.from, count));
          // Some indicators revise earlier bars (zigzag, pivots): send from the first change.
          if (from > 0) from = Math.min(from, firstChange(e.shadow, e.rt.outputs, from));
          for (const [k, o] of Object.entries(e.rt.outputs))
            if (o instanceof SeriesOut)
              e.shadow.set(
                k,
                [o.v, o.v2, o.v3, o.v4].map((a) => a.slice(0, count)),
              );
          const series: Record<string, SeriesSlice> = {};
          const lists: Record<string, (Marker | Level | Zone)[]> = {};
          for (const [k, o] of Object.entries(e.rt.outputs)) {
            if (o instanceof SeriesOut) series[k] = sliceSeries(o, from, count);
            else lists[k] = o.items.slice();
          }
          return {
            op: 'result',
            rid: msg.rid,
            seq: msg.seq,
            from,
            count,
            series,
            lists,
            notice: e.rt.notice,
            kind,
          };
        } catch (err) {
          return {
            op: 'error',
            rid: msg.rid,
            seq: msg.seq,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }
  }
  private errors = new Map<number, string>();
}

/** Typed arrays to transfer (zero-copy) with a result. */
export function transferables(m: FromEngine): ArrayBuffer[] {
  if (m.op !== 'result') return [];
  const out: ArrayBuffer[] = [];
  for (const s of Object.values(m.series))
    for (const a of [s.v, s.v2, s.v3, s.v4, s.tone])
      if (a.byteLength) out.push(a.buffer as ArrayBuffer);
  return out;
}

export interface EngineTransport {
  post(msg: ToEngine): void;
  onMessage(fn: (m: FromEngine) => void): void;
  terminate(): void;
}

/** Same-thread fallback (tests, no Worker support): replies synchronously. */
export class LocalTransport implements EngineTransport {
  private fn: ((m: FromEngine) => void) | null = null;
  readonly host: EngineHost;
  constructor(lookup: (id: string) => AnyIndicator | undefined) {
    this.host = new EngineHost(lookup);
  }
  post(msg: ToEngine): void {
    const r = this.host.handle(msg);
    if (r) this.fn?.(r);
  }
  onMessage(fn: (m: FromEngine) => void): void {
    this.fn = fn;
  }
  terminate(): void {
    this.fn = null;
  }
}

/**
 * Simulates the worker boundary in-thread: messages are structured-cloned both ways and
 * delivered asynchronously (tests for determinism across the clone boundary).
 */
export class CloneTransport implements EngineTransport {
  private fn: ((m: FromEngine) => void) | null = null;
  private host: EngineHost;
  private q: Promise<void> = Promise.resolve();
  constructor(lookup: (id: string) => AnyIndicator | undefined) {
    this.host = new EngineHost(lookup);
  }
  post(msg: ToEngine): void {
    const copy = structuredClone(msg);
    this.q = this.q.then(() => {
      const r = this.host.handle(copy);
      if (r) this.fn?.(structuredClone(r));
    });
  }
  /** Resolves when every posted message has been answered. */
  idle(): Promise<void> {
    return this.q;
  }
  onMessage(fn: (m: FromEngine) => void): void {
    this.fn = fn;
  }
  terminate(): void {
    this.fn = null;
  }
}

/** Main-thread mirror of a runtime that lives in an EngineHost. */
export class RemoteRuntime implements RuntimeLike {
  readonly inputs: InputValues<InputDefs>;
  readonly outputs: Record<string, SeriesOut | AnyList> = {};
  count = 0;
  notice: string | null = null;
  /** Messages in flight (diagnostics / tests). */
  pending = 0;
  private sent = 0;
  private version = Number.NaN;
  private first: Bar | undefined;
  private anchor: Bar | undefined;
  private seq = 0;
  private disposed = false;

  constructor(
    readonly def: AnyIndicator,
    private readonly rid: number,
    private readonly transport: EngineTransport,
    spec: EngineSpec,
    private readonly onChange: () => void,
  ) {
    this.inputs = resolveInputs(def.inputs, specInputs(spec));
    for (const [k, o] of Object.entries(def.outputs))
      this.outputs[k] = isSeriesKind(o.kind) ? new SeriesOut(o.kind as SeriesKind) : new ListOut();
    transport.post({ op: 'create', rid, spec });
  }

  update(data: BarData): UpdateKind {
    if (this.disposed) return 'none';
    const bars = data.bars;
    const n = bars.length;
    const m = this.sent;
    if (data.version === this.version && n === m && bars[0] === this.first) return 'none';
    const appendOnly =
      m > 0 && n >= m && bars[0] === this.first && (m < 2 || bars[m - 2] === this.anchor);
    const from = appendOnly ? m - 1 : 0;
    this.version = data.version;
    this.sent = n;
    this.first = bars[0];
    this.anchor = n >= 2 ? bars[n - 2] : undefined;
    this.pending++;
    this.transport.post({
      op: 'bars',
      rid: this.rid,
      seq: ++this.seq,
      from,
      reset: !appendOnly,
      bars: bars.slice(from) as Bar[],
      version: data.version,
      tickSize: data.tickSize,
    });
    return appendOnly ? 'incremental' : 'full';
  }

  /** Applies a host reply. */
  apply(msg: FromEngine): void {
    if (this.disposed) return;
    this.pending = Math.max(0, this.pending - 1);
    if (msg.op === 'error') {
      this.notice = msg.message;
      this.onChange();
      return;
    }
    const cap = Math.max(256, msg.count);
    for (const [k, o] of Object.entries(this.outputs)) {
      if (o instanceof SeriesOut) {
        const s = msg.series[k];
        if (o.capacity < cap) o.ensure(Math.ceil(cap * 1.5));
        if (msg.from === 0) o.clear(0);
        if (!s) continue;
        o.v.set(s.v, msg.from);
        if (s.v2.length && o.v2.length) o.v2.set(s.v2, msg.from);
        if (s.v3.length && o.v3.length) o.v3.set(s.v3, msg.from);
        if (s.v4.length && o.v4.length) o.v4.set(s.v4, msg.from);
        o.tone.set(s.tone, msg.from);
        if (msg.count < o.capacity) o.clear(msg.count);
      } else {
        o.clear();
        for (const it of msg.lists[k] ?? []) o.add(it);
      }
    }
    this.count = msg.count;
    this.notice = msg.notice;
    this.onChange();
  }

  series(id: string): SeriesOut | undefined {
    const o = this.outputs[id];
    return o instanceof SeriesOut ? o : undefined;
  }
  list<T extends Marker | Level | Zone>(id: string): ListOut<T> | undefined {
    const o = this.outputs[id];
    return o instanceof ListOut ? (o as unknown as ListOut<T>) : undefined;
  }
  valueAt(id: string, i: number): number {
    const s = this.series(id);
    if (!s || i < 0 || i >= this.count) return Number.NaN;
    return s.kind === 'bars' ? s.v4[i]! : s.v[i]!;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transport.post({ op: 'dispose', rid: this.rid });
  }
}

/** Spreads remote runtimes over a fixed set of transports (one per worker). */
export class IndicatorPool {
  private transports: EngineTransport[];
  private byRid = new Map<number, RemoteRuntime>();
  private nextRid = 1;
  private rr = 0;

  constructor(factory: (index: number) => EngineTransport, size: number) {
    this.transports = Array.from({ length: Math.max(1, Math.floor(size)) }, (_, k) => {
      const t = factory(k);
      t.onMessage((m) => this.byRid.get(m.rid)?.apply(m));
      return t;
    });
  }

  get size(): number {
    return this.transports.length;
  }

  create(def: AnyIndicator, spec: EngineSpec, onChange: () => void): RemoteRuntime {
    const rid = this.nextRid++;
    const t = this.transports[this.rr++ % this.transports.length]!;
    const rt = new RemoteRuntime(def, rid, t, spec, onChange);
    this.byRid.set(rid, rt);
    const dispose = rt.dispose.bind(rt);
    rt.dispose = () => {
      dispose();
      this.byRid.delete(rid);
    };
    return rt;
  }

  terminate(): void {
    for (const t of this.transports) t.terminate();
    this.byRid.clear();
  }
}
