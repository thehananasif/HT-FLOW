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
import {
  packBarsCached,
  packList,
  unpackBars,
  unpackList,
  type PackedBars,
  type PackedList,
} from './wire';
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
      /** Bar objects (legacy / tests); hosts accept either this or `packed`. */
      bars?: Bar[];
      /** Columnar bars (what RemoteRuntime sends: typed arrays clone ~100× faster than Bar objects). */
      packed?: PackedBars;
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
      /** List items from index `listFrom[k]` on (items before it are unchanged; absent = 0). */
      lists: Record<string, (Marker | Level | Zone)[] | PackedList>;
      listFrom?: Record<string, number>;
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

/** Last values sent for one series output (persistent; updated in place, never reallocated per tick). */
interface Shadow {
  cols: Float64Array[];
  tone: Uint8Array;
}

/** First index < limit where `a` and `b` differ (NaN equals NaN). */
function firstDiff(a: ArrayLike<number>, b: ArrayLike<number>, limit: number): number {
  const n = Math.min(limit, a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x !== y && !(x !== x && y !== y)) return i;
  }
  return limit;
}

/** Columns a series kind actually uses (v, v2, v3, v4). */
function usedCols(o: SeriesOut): Float64Array[] {
  const k = o.kind;
  const n = k === 'bars' ? 4 : k === 'histogram' ? 3 : k === 'band' ? 2 : 1;
  return [o.v, o.v2, o.v3, o.v4].slice(0, n);
}

/**
 * First bar index < limit where a series output differs from what was last sent (indicators such
 * as zigzag / pivots revise earlier bars). Allocation-free: compares against persistent shadows.
 */
function firstChange(
  shadow: Map<string, Shadow>,
  outputs: Record<string, SeriesOut | AnyList>,
  limit: number,
): number {
  let first = limit;
  for (const [k, o] of Object.entries(outputs)) {
    if (!(o instanceof SeriesOut)) continue;
    const prev = shadow.get(k);
    if (!prev) return 0;
    const cur = usedCols(o);
    for (let c = 0; c < cur.length; c++) first = firstDiff(prev.cols[c]!, cur[c]!, first);
    first = firstDiff(prev.tone, o.tone, first);
    if (first === 0) return 0;
  }
  return first;
}

/** Copies outputs [from, count) into the shadows (growing them when needed). */
function saveShadow(
  shadow: Map<string, Shadow>,
  outputs: Record<string, SeriesOut | AnyList>,
  from: number,
  count: number,
): void {
  for (const [k, o] of Object.entries(outputs)) {
    if (!(o instanceof SeriesOut)) continue;
    const cur = usedCols(o);
    let s = shadow.get(k);
    if (!s || s.tone.length < count) {
      const cap = Math.max(256, Math.ceil(count * 1.5));
      const cols = cur.map((a, c) => {
        const b = new Float64Array(cap).fill(Number.NaN);
        if (s) b.set(s.cols[c]!.subarray(0, Math.min(from, s.cols[c]!.length)));
        return b;
      });
      const tone = new Uint8Array(cap);
      if (s) tone.set(s.tone.subarray(0, Math.min(from, s.tone.length)));
      s = { cols, tone };
      shadow.set(k, s);
    }
    for (let c = 0; c < cur.length; c++) {
      s.cols[c]!.set(cur[c]!.subarray(from, count), from);
      s.cols[c]!.fill(Number.NaN, count);
    }
    s.tone.set(o.tone.subarray(from, count), from);
    s.tone.fill(0, count);
  }
}

type AnyItem = Marker | Level | Zone;

function sameItem(a: AnyItem, b: AnyItem): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = (a as unknown as Record<string, unknown>)[k];
    const y = (b as unknown as Record<string, unknown>)[k];
    if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) return false;
  }
  return true;
}

/**
 * Index of the first list item that differs from what was last sent (items are plain records and
 * may be edited in place by later bars, e.g. a level extended to the right), and refreshes the
 * shadow copies from there.
 */
function listDiff(prev: AnyItem[], items: readonly AnyItem[]): number {
  const n = Math.min(prev.length, items.length);
  let k = 0;
  while (k < n && sameItem(prev[k]!, items[k]!)) k++;
  prev.length = k;
  for (let i = k; i < items.length; i++) prev.push({ ...items[i]! });
  return k;
}

/** Message handler that owns runtimes; runs in a worker (or in-thread as the fallback). */
export class EngineHost {
  private rts = new Map<
    number,
    {
      rt: IndicatorRuntime;
      bars: Bar[];
      shadow: Map<string, Shadow>;
      lists: Map<string, AnyItem[]>;
    }
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
            lists: new Map(),
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
        const incoming = msg.packed ? unpackBars(msg.packed) : (msg.bars ?? []);
        if (msg.reset) e.bars = incoming;
        else {
          e.bars.length = Math.min(e.bars.length, msg.from);
          for (const b of incoming) e.bars.push(b);
        }
        try {
          const kind = e.rt.update({ bars: e.bars, version: msg.version, tickSize: msg.tickSize });
          const count = e.rt.count;
          let from = kind === 'full' ? 0 : Math.max(0, Math.min(msg.from, count));
          // Some indicators revise earlier bars (zigzag, pivots): send from the first change.
          if (from > 0) from = Math.min(from, firstChange(e.shadow, e.rt.outputs, from));
          saveShadow(e.shadow, e.rt.outputs, from, count);
          const series: Record<string, SeriesSlice> = {};
          const lists: Record<string, (Marker | Level | Zone)[] | PackedList> = {};
          const listFrom: Record<string, number> = {};
          for (const [k, o] of Object.entries(e.rt.outputs)) {
            if (o instanceof SeriesOut) series[k] = sliceSeries(o, from, count);
            else {
              let prev = e.lists.get(k);
              if (!prev || kind === 'full') e.lists.set(k, (prev = []));
              const at = listDiff(prev, o.items);
              listFrom[k] = at;
              // Long tails (a full result) go columnar; a tick's few changed items stay plain.
              lists[k] = o.items.length - at > 64 ? packList(o.items.slice(at)) : o.items.slice(at);
            }
          }
          return {
            op: 'result',
            rid: msg.rid,
            seq: msg.seq,
            from,
            count,
            series,
            lists,
            listFrom,
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
  for (const l of Object.values(m.lists))
    if (!Array.isArray(l))
      for (const a of [l.sig, l.kind, l.num]) if (a.byteLength) out.push(a.buffer as ArrayBuffer);
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
  /** Data of an update skipped while a message was in flight (sent when the reply arrives). */
  private deferred: BarData | null = null;

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
    // Backpressure: one message in flight per runtime. Updates while the worker is busy coalesce
    // into the next message (sent when the reply arrives and the chart redraws), so a burst of
    // ticks never builds a queue of stale work.
    if (this.pending > 0) {
      this.deferred = data;
      return 'none';
    }
    this.deferred = null;
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
      packed: packBarsCached(bars, from, data.version),
      version: data.version,
      tickSize: data.tickSize,
    });
    return appendOnly ? 'incremental' : 'full';
  }

  /** Applies a host reply. */
  apply(msg: FromEngine): void {
    if (this.disposed) return;
    this.pending = Math.max(0, this.pending - 1);
    if (msg.op === 'error') this.notice = msg.message;
    else this.applyResult(msg);
    const d = this.deferred;
    if (d && this.pending === 0) this.update(d);
    this.onChange();
  }

  private applyResult(msg: Extract<FromEngine, { op: 'result' }>): void {
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
        const l = msg.lists[k] ?? [];
        o.replaceFrom(msg.listFrom?.[k] ?? 0, Array.isArray(l) ? l : unpackList(l));
      }
    }
    this.count = msg.count;
    this.notice = msg.notice;
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
