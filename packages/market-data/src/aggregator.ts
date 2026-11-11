import type { Trade } from './types';

/**
 * Trading-session choice for a bar series (P07). `24h` (or undefined) applies no filter.
 * `rth` / `eth` use the instrument's catalog sessions; a custom window is exchange-local time.
 */
export type SessionSel =
  'rth' | 'eth' | '24h' | { open: string; close: string; tz?: string; days?: number[] };

/** Session rules resolved for one instrument (see `setSessionResolver`). */
export interface SessionRules {
  id: string;
  /** True when a trade at `ts` belongs to the session (trades outside are skipped). */
  inSession(ts: number): boolean;
  /** Open time of the session that contains `ts` — daily bars start here. */
  sessionStart(ts: number): number;
}

/**
 * Bar types (P07). Every type accepts custom values (timeframe dialog → Configure).
 * The exact rules of each type are documented in docs/ARCHITECTURE.md ("Bar types").
 */
export type BarSpecBase =
  | { kind: 'time'; ms: number }
  | { kind: 'tick'; n: number }
  | { kind: 'volume'; n: number }
  | { kind: 'delta'; n: number }
  | { kind: 'range'; ticks: number }
  /** Range X: closes exactly at the N-tick boundary (close-beyond rule). */
  | { kind: 'rangex'; ticks: number }
  /** Range XV: N-tick range that also needs `vol` volume before it may close. */
  | { kind: 'rangexv'; ticks: number; vol: number }
  /** Range Z: N-tick range, each bar opens at the previous close (no gaps). */
  | { kind: 'rangez'; ticks: number }
  /** Range US (universal): trend / reversal targets from the open, open offset for the next bar. */
  | { kind: 'rangeus'; trend: number; reversal: number; offset: number }
  /** Renko bricks of `box` ticks (2-box reversal); `wicks` keeps traded extremes. */
  | { kind: 'renko'; box: number; wicks?: boolean }
  /** Reversal bars: close at `size` ticks of range or `rev` ticks pull-back from the extreme. */
  | { kind: 'reversal'; size: number; rev: number }
  /** Order Flow bars: new bar after `n` consecutive prints of the other aggressor side. */
  | { kind: 'orderflow'; n: number }
  /** Cumulative trades: one bar per aggregated order, kept when its size is in [min, max] (max 0 = ∞). */
  | { kind: 'cumtrades'; min: number; max: number }
  /** Heikin-Ashi transform of time bars. */
  | { kind: 'heikin'; ms: number }
  /** Point & Figure: box size in ticks, reversal in boxes. */
  | { kind: 'pnf'; box: number; reversal: number }
  /** Kagi: reversal amount in ticks; yang / yin thickness per segment. */
  | { kind: 'kagi'; rev: number }
  /** N-line break over the closes of `ms` periods. */
  | { kind: 'linebreak'; lines: number; ms: number };

export type BarSpec = BarSpecBase & { session?: SessionSel };
export type BarKind = BarSpecBase['kind'];

/** Per-price cluster cell. bid = volume sold into the bid (sell aggressor), ask = volume bought at the ask. */
export interface Cluster {
  bid: number;
  ask: number;
  trades: number;
  /** Largest single print at this price. */
  maxTrade: number;
  /** Time at price, ms: time from each print until the next print, credited to the earlier price. */
  tap?: number;
}

export interface Bar {
  /** Open time (aligned for time bars, first trade time otherwise), epoch ms. */
  t: number;
  /** Time of the last trade in the bar. */
  tEnd: number;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  buy: number;
  sell: number;
  delta: number;
  maxDelta: number;
  minDelta: number;
  trades: number;
  clusters: Map<number, Cluster>;
  /** Count-based bars (tick/volume/delta/range) close explicitly. */
  closed: boolean;
  /** Direction of price-constructed bars (Renko brick, P&F column, Kagi segment): 1 up, -1 down, 0 none yet. */
  dir?: number;
  /** Kagi: 1 = yang (thick) at the segment start, 0 = yin. */
  thick0?: number;
  /** Kagi: thickness at the segment end. */
  thick?: number;
  /** Kagi: price (ticks) where the thickness flips inside the segment; NaN when it does not. */
  flip?: number;
}

const DAY = 86_400_000;
/** Longest gap credited to time-at-price for non-time bars (5 min). */
export const MAX_TAP_GAP_MS = 300_000;

function sessionKey(s: SessionSel | undefined): string {
  if (!s || s === '24h') return '';
  if (typeof s === 'string') return `@${s}`;
  return `@${s.open}-${s.close}${s.tz ? '-' + s.tz : ''}${s.days ? '-' + s.days.join('') : ''}`;
}

export function specKey(spec: BarSpec): string {
  return baseKey(spec) + sessionKey(spec.session);
}

function baseKey(spec: BarSpec): string {
  switch (spec.kind) {
    case 'time':
      return `t${spec.ms}`;
    case 'tick':
      return `k${spec.n}`;
    case 'volume':
      return `v${spec.n}`;
    case 'delta':
      return `d${spec.n}`;
    case 'range':
      return `r${spec.ticks}`;
    case 'rangex':
      return `rx${spec.ticks}`;
    case 'rangexv':
      return `rxv${spec.ticks}_${spec.vol}`;
    case 'rangez':
      return `rz${spec.ticks}`;
    case 'rangeus':
      return `rus${spec.trend}_${spec.reversal}_${spec.offset}`;
    case 'renko':
      return `rk${spec.box}${spec.wicks === false ? 'n' : ''}`;
    case 'reversal':
      return `rv${spec.size}_${spec.rev}`;
    case 'orderflow':
      return `of${spec.n}`;
    case 'cumtrades':
      return `ct${spec.min}_${spec.max}`;
    case 'heikin':
      return `ha${spec.ms}`;
    case 'pnf':
      return `pf${spec.box}_${spec.reversal}`;
    case 'kagi':
      return `kg${spec.rev}`;
    case 'linebreak':
      return `lb${spec.lines}_${spec.ms}`;
  }
}

function timeLabel(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `S${s}`;
  if (s < 3600) return `M${s / 60}`;
  if (s < 86400) return `H${s / 3600}`;
  if (s === 86400) return 'D';
  if (s === 7 * 86400) return 'W';
  if (s === 30 * 86400) return 'Mo';
  return `${s / 86400}D`;
}

export function specLabel(spec: BarSpec): string {
  const sess =
    !spec.session || spec.session === '24h'
      ? ''
      : typeof spec.session === 'string'
        ? ` ${spec.session.toUpperCase()}`
        : ' Custom';
  return baseLabel(spec) + sess;
}

function baseLabel(spec: BarSpec): string {
  switch (spec.kind) {
    case 'time':
      return timeLabel(spec.ms);
    case 'tick':
      return `${spec.n} Tick`;
    case 'volume':
      return `${spec.n} Vol`;
    case 'delta':
      return `${spec.n} Delta`;
    case 'range':
      return `Range ${spec.ticks}`;
    case 'rangex':
      return `Range X ${spec.ticks}`;
    case 'rangexv':
      return `Range XV ${spec.ticks}/${spec.vol}`;
    case 'rangez':
      return `Range Z ${spec.ticks}`;
    case 'rangeus':
      return `Range US ${spec.offset}/${spec.trend}/${spec.reversal}`;
    case 'renko':
      return `Renko ${spec.box}${spec.wicks === false ? ' (no wicks)' : ''}`;
    case 'reversal':
      return `Reversal ${spec.size}/${spec.rev}`;
    case 'orderflow':
      return `Order Flow ${spec.n}`;
    case 'cumtrades':
      if (spec.min <= 0 && spec.max <= 0) return 'Cum. Trades All';
      if (spec.min <= 0) return `Cum. Trades ≤${spec.max}`;
      if (spec.max <= 0) return `Cum. Trades ≥${spec.min}`;
      return `Cum. Trades ${spec.min}..${spec.max}`;
    case 'heikin':
      return `HA ${timeLabel(spec.ms)}`;
    case 'pnf':
      return `P&F ${spec.box}x${spec.reversal}`;
    case 'kagi':
      return `Kagi ${spec.rev}`;
    case 'linebreak':
      return `${spec.lines}LB ${timeLabel(spec.ms)}`;
  }
}

/** True for bar types whose x-axis has a fixed duration per bar (time, Heikin-Ashi). */
export function isTimeBased(spec: BarSpec): boolean {
  return spec.kind === 'time' || spec.kind === 'heikin';
}

/** Bar duration in ms for time-based types, else null. */
export function specMs(spec: BarSpec): number | null {
  return spec.kind === 'time' || spec.kind === 'heikin' ? spec.ms : null;
}

function emptyBar(t: number, px: number): Bar {
  return {
    t,
    tEnd: t,
    o: px,
    h: px,
    l: px,
    c: px,
    vol: 0,
    buy: 0,
    sell: 0,
    delta: 0,
    maxDelta: 0,
    minDelta: 0,
    trades: 0,
    clusters: new Map(),
    closed: false,
  };
}

const sideCode = (s: Trade['side']): number => (s === 'buy' ? 1 : s === 'sell' ? -1 : 0);

/** Columnar ticks (typed arrays) for the bulk path / benchmark. side: 1 buy, -1 sell, 0 unknown. */
export interface TradeColumns {
  ts: Float64Array;
  px: Int32Array | Float64Array;
  qty: Float64Array | Float32Array;
  side: Int8Array;
  length?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Incremental bar builder (Live Pipeline stage 7). Every bar type is a per-trade state machine and
 * the same `push` path is used for history and live, so a bulk build and any chunked incremental
 * build of the same trades are identical by construction (property-tested).
 */
export class BarSeries {
  readonly bars: Bar[] = [];
  /** Bumped on any change. */
  version = 0;
  /** Session rules applied (null = 24h). */
  readonly rules: SessionRules | null;

  // builder state
  private st: any = {};
  private curEnd = -Infinity;
  // last cluster lookup cache
  private cBar: Bar | null = null;
  private cPx = Number.NaN;
  private cCl: Cluster | null = null;
  // time-at-price
  private prevCl: Cluster | null = null;
  private prevTs = 0;
  private prevCap = 0;

  constructor(
    readonly spec: BarSpec,
    rules: SessionRules | null = null,
  ) {
    this.rules = rules;
  }

  get last(): Bar | undefined {
    return this.bars[this.bars.length - 1];
  }

  /** Adds a trade. Returns true when a new bar was opened. */
  add(tr: Trade): boolean {
    const n = this.bars.length;
    const last = this.bars[n - 1];
    this.push(tr.ts, tr.px, tr.qty, sideCode(tr.side));
    return this.bars.length !== n || this.bars[n - 1] !== last;
  }

  addAll(trades: readonly Trade[]): void {
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i]!;
      this.push(t.ts, t.px, t.qty, t.side === 'buy' ? 1 : t.side === 'sell' ? -1 : 0);
    }
  }

  /** Bulk path over typed arrays (no Trade objects). */
  addColumns(c: TradeColumns): void {
    const n = c.length ?? c.ts.length;
    const { ts, px, qty, side } = c;
    for (let i = 0; i < n; i++) this.push(ts[i]!, px[i]!, qty[i]!, side[i]!);
  }

  static build(spec: BarSpec, trades: readonly Trade[], rules: SessionRules | null = null) {
    const s = new BarSeries(spec, rules);
    s.addAll(trades);
    return s;
  }

  /** Drops all bars and builder state (history reload). */
  clear(): void {
    this.bars.length = 0;
    this.st = {};
    this.curEnd = -Infinity;
    this.cBar = null;
    this.cCl = null;
    this.prevCl = null;
    this.version++;
  }

  /** Index of the bar containing time t (binary search on open time). */
  indexAt(t: number): number {
    const b = this.bars;
    let lo = 0;
    let hi = b.length - 1;
    if (hi < 0) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (b[mid]!.t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // ------------------------------------------------------------------ core

  private open(t: number, px: number): Bar {
    const last = this.bars[this.bars.length - 1];
    if (last) last.closed = true;
    const b = emptyBar(t, px);
    this.bars.push(b);
    return b;
  }

  /** Adds one print to a bar. `ohlc` false = volume / clusters only (price-constructed types). */
  private put(
    bar: Bar,
    ts: number,
    px: number,
    qty: number,
    side: number,
    ohlc: boolean,
    cap: number,
  ): void {
    bar.tEnd = ts;
    if (ohlc) {
      if (px > bar.h) bar.h = px;
      if (px < bar.l) bar.l = px;
      bar.c = px;
    }
    bar.vol += qty;
    bar.trades += 1;
    let cl: Cluster | null | undefined;
    if (this.cBar === bar && this.cPx === px) cl = this.cCl;
    else {
      cl = bar.clusters.get(px);
      if (!cl) {
        cl = { bid: 0, ask: 0, trades: 0, maxTrade: 0, tap: 0 };
        bar.clusters.set(px, cl);
      }
      this.cBar = bar;
      this.cPx = px;
      this.cCl = cl;
    }
    cl!.trades += 1;
    if (qty > cl!.maxTrade) cl!.maxTrade = qty;
    if (side > 0) {
      bar.buy += qty;
      cl!.ask += qty;
    } else if (side < 0) {
      bar.sell += qty;
      cl!.bid += qty;
    }
    const d = bar.buy - bar.sell;
    bar.delta = d;
    if (d > bar.maxDelta) bar.maxDelta = d;
    if (d < bar.minDelta) bar.minDelta = d;
    // time at price: the time since the previous print is credited to the previous print's price
    const pc = this.prevCl;
    if (pc !== null) {
      const dt = (ts < this.prevCap ? ts : this.prevCap) - this.prevTs;
      if (dt > 0) pc.tap = (pc.tap ?? 0) + dt;
    }
    this.prevCl = cl!;
    this.prevTs = ts;
    this.prevCap = cap;
  }

  /** Feeds one print (prices in ticks). */
  push(ts: number, px: number, qty: number, side: number): void {
    this.version++;
    const rules = this.rules;
    if (rules !== null && !rules.inSession(ts)) {
      this.prevCl = null;
      return;
    }
    const spec = this.spec;
    switch (spec.kind) {
      case 'time': {
        const bars = this.bars;
        const last = bars[bars.length - 1];
        if (last !== undefined && ts < this.curEnd && ts >= last.t) {
          this.put(last, ts, px, qty, side, true, this.curEnd);
          return;
        }
        const t = this.bucket(ts, spec.ms);
        if (last === undefined || t > last.t) {
          const b = this.open(t, px);
          b.tEnd = ts;
          this.curEnd = this.endOf(t, spec.ms);
          this.put(b, ts, px, qty, side, true, this.curEnd);
        } else {
          this.put(last, ts, px, qty, side, true, this.curEnd);
        }
        return;
      }
      case 'heikin':
        return this.heikin(spec.ms, ts, px, qty, side);
      case 'range': {
        const last = this.last;
        if (!last || last.closed || Math.max(last.h, px) - Math.min(last.l, px) > spec.ticks) {
          const b = this.open(ts, px);
          this.put(b, ts, px, qty, side, true, ts + MAX_TAP_GAP_MS);
          return;
        }
        this.put(last, ts, px, qty, side, true, ts + MAX_TAP_GAP_MS);
        return;
      }
      case 'tick':
      case 'volume':
      case 'delta': {
        let bar = this.last;
        if (!bar || bar.closed) bar = this.open(ts, px);
        this.put(bar, ts, px, qty, side, true, ts + MAX_TAP_GAP_MS);
        if (
          (spec.kind === 'tick' && bar.trades >= spec.n) ||
          (spec.kind === 'volume' && bar.vol >= spec.n) ||
          (spec.kind === 'delta' && Math.abs(bar.delta) >= spec.n)
        )
          bar.closed = true;
        return;
      }
      case 'rangex':
        return this.rangeX(spec.ticks, ts, px, qty, side);
      case 'rangexv': {
        let b = this.last;
        if (!b || b.closed) b = this.open(ts, px);
        this.put(b, ts, px, qty, side, true, ts + MAX_TAP_GAP_MS);
        if (b.h - b.l >= spec.ticks && b.vol >= spec.vol) b.closed = true;
        return;
      }
      case 'rangez': {
        const last = this.last;
        let b = last;
        if (!b) b = this.open(ts, px);
        else if (b.closed || Math.max(b.h, px) - Math.min(b.l, px) > spec.ticks)
          b = this.open(ts, b.c);
        this.put(b, ts, px, qty, side, true, ts + MAX_TAP_GAP_MS);
        return;
      }
      case 'rangeus':
        return this.rangeUS(spec, ts, px, qty, side);
      case 'renko':
        return this.renko(spec.box, spec.wicks !== false, ts, px, qty, side);
      case 'reversal': {
        let b = this.last;
        if (!b || b.closed) b = this.open(ts, px);
        this.put(b, ts, px, qty, side, true, ts + MAX_TAP_GAP_MS);
        if (b.h - b.l >= spec.size) b.closed = true;
        else if (b.c >= b.o ? b.h - b.c >= spec.rev : b.c - b.l >= spec.rev) b.closed = true;
        return;
      }
      case 'orderflow':
        return this.orderFlow(Math.max(1, spec.n), ts, px, qty, side);
      case 'cumtrades':
        return this.cumTrades(spec.min, spec.max, ts, px, qty, side);
      case 'pnf':
        return this.pnf(Math.max(1, spec.box), Math.max(1, spec.reversal), ts, px, qty, side);
      case 'kagi':
        return this.kagi(Math.max(1, spec.rev), ts, px, qty, side);
      case 'linebreak':
        return this.lineBreak(Math.max(1, spec.lines), spec.ms, ts, px, qty, side);
    }
  }

  /** Bar open time for time-based types; daily bars start at the session open. */
  private bucket(ts: number, ms: number): number {
    const r = this.rules;
    if (r !== null && ms >= DAY) {
      const s = r.sessionStart(ts);
      return ms === DAY ? s : Math.floor(s / ms) * ms;
    }
    return Math.floor(ts / ms) * ms;
  }

  private endOf(t: number, ms: number): number {
    // Session-aligned daily bars re-check the session start on each print (DST-safe).
    if (this.rules !== null && ms >= DAY) return t + 1;
    return t + ms;
  }

  private heikin(ms: number, ts: number, px: number, qty: number, side: number): void {
    const st = this.st;
    const last = this.last;
    let b = last;
    if (!(b !== undefined && ts < this.curEnd && ts >= b.t)) {
      const t = this.bucket(ts, ms);
      if (b === undefined || t > b.t) {
        if (b) {
          st.po = b.o;
          st.pc = b.c;
        }
        b = this.open(t, px);
        this.curEnd = this.endOf(t, ms);
        st.ro = st.rh = st.rl = st.rc = px;
      }
    }
    this.put(b, ts, px, qty, side, false, this.curEnd);
    if (px > st.rh) st.rh = px;
    if (px < st.rl) st.rl = px;
    st.rc = px;
    const c = (st.ro + st.rh + st.rl + st.rc) / 4;
    const o = st.po === undefined ? (st.ro + st.rc) / 2 : (st.po + st.pc) / 2;
    b.o = o;
    b.c = c;
    b.h = Math.max(st.rh, o, c);
    b.l = Math.min(st.rl, o, c);
  }

  private rangeX(n: number, ts: number, px: number, qty: number, side: number): void {
    const cap = ts + MAX_TAP_GAP_MS;
    let b = this.last;
    if (!b || b.closed) {
      b = this.open(ts, px);
      this.put(b, ts, px, qty, side, true, cap);
      if (n <= 0) b.closed = true;
      return;
    }
    const hi = Math.max(b.h, px);
    const lo = Math.min(b.l, px);
    if (hi - lo <= n) {
      this.put(b, ts, px, qty, side, true, cap);
      if (hi - lo === n) b.closed = true;
      return;
    }
    // Beyond the boundary: the bar completes at exactly N ticks; the print opens the next bar.
    if (px > b.h) {
      b.h = b.l + n;
      b.c = b.h;
    } else {
      b.l = b.h - n;
      b.c = b.l;
    }
    b.closed = true;
    const nb = this.open(ts, px);
    this.put(nb, ts, px, qty, side, true, cap);
  }

  private rangeUS(
    spec: { trend: number; reversal: number; offset: number },
    ts: number,
    px: number,
    qty: number,
    side: number,
  ): void {
    const st = this.st;
    let b = this.last;
    if (!b || b.closed) {
      const o = b ? (st.next as number) : px;
      b = this.open(ts, o);
      if (!st.dir) st.dir = 0;
    }
    this.put(b, ts, px, qty, side, true, ts + MAX_TAP_GAP_MS);
    const upT = st.dir >= 0 ? spec.trend : spec.reversal;
    const dnT = st.dir <= 0 ? spec.trend : spec.reversal;
    let d = 0;
    if (b.c - b.o >= Math.max(1, upT)) d = 1;
    else if (b.o - b.c >= Math.max(1, dnT)) d = -1;
    if (d !== 0) {
      b.closed = true;
      b.dir = d;
      st.dir = d;
      st.next = b.c - d * spec.offset;
    }
  }

  private renko(box: number, wicks: boolean, ts: number, px: number, qty: number, side: number) {
    const st = this.st;
    box = Math.max(1, box);
    if (st.top === undefined) {
      st.top = st.bottom = st.lastClose = px;
    }
    let b = this.last;
    if (!b || b.closed) {
      // forming brick: opens at the last brick close; wicks are traded extremes only
      b = this.open(ts, st.lastClose);
      b.h = b.l = px;
    }
    this.put(b, ts, px, qty, side, true, ts + MAX_TAP_GAP_MS);
    let first = true;
    for (let k = 0; k < 10_000; k++) {
      let o: number;
      let c: number;
      let dir: number;
      if (px >= st.top + box) {
        o = st.top;
        c = st.top + box;
        st.bottom = o;
        st.top = c;
        dir = 1;
      } else if (px <= st.bottom - box) {
        o = st.bottom;
        c = st.bottom - box;
        st.top = o;
        st.bottom = c;
        dir = -1;
      } else break;
      const brick = first ? b : this.open(ts, o);
      brick.o = o;
      brick.c = c;
      brick.dir = dir;
      const top = Math.max(o, c);
      const bot = Math.min(o, c);
      if (first && wicks) {
        brick.h = Math.max(brick.h, top);
        brick.l = Math.min(brick.l, bot);
      } else {
        brick.h = top;
        brick.l = bot;
      }
      brick.closed = true;
      st.lastClose = c;
      first = false;
    }
  }

  private orderFlow(n: number, ts: number, px: number, qty: number, side: number): void {
    const st = this.st;
    let b = this.last;
    if (!b) {
      b = this.open(ts, px);
      st.side = side;
      st.cnt = 0;
    } else if (side !== 0 && st.side !== 0 && side !== st.side) {
      st.cnt++;
      if (st.cnt >= n) {
        b = this.open(ts, px);
        st.side = side;
        st.cnt = 0;
      }
    } else if (side !== 0 && side === st.side) st.cnt = 0;
    if (st.side === 0 && side !== 0) st.side = side;
    b.dir = st.side;
    this.put(b, ts, px, qty, side, true, ts + MAX_TAP_GAP_MS);
  }

  private cumTrades(min: number, max: number, ts: number, px: number, qty: number, side: number) {
    const st = this.st;
    const hi = max > 0 ? max : Infinity;
    let p: Bar | undefined = st.pend;
    if (!p || ts !== st.ts || side !== st.side) {
      if (p) p.closed = true;
      p = emptyBar(ts, px);
      st.pend = p;
      st.in = false;
      st.ts = ts;
      st.side = side;
    }
    this.put(p, ts, px, qty, side, true, ts + MAX_TAP_GAP_MS);
    p.dir = side;
    const ok = p.vol >= min && p.vol <= hi;
    if (ok && !st.in) {
      this.bars.push(p);
      st.in = true;
    } else if (!ok && st.in) {
      this.bars.pop();
      st.in = false;
    }
  }

  private pnf(B: number, R: number, ts: number, px: number, qty: number, side: number): void {
    const st = this.st;
    const up = Math.floor(px / B);
    const dn = Math.ceil(px / B);
    let b = this.last;
    if (!b) {
      st.top = st.bot = up;
      st.dir = 0;
      b = this.open(ts, up * B);
    } else if (st.dir === 0) {
      if (up > st.top) {
        st.dir = 1;
        st.top = up;
      } else if (dn < st.bot) {
        st.dir = -1;
        st.bot = dn;
      }
    } else if (st.dir === 1) {
      if (up > st.top) st.top = up;
      else if (dn <= st.top - R) {
        st.dir = -1;
        st.top = st.top - 1;
        st.bot = dn;
        b = this.open(ts, st.top * B);
      }
    } else {
      if (dn < st.bot) st.bot = dn;
      else if (up >= st.bot + R) {
        st.dir = 1;
        st.bot = st.bot + 1;
        st.top = up;
        b = this.open(ts, st.bot * B);
      }
    }
    this.put(b, ts, px, qty, side, false, ts + MAX_TAP_GAP_MS);
    b.dir = st.dir;
    if (st.dir === -1) {
      b.o = b.h = st.top * B;
      b.c = b.l = st.bot * B;
    } else {
      b.o = b.l = st.bot * B;
      b.c = b.h = st.top * B;
    }
  }

  private kagi(rev: number, ts: number, px: number, qty: number, side: number): void {
    const st = this.st;
    let b = this.last;
    const setFlip = (bar: Bar, level: number) => {
      bar.flip = level;
      st.yang = st.yang ? 0 : 1;
    };
    if (!b) {
      b = this.open(ts, px);
      st.dir = 0;
      st.ext = px;
      st.yang = 1;
      st.shoulder = Number.NaN;
      st.waist = Number.NaN;
      b.flip = Number.NaN;
    } else if (st.dir === 0) {
      if (px - b.o >= rev) {
        st.dir = 1;
        st.ext = px;
        st.yang = 1;
      } else if (b.o - px >= rev) {
        st.dir = -1;
        st.ext = px;
        st.yang = 0;
      }
      b.thick0 = st.yang;
    } else if (st.dir === 1) {
      if (px > st.ext) {
        st.ext = px;
        if (!st.yang && px > st.shoulder && Number.isNaN(b.flip!)) setFlip(b, st.shoulder);
      } else if (st.ext - px >= rev) {
        st.shoulder = st.ext;
        b = this.open(ts, st.ext);
        b.flip = Number.NaN;
        b.thick0 = st.yang;
        st.dir = -1;
        st.ext = px;
        if (st.yang && px < st.waist) setFlip(b, st.waist);
      }
    } else {
      if (px < st.ext) {
        st.ext = px;
        if (st.yang && px < st.waist && Number.isNaN(b.flip!)) setFlip(b, st.waist);
      } else if (px - st.ext >= rev) {
        st.waist = st.ext;
        b = this.open(ts, st.ext);
        b.flip = Number.NaN;
        b.thick0 = st.yang;
        st.dir = 1;
        st.ext = px;
        if (!st.yang && px > st.shoulder) setFlip(b, st.shoulder);
      }
    }
    this.put(b, ts, px, qty, side, false, ts + MAX_TAP_GAP_MS);
    if (b.thick0 === undefined) b.thick0 = st.yang;
    b.dir = st.dir;
    b.thick = st.yang;
    b.c = st.dir === 0 ? b.o : st.ext;
    b.h = Math.max(b.o, b.c);
    b.l = Math.min(b.o, b.c);
  }

  private lbEval(close: number): { o: number; c: number } | null {
    const st = this.st;
    const lines: { o: number; c: number }[] = st.lines;
    if (lines.length === 0) {
      if (close === st.base) return null;
      return { o: st.base, c: close };
    }
    const last = lines[lines.length - 1]!;
    const top = Math.max(last.o, last.c);
    const bot = Math.min(last.o, last.c);
    const lastUp = last.c > last.o;
    if (close > top) {
      if (lastUp) return { o: top, c: close };
      let hi = -Infinity;
      for (const l of lines) hi = Math.max(hi, l.o, l.c);
      return close > hi ? { o: top, c: close } : null;
    }
    if (close < bot) {
      if (!lastUp) return { o: bot, c: close };
      let lo = Infinity;
      for (const l of lines) lo = Math.min(lo, l.o, l.c);
      return close < lo ? { o: bot, c: close } : null;
    }
    return null;
  }

  private lbShape(b: Bar): void {
    const st = this.st;
    const lines: { o: number; c: number }[] = st.lines;
    const ref = lines.length ? lines[lines.length - 1]!.c : st.base;
    const ev = this.lbEval(st.close);
    b.o = ev ? ev.o : ref;
    b.c = ev ? ev.c : ref;
    b.h = Math.max(b.o, b.c);
    b.l = Math.min(b.o, b.c);
    b.dir = ev ? Math.sign(ev.c - ev.o) : 0;
  }

  private lineBreak(n: number, ms: number, ts: number, px: number, qty: number, side: number) {
    const st = this.st;
    if (!st.lines) {
      st.lines = [];
      st.base = px;
    }
    const p = Math.floor(ts / ms);
    if (st.p !== undefined && p > st.p) {
      // the previous period closed: commit its close
      const ev = this.lbEval(st.close);
      const fb = this.last;
      if (ev && fb && !fb.closed) {
        fb.o = ev.o;
        fb.c = ev.c;
        fb.h = Math.max(ev.o, ev.c);
        fb.l = Math.min(ev.o, ev.c);
        fb.dir = Math.sign(ev.c - ev.o);
        fb.closed = true;
        st.lines.push(ev);
        if (st.lines.length > n) st.lines.shift();
      }
    }
    if (st.p === undefined || p > st.p) st.p = p;
    st.close = px;
    let b = this.last;
    if (!b || b.closed) b = this.open(ts, px);
    this.put(b, ts, px, qty, side, false, ts + MAX_TAP_GAP_MS);
    this.lbShape(b);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type Row = { row: string; kind: BarKind; specs: BarSpec[] };

/** Default timeframe dialog rows (spec timeframe matrix). Users edit them via Configure. */
export const TIMEFRAME_PRESETS: Row[] = [
  {
    row: 'Minute',
    kind: 'time',
    specs: [1, 5, 10, 15, 30, 60, 240, 1440, 10080].map((m) => ({ kind: 'time', ms: m * 60_000 })),
  },
  {
    row: 'Seconds',
    kind: 'time',
    specs: [1, 5, 10, 15, 30].map((s) => ({ kind: 'time', ms: s * 1000 })),
  },
  { row: 'Tick', kind: 'tick', specs: [1, 50, 144, 500, 1500].map((n) => ({ kind: 'tick', n })) },
  {
    row: 'Volume',
    kind: 'volume',
    specs: [100, 300, 500, 1000].map((n) => ({ kind: 'volume', n })),
  },
  { row: 'Delta', kind: 'delta', specs: [500, 1000, 1500].map((n) => ({ kind: 'delta', n })) },
  { row: 'Range', kind: 'range', specs: [4, 8].map((ticks) => ({ kind: 'range', ticks })) },
  { row: 'Range X', kind: 'rangex', specs: [4, 5, 6].map((ticks) => ({ kind: 'rangex', ticks })) },
  {
    row: 'Range XV',
    kind: 'rangexv',
    specs: [4, 5, 6].map((ticks) => ({ kind: 'rangexv', ticks, vol: 100 })),
  },
  { row: 'Range Z', kind: 'rangez', specs: [4, 5, 6].map((ticks) => ({ kind: 'rangez', ticks })) },
  {
    row: 'Range US',
    kind: 'rangeus',
    specs: [{ kind: 'rangeus', offset: 0, trend: 2, reversal: 6 }],
  },
  { row: 'Renko', kind: 'renko', specs: [2, 4, 6].map((box) => ({ kind: 'renko', box })) },
  {
    row: 'Reversal',
    kind: 'reversal',
    specs: [
      { kind: 'reversal', size: 7, rev: 4 },
      { kind: 'reversal', size: 10, rev: 5 },
    ],
  },
  { row: 'Order Flow', kind: 'orderflow', specs: [{ kind: 'orderflow', n: 1 }] },
  {
    row: 'Cumulative Trades',
    kind: 'cumtrades',
    specs: [
      { kind: 'cumtrades', min: 0, max: 0 },
      { kind: 'cumtrades', min: 0, max: 100 },
      { kind: 'cumtrades', min: 100, max: 0 },
      { kind: 'cumtrades', min: 100, max: 10000 },
    ],
  },
  {
    row: 'Heikin-Ashi',
    kind: 'heikin',
    specs: [1, 5, 15, 60].map((m) => ({ kind: 'heikin', ms: m * 60_000 })),
  },
  {
    row: 'Point & Figure',
    kind: 'pnf',
    specs: [
      { kind: 'pnf', box: 2, reversal: 3 },
      { kind: 'pnf', box: 5, reversal: 3 },
      { kind: 'pnf', box: 10, reversal: 3 },
    ],
  },
  { row: 'Kagi', kind: 'kagi', specs: [4, 10, 20].map((rev) => ({ kind: 'kagi', rev })) },
  {
    row: 'Line Break',
    kind: 'linebreak',
    specs: [
      { kind: 'linebreak', lines: 3, ms: 60_000 },
      { kind: 'linebreak', lines: 3, ms: 300_000 },
    ],
  },
];

/** What a feed can supply; bar types that need missing data are greyed out in the dialog. */
export interface FeedCapabilities {
  /** Trades carry the aggressor side (bid / ask). */
  aggressor: boolean;
  /** Individual prints (not pre-aggregated bars). */
  ticks: boolean;
  /** Sub-second timestamps. */
  subSecond: boolean;
}

export const FULL_CAPABILITIES: FeedCapabilities = {
  aggressor: true,
  ticks: true,
  subSecond: true,
};

/** Why a bar spec cannot be built from this feed, or null when it can. */
export function specUnavailableReason(spec: BarSpec, caps: FeedCapabilities): string | null {
  if (!caps.ticks && spec.kind !== 'time' && spec.kind !== 'heikin')
    return 'Needs tick data — this feed only supplies bars';
  if (!caps.aggressor && (spec.kind === 'delta' || spec.kind === 'orderflow'))
    return 'Needs the aggressor side (bid / ask) — this feed does not supply it';
  if (!caps.subSecond && (spec.kind === 'time' || spec.kind === 'heikin') && spec.ms < 1000)
    return 'Needs sub-second timestamps';
  if (!caps.ticks && (spec.kind === 'time' || spec.kind === 'heikin') && spec.ms < 60_000)
    return 'Needs tick data for second bars';
  return null;
}

/** Feed capabilities inferred from the data itself (used when a feed declares none). */
export function inferCapabilities(trades: readonly Trade[]): FeedCapabilities {
  if (trades.length === 0) return FULL_CAPABILITIES;
  let known = 0;
  const n = Math.min(trades.length, 2000);
  for (let i = trades.length - n; i < trades.length; i++)
    if (trades[i]!.side !== 'unknown') known++;
  return { aggressor: known > 0, ticks: true, subSecond: true };
}
