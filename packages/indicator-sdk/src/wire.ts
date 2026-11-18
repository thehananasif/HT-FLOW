/**
 * Columnar wire format for bars sent to the indicator workers.
 *
 * Structured-cloning `Bar` objects (each with a `Map` of footprint clusters) cost about 20 µs per
 * bar on the sending thread — over a second for 50,000 bars, once per indicator. Packing the same
 * bars into three typed arrays takes a few milliseconds and the clone of a typed array is a plain
 * memcpy. Unpacking (in the worker) rebuilds identical `Bar` objects, optional fields included.
 */
import type { Bar, Cluster } from '@htflow/market-data';

export interface PackedBars {
  n: number;
  /** BAR_W numbers per bar (see `pack`). */
  num: Float64Array;
  /** Cluster index range of bar k: [off[k], off[k + 1]). */
  off: Uint32Array;
  /** CL_W numbers per cluster: px, bid, ask, trades, maxTrade, tap. */
  cl: Float64Array;
}

const BAR_W = 19;
const CL_W = 6;

const OPT = ['dir', 'thick0', 'thick', 'flip'] as const;

/** Packs `bars[from..]`. */
export function packBars(bars: readonly Bar[], from = 0): PackedBars {
  const n = Math.max(0, bars.length - from);
  let k = 0;
  for (let i = from; i < bars.length; i++) k += bars[i]!.clusters.size;
  const num = new Float64Array(n * BAR_W);
  const off = new Uint32Array(n + 1);
  const cl = new Float64Array(k * CL_W);
  let c = 0;
  for (let j = 0; j < n; j++) {
    const b = bars[from + j]!;
    const p = j * BAR_W;
    num[p] = b.t;
    num[p + 1] = b.tEnd;
    num[p + 2] = b.o;
    num[p + 3] = b.h;
    num[p + 4] = b.l;
    num[p + 5] = b.c;
    num[p + 6] = b.vol;
    num[p + 7] = b.buy;
    num[p + 8] = b.sell;
    num[p + 9] = b.delta;
    num[p + 10] = b.maxDelta;
    num[p + 11] = b.minDelta;
    num[p + 12] = b.trades;
    num[p + 13] = b.closed ? 1 : 0;
    let mask = 0;
    for (let q = 0; q < OPT.length; q++) {
      const v = b[OPT[q]!];
      if (v !== undefined) {
        mask |= 1 << q;
        num[p + 14 + q] = v;
      }
    }
    num[p + 18] = mask;
    off[j] = c;
    for (const [px, x] of b.clusters) {
      const o = c * CL_W;
      cl[o] = px;
      cl[o + 1] = x.bid;
      cl[o + 2] = x.ask;
      cl[o + 3] = x.trades;
      cl[o + 4] = x.maxTrade;
      cl[o + 5] = x.tap === undefined ? Number.NaN : x.tap;
      // NaN marks "no tap"; a real NaN tap does not occur (it is a sum of gaps).
      c++;
    }
  }
  off[n] = c;
  return { n, num, off, cl };
}

/** Rebuilds the bars of a packet (field order and optional fields as in the source). */
export function unpackBars(p: PackedBars): Bar[] {
  const out: Bar[] = new Array(p.n);
  const { num, off, cl } = p;
  for (let j = 0; j < p.n; j++) {
    const q = j * BAR_W;
    const clusters = new Map<number, Cluster>();
    for (let c = off[j]!; c < off[j + 1]!; c++) {
      const o = c * CL_W;
      const x: Cluster = {
        bid: cl[o + 1]!,
        ask: cl[o + 2]!,
        trades: cl[o + 3]!,
        maxTrade: cl[o + 4]!,
      };
      const tap = cl[o + 5]!;
      if (!Number.isNaN(tap)) x.tap = tap;
      clusters.set(cl[o]!, x);
    }
    const b: Bar = {
      t: num[q]!,
      tEnd: num[q + 1]!,
      o: num[q + 2]!,
      h: num[q + 3]!,
      l: num[q + 4]!,
      c: num[q + 5]!,
      vol: num[q + 6]!,
      buy: num[q + 7]!,
      sell: num[q + 8]!,
      delta: num[q + 9]!,
      maxDelta: num[q + 10]!,
      minDelta: num[q + 11]!,
      trades: num[q + 12]!,
      clusters,
      closed: num[q + 13] === 1,
    };
    const mask = num[q + 18]!;
    for (let k = 0; k < OPT.length; k++) if (mask & (1 << k)) b[OPT[k]!] = num[q + 14 + k]!;
    out[j] = b;
  }
  return out;
}

let cache: {
  bars: readonly Bar[];
  from: number;
  n: number;
  version: number;
  p: PackedBars;
} | null = null;

/**
 * `packBars` memoised on (bars array, from, length, data version): when several indicators of one
 * chart update in the same frame, the history is packed once and the packet is posted to each.
 */
export function packBarsCached(bars: readonly Bar[], from: number, version: number): PackedBars {
  const c = cache;
  if (c && c.bars === bars && c.from === from && c.n === bars.length && c.version === version)
    return c.p;
  const p = packBars(bars, from);
  cache = { bars, from, n: bars.length, version, p };
  return p;
}

/**
 * Columnar form of list outputs (markers / levels / zones). A grid indicator emits hundreds of
 * thousands of small records; structured-cloning them costs the receiving (main) thread ~2 µs
 * each. Packed, the clone is a memcpy and decoding builds the same records (same keys in the same
 * order, so the result is indistinguishable from the original).
 */
export interface PackedList {
  n: number;
  /** Key-order signature per item (index into `sigs`). */
  sig: Uint32Array;
  sigs: string[][];
  /** One value per key: 0 number, 1 string (num = index into strs), 2 boolean, 3 undefined, 4 null. */
  kind: Uint8Array;
  num: Float64Array;
  strs: string[];
}

export function packList(items: readonly object[]): PackedList {
  const sigIds = new Map<string, number>();
  const sigs: string[][] = [];
  const strIds = new Map<string, number>();
  const strs: string[] = [];
  const sig = new Uint32Array(items.length);
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const keys = Object.keys(items[i]!);
    const k = keys.join('\u0000');
    let id = sigIds.get(k);
    if (id === undefined) {
      id = sigs.length;
      sigIds.set(k, id);
      sigs.push(keys);
    }
    sig[i] = id;
    total += keys.length;
  }
  const kind = new Uint8Array(total);
  const num = new Float64Array(total);
  let p = 0;
  for (let i = 0; i < items.length; i++) {
    const rec = items[i] as Record<string, unknown>;
    for (const key of sigs[sig[i]!]!) {
      const v = rec[key];
      if (typeof v === 'number') num[p] = v;
      else if (typeof v === 'string') {
        let s = strIds.get(v);
        if (s === undefined) {
          s = strs.length;
          strIds.set(v, s);
          strs.push(v);
        }
        kind[p] = 1;
        num[p] = s;
      } else if (typeof v === 'boolean') {
        kind[p] = 2;
        num[p] = v ? 1 : 0;
      } else kind[p] = v === null ? 4 : 3;
      p++;
    }
  }
  return { n: items.length, sig, sigs, kind, num, strs };
}

export function unpackList<T>(p: PackedList): T[] {
  const out: T[] = new Array(p.n);
  let q = 0;
  for (let i = 0; i < p.n; i++) {
    const rec: Record<string, unknown> = {};
    for (const key of p.sigs[p.sig[i]!]!) {
      const k = p.kind[q]!;
      const x = p.num[q]!;
      rec[key] = k === 0 ? x : k === 1 ? p.strs[x] : k === 2 ? x === 1 : k === 4 ? null : undefined;
      q++;
    }
    out[i] = rec as T;
  }
  return out;
}
