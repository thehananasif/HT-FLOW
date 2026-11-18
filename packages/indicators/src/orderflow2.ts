import {
  HT,
  RESET_OPTIONS,
  defineIndicator,
  highest,
  input,
  isNewPeriod,
  lowest,
  output,
  periodStart,
  rma,
  sma,
  trueRange,
  type Marker,
  type ResetMode,
  type Zone,
} from '@htflow/indicator-sdk';
import {
  finishProfile,
  formatCompact,
  type Bar,
  type ProfileLevel,
  type Trade,
} from '@htflow/market-data';
import { pivotAt } from './trend2';

const of = { category: 'volume-orderflow' as const };
const NaN_ = Number.NaN;

// ------------------------------------------------------------------ Active Volume

export const ActiveVolume = defineIndicator({
  id: 'active-volume',
  name: 'Active Volume',
  short: 'Active Vol',
  ...of,
  pane: 'new',
  zeroLine: true,
  needsTrades: true,
  description:
    'Aggressive buy (at the ask) and sell (at the bid) volume per bar, counting only prints of at least the minimum size, mirrored around zero.',
  formula:
    'Buy = Σ qty of buy-aggressor prints ≥ min; Sell = −Σ qty of sell-aggressor prints ≥ min; Net = Buy + Sell',
  inputs: {
    min: input.float('Minimum print size', 0, {
      min: 0,
      max: 1e9,
      step: 1,
      help: '0 = all prints (uses the bar totals when no tape is available).',
    }),
  },
  outputs: {
    buy: output.histogram('Active buy', HT.up, { unit: 'volume', opacity: 0.8 }),
    sell: output.histogram('Active sell', HT.down, { unit: 'volume', opacity: 0.8 }),
    net: output.line('Net', HT.white, { unit: 'volume', width: 1 }),
  },
  title: (p) => `Active Volume ≥ ${p.min}`,
  calc(ctx) {
    const { min } = ctx.inputs;
    let buy = 0;
    let sell = 0;
    const tr = ctx.trades(ctx.i);
    if (tr.length === 0 && min === 0) {
      buy = ctx.bar.buy;
      sell = ctx.bar.sell;
    } else
      for (const t of tr) {
        if (t.qty < min) continue;
        if (t.side === 'buy') buy += t.qty;
        else if (t.side === 'sell') sell += t.qty;
      }
    ctx.out.buy.set(ctx.i, buy);
    ctx.out.sell.set(ctx.i, -sell, 1);
    ctx.out.net.set(ctx.i, buy - sell);
  },
});

// ------------------------------------------------------------------ Bars Volume Filter

export const BarsVolumeFilter = defineIndicator({
  id: 'bars-volume-filter',
  name: 'Bars Volume Filter',
  short: 'Bars Filter',
  ...of,
  pane: 'new',
  description:
    'Highlights bars whose volume, |delta| or trade count exceeds a threshold (absolute or a multiple of its moving average).',
  formula:
    'Metric ∈ {Vol, |Δ|, trades}; highlighted when Metric ≥ T (absolute) or Metric ≥ k·SMA(Metric, n)',
  inputs: {
    metric: input.enum('Metric', 'volume', [
      ['volume', 'Volume'],
      ['delta', '|Delta|'],
      ['trades', 'Trades'],
    ]),
    mode: input.enum('Threshold', 'relative', [
      ['relative', 'Multiple of the average'],
      ['absolute', 'Absolute value'],
    ]),
    value: input.float('Threshold', 2, {
      min: 0,
      max: 1e12,
      step: 0.1,
      help: 'Multiple (relative) or absolute metric value.',
    }),
    period: input.int('Average bars', 20, { min: 1, max: 1000 }),
  },
  outputs: {
    m: output.histogram('Metric', HT.grey, {
      color2: HT.warning,
      color3: HT.warning,
      opacity: 0.85,
      unit: 'volume',
    }),
    flag: output.dots('Above threshold', HT.warning, { width: 3, legend: false }),
  },
  title: (p) =>
    `Bars Filter ${p.metric} ${p.mode === 'relative' ? '≥ ' + p.value + '×' : '≥ ' + p.value}`,
  calc(ctx) {
    const b = ctx.bar;
    const v =
      ctx.inputs.metric === 'volume'
        ? b.vol
        : ctx.inputs.metric === 'delta'
          ? Math.abs(b.delta)
          : b.trades;
    const raw = ctx.buf('m');
    raw[ctx.i] = v;
    const thr =
      ctx.inputs.mode === 'relative'
        ? ctx.inputs.value * sma(raw, ctx.i - 1, ctx.inputs.period)
        : ctx.inputs.value;
    const hit = v >= thr;
    ctx.out.m.set(ctx.i, v, hit ? 1 : 0);
    if (hit) ctx.out.flag.set(ctx.i, v);
  },
});

// ------------------------------------------------------------------ Adaptive Big Trades

interface SizeWindow {
  sizes: number[];
}

export const AdaptiveBigTrades = defineIndicator({
  id: 'adaptive-big-trades',
  name: 'Adaptive Big Trades',
  short: 'Adaptive Big',
  ...of,
  pane: 'overlay',
  autoscale: false,
  needsTrades: true,
  description:
    'Bubbles for prints that are unusually large compared with the recent tape: threshold = mean + k·σ (or a percentile) of the last N print sizes.',
  formula:
    'T = μ + k·σ over the last N prints (σ mode) or the p-th percentile (percentile mode); bubble when qty ≥ T',
  inputs: {
    mode: input.enum('Threshold', 'sigma', [
      ['sigma', 'Mean + k·σ'],
      ['percentile', 'Percentile'],
    ]),
    k: input.float('k (σ) / percentile', 3, {
      min: 0.1,
      max: 99.99,
      step: 0.1,
      help: 'σ multiple, or percentile (e.g. 99).',
    }),
    window: input.int('Prints in the window', 500, { min: 20, max: 20000 }),
    maxSize: input.int('Max bubble size', 24, { min: 4, max: 80, unit: 'px' }),
  },
  outputs: { bubbles: output.markers('Bubbles', HT.up, { color2: HT.down }) },
  title: (p) => `Adaptive Big ${p.mode === 'sigma' ? 'μ+' + p.k + 'σ' : 'P' + p.k}`,
  init: (): SizeWindow => ({ sizes: [] }),
  calc(ctx) {
    const s = ctx.state as SizeWindow;
    const { mode, k, window, maxSize } = ctx.inputs;
    const tr = ctx.trades(ctx.i);
    let thr = Infinity;
    const n = s.sizes.length;
    if (n >= Math.min(20, window)) {
      if (mode === 'sigma') {
        let m = 0;
        for (const x of s.sizes) m += x;
        m /= n;
        let v = 0;
        for (const x of s.sizes) v += (x - m) ** 2;
        thr = m + k * Math.sqrt(v / n);
      } else {
        const sorted = [...s.sizes].sort((a, b) => a - b);
        thr = sorted[Math.min(n - 1, Math.floor((k / 100) * n))]!;
      }
    }
    for (const t of tr) {
      if (t.qty >= thr && t.side !== 'unknown')
        ctx.out.bubbles.add({
          bar: ctx.i,
          value: t.px,
          shape: 'circle',
          size: Math.min(maxSize, 3 + 3 * Math.sqrt(t.qty / thr)),
          tone: t.side === 'buy' ? 0 : 1,
          text: formatCompact(t.qty),
          textPos: 'center',
        } satisfies Marker);
    }
    if (ctx.final) {
      for (const t of tr) s.sizes.push(t.qty);
      if (s.sizes.length > window) s.sizes.splice(0, s.sizes.length - window);
    }
  },
});

// ------------------------------------------------------------------ Cumulative Delta Volume

export const CumulativeDeltaVolume = defineIndicator({
  id: 'cumulative-delta-volume',
  name: 'Cumulative Delta Volume',
  short: 'CDV',
  ...of,
  pane: 'new',
  zeroLine: true,
  description:
    'Cumulative delta in which every bar contributes its delta ratio weighted by how large its volume is relative to normal (volume bucket).',
  formula: 'w = min(Vol / SMA(Vol, n), cap); CDV = CDV₋₁ + (Δ / Vol)·w·100 (0 at reset)',
  inputs: {
    period: input.int('Volume average bars', 20, { min: 1, max: 1000 }),
    cap: input.float('Weight cap', 3, { min: 1, max: 20, step: 0.5 }),
    reset: input.enum('Reset', 'session', RESET_OPTIONS),
  },
  outputs: { cdv: output.line('CDV', HT.info, { unit: 'value' }) },
  title: (p) => `CDV ${p.period} (${p.reset})`,
  calc(ctx) {
    const { i, bar } = ctx;
    const o = ctx.out.cdv.v;
    const reset = i === 0 || isNewPeriod(ctx.bars[i - 1]!.t, bar.t, ctx.inputs.reset as ResetMode);
    const avg = sma(ctx.src('volume'), i, ctx.inputs.period);
    const w = avg > 0 ? Math.min(bar.vol / avg, ctx.inputs.cap) : 1;
    const step = bar.vol > 0 ? (bar.delta / bar.vol) * w * 100 : 0;
    o[i] = (reset || i === 0 ? 0 : o[i - 1]!) + step;
  },
});

// ------------------------------------------------------------------ Cumulative Daily Volume

interface DayProfile {
  keys: number[];
  cum: number[];
}
interface CdvState {
  day: number;
  keys: number[];
  cum: number[];
  total: number;
  history: DayProfile[];
}

function cumAt(p: DayProfile, key: number): number {
  let lo = 0;
  let hi = p.keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p.keys[mid]! <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? p.cum[lo - 1]! : 0;
}

export const CumulativeDailyVolume = defineIndicator({
  id: 'cumulative-daily-volume',
  name: 'Cumulative Daily Volume',
  short: 'Cum Day Vol',
  ...of,
  pane: 'new',
  description:
    'Volume accumulated since the start of the UTC day compared with the average accumulation at the same time of day over previous days.',
  formula:
    'Cum = Σ Vol since 00:00 UTC; Avg(t) = mean over the last N days of Cum at the same time of day',
  inputs: { days: input.int('Days in the average', 20, { min: 1, max: 250 }) },
  outputs: {
    cum: output.line('Cumulative volume', HT.info, { unit: 'volume' }),
    avg: output.line('Average profile', HT.warning, { unit: 'volume', style: 'dashed', width: 1 }),
  },
  title: (p) => `Cum Daily Volume ${p.days}d`,
  init: (): CdvState => ({ day: NaN_, keys: [], cum: [], total: 0, history: [] }),
  calc(ctx) {
    const s = ctx.state as CdvState;
    const d = periodStart(ctx.bar.t, 'D');
    if (d !== s.day) {
      // New day (idempotent: a recompute of this bar sees the new day already).
      if (s.keys.length) {
        s.history.push({ keys: s.keys, cum: s.cum });
        if (s.history.length > ctx.inputs.days) s.history.shift();
      }
      s.day = d;
      s.keys = [];
      s.cum = [];
      s.total = 0;
    }
    const key = ctx.bar.t - d;
    const cum = s.total + ctx.bar.vol;
    ctx.out.cum.set(ctx.i, cum);
    if (s.history.length) {
      let a = 0;
      for (const h of s.history) a += cumAt(h, key);
      ctx.out.avg.set(ctx.i, a / s.history.length);
    }
    if (ctx.final) {
      s.total = cum;
      s.keys.push(key);
      s.cum.push(cum);
    }
  },
});

// ------------------------------------------------------------------ Dynamic Levels Channel

interface RollState {
  levels: Map<number, ProfileLevel>;
  total: number;
  buy: number;
  sell: number;
  q: Bar[];
}

function addBarTo(s: RollState, b: Bar, sign: 1 | -1): void {
  for (const [px, c] of b.clusters) {
    let l = s.levels.get(px);
    if (!l) {
      l = { vol: 0, buy: 0, sell: 0 };
      s.levels.set(px, l);
    }
    l.vol += sign * (c.bid + c.ask);
    l.buy += sign * c.ask;
    l.sell += sign * c.bid;
    if (l.vol <= 1e-12 && sign < 0) s.levels.delete(px);
    s.total += sign * (c.bid + c.ask);
    s.buy += sign * c.ask;
    s.sell += sign * c.bid;
  }
}

export const DynamicLevelsChannel = defineIndicator({
  id: 'dynamic-levels-channel',
  name: 'Dynamic Levels Channel',
  short: 'DL Channel',
  ...of,
  pane: 'overlay',
  autoscale: false,
  description:
    'Value-area channel (VAH / POC / VAL) of the volume profile of the last N bars, rolling bar by bar.',
  formula:
    'Profile of the last N bars; POC = max-volume price; VA = pct of volume expanded from the POC',
  inputs: {
    bars: input.int('Rolling bars', 50, { min: 2, max: 2000 }),
    va: input.int('Value area', 70, { min: 10, max: 99, unit: '%' }),
  },
  outputs: {
    vah: output.line('VAH', HT.info, { unit: 'price', width: 1, style: 'dashed' }),
    poc: output.line('POC', HT.warning, { unit: 'price', width: 1.5 }),
    val: output.line('VAL', HT.info, { unit: 'price', width: 1, style: 'dashed' }),
  },
  title: (p) => `DL Channel ${p.bars} VA ${p.va}%`,
  init: (): RollState => ({ levels: new Map(), total: 0, buy: 0, sell: 0, q: [] }),
  calc(ctx) {
    const s = ctx.state as RollState;
    const n = ctx.inputs.bars;
    addBarTo(s, ctx.bar, 1);
    const r = finishProfile(s.levels, s.total, s.buy, s.sell, ctx.inputs.va / 100);
    ctx.out.poc.set(ctx.i, r.poc);
    ctx.out.vah.set(ctx.i, r.vah);
    ctx.out.val.set(ctx.i, r.val);
    if (ctx.final) {
      s.q.push(ctx.bar);
      if (s.q.length > n - 1) addBarTo(s, s.q.shift()!, -1);
    } else addBarTo(s, ctx.bar, -1);
  },
});

// ------------------------------------------------------------------ Order Flow (tape on chart) & Time & Sales Filter

function tapeDots(
  id: string,
  name: string,
  short: string,
  description: string,
  withFilters: boolean,
) {
  return defineIndicator({
    id,
    name,
    short,
    ...of,
    pane: 'overlay' as const,
    autoscale: false,
    needsTrades: true,
    description,
    formula: 'One marker per print (largest first, capped per bar); radius ∝ √(qty / reference)',
    inputs: {
      min: input.float('Minimum size', 0, { min: 0, max: 1e9, step: 1 }),
      max: input.float('Maximum size', 0, { min: 0, max: 1e9, step: 1, help: '0 = no maximum.' }),
      side: input.enum('Side', 'both', [
        ['both', 'Buy and sell'],
        ['buy', 'Buy (at ask)'],
        ['sell', 'Sell (at bid)'],
      ]),
      cap: input.int('Max prints per bar', 100, { min: 1, max: 2000 }),
      ref: input.float('Reference size', 10, {
        min: 0.0001,
        max: 1e9,
        step: 1,
        help: 'A print of this size has a default bubble.',
      }),
      label: input.bool('Show size', withFilters),
    },
    outputs: { dots: output.markers('Prints', HT.up, { color2: HT.down }) },
    title: (p) => `${short}${p.min ? ' ≥ ' + p.min : ''}${p.side === 'both' ? '' : ' ' + p.side}`,
    calc(ctx) {
      const { min, max, side, cap, ref, label } = ctx.inputs;
      const list: Trade[] = [];
      for (const t of ctx.trades(ctx.i)) {
        if (t.side === 'unknown' || t.qty < min || (max > 0 && t.qty > max)) continue;
        if (side !== 'both' && t.side !== side) continue;
        list.push(t);
      }
      if (list.length > cap) list.sort((a, b) => b.qty - a.qty).length = cap;
      for (const t of list)
        ctx.out.dots.add({
          bar: ctx.i,
          value: t.px,
          shape: 'circle',
          size: Math.min(30, Math.max(1.5, 3 * Math.sqrt(t.qty / ref))),
          tone: t.side === 'buy' ? 0 : 1,
          text: label ? formatCompact(t.qty) : undefined,
          textPos: 'center',
        } satisfies Marker);
    },
  });
}

export const OrderFlowTape = tapeDots(
  'order-flow-tape',
  'Order Flow',
  'Order Flow',
  'Tape on the chart: one dot per print, sized by volume, coloured by aggressor.',
  false,
);
export const TimeSalesFilter = tapeDots(
  'time-sales-filter',
  'Time & Sales Filter',
  'T&S Filter',
  'On-chart markers for prints passing a size and side filter, labelled with their size.',
  true,
);

// ------------------------------------------------------------------ Tape Patterns

export const TapePatterns = defineIndicator({
  id: 'tape-patterns',
  name: 'Tape Patterns',
  short: 'Tape Patterns',
  ...of,
  pane: 'overlay',
  autoscale: false,
  needsTrades: true,
  description:
    'Detects repeating prints typical of algos and iceberg refills: runs of same-side prints of (nearly) equal size at regular intervals.',
  formula:
    'Run: ≥ N consecutive same-side prints with |qty − qty₀| ≤ tol·qty₀ and gaps within jitter of their mean',
  inputs: {
    repeats: input.int('Minimum repeats', 5, { min: 3, max: 200 }),
    tol: input.float('Size tolerance', 5, { min: 0, max: 100, step: 1, unit: '%' }),
    jitter: input.int('Interval jitter', 50, {
      min: 0,
      max: 5000,
      unit: 'ms',
      help: "Maximum deviation of each gap from the run's mean gap.",
    }),
    minSize: input.float('Minimum print size', 0, { min: 0, max: 1e9, step: 1 }),
  },
  outputs: { runs: output.markers('Patterns', HT.warning, { color2: HT.down }) },
  title: (p) => `Tape Patterns ≥${p.repeats}×`,
  calc(ctx) {
    const { repeats, tol, jitter, minSize } = ctx.inputs;
    const tr = ctx.trades(ctx.i).filter((t) => t.side !== 'unknown' && t.qty >= minSize);
    let k = 0;
    while (k < tr.length) {
      const t0 = tr[k]!;
      let j = k + 1;
      while (
        j < tr.length &&
        tr[j]!.side === t0.side &&
        Math.abs(tr[j]!.qty - t0.qty) <= (tol / 100) * t0.qty
      )
        j++;
      const len = j - k;
      if (len >= repeats) {
        const gaps: number[] = [];
        for (let g = k + 1; g < j; g++) gaps.push(tr[g]!.ts - tr[g - 1]!.ts);
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        if (gaps.every((g) => Math.abs(g - mean) <= jitter)) {
          let pv = 0;
          for (let g = k; g < j; g++) pv += tr[g]!.px;
          ctx.out.runs.add({
            bar: ctx.i,
            value: pv / len,
            shape: 'diamond',
            size: 6,
            tone: t0.side === 'buy' ? 0 : 1,
            text: `${len}×${formatCompact(t0.qty)}`,
            textPos: 'right',
          } satisfies Marker);
        }
      }
      k = j;
    }
  },
});

// ------------------------------------------------------------------ Bars Pattern

export const BarsPattern = defineIndicator({
  id: 'bars-pattern',
  name: 'Bars Pattern',
  short: 'Bars Pattern',
  ...of,
  pane: 'overlay',
  autoscale: false,
  description:
    'Flags order-flow bar patterns: absorption (heavy volume, little progress), exhaustion (a new extreme with opposing delta) and unfinished auctions (both sides traded at the bar extreme).',
  formula:
    'Absorption: Vol ≥ k·SMA(Vol) and range ≤ r·ATR; Exhaustion: new n-bar high with Δ/Vol ≤ −x (low: ≥ +x); Unfinished: bid > 0 and ask > 0 at the high / low tick',
  inputs: {
    absorption: input.bool('Absorption', true),
    exhaustion: input.bool('Exhaustion', true),
    unfinished: input.bool('Unfinished auction', true),
    period: input.int('Average bars', 20, { min: 2, max: 500 }),
    volMult: input.float('Absorption volume ×', 2, { min: 1, max: 20, step: 0.1 }),
    rangeMult: input.float('Absorption max range (× ATR)', 0.8, { min: 0.1, max: 10, step: 0.1 }),
    n: input.int('Exhaustion extreme bars', 10, { min: 2, max: 500 }),
    ratio: input.float('Exhaustion delta ratio', 0.1, { min: 0, max: 1, step: 0.05 }),
  },
  outputs: {
    absorption: output.markers('Absorption', HT.special),
    exhaustion: output.markers('Exhaustion', HT.warning, { color2: HT.warning }),
    unfinished: output.markers('Unfinished', HT.grey),
  },
  title: () => 'Bars Pattern',
  calc(ctx) {
    const { i, bar: b } = ctx;
    const { period, volMult, rangeMult, n, ratio } = ctx.inputs;
    const tr = ctx.buf('tr');
    tr[i] = trueRange(b.h, b.l, i > 0 ? ctx.bars[i - 1]!.c : NaN_);
    const atr = ctx.buf('atr');
    atr[i] = rma(atr, tr, i, period);
    const vol = ctx.src('volume');
    const avg = sma(vol, i - 1, period);
    if (
      ctx.inputs.absorption &&
      avg > 0 &&
      atr[i]! > 0 &&
      b.vol >= volMult * avg &&
      b.h - b.l <= rangeMult * atr[i]!
    )
      ctx.out.absorption.add({
        bar: i,
        value: b.delta >= 0 ? b.l : b.h,
        shape: 'text',
        size: 0,
        text: 'ABS',
        tone: 0,
        textPos: b.delta >= 0 ? 'below' : 'above',
      } satisfies Marker);
    if (ctx.inputs.exhaustion && i >= n && b.vol > 0) {
      const hh = highest(ctx.src('high'), i, n);
      const ll = lowest(ctx.src('low'), i, n);
      if (b.h >= hh && b.delta / b.vol <= -ratio)
        ctx.out.exhaustion.add({
          bar: i,
          value: b.h,
          shape: 'text',
          size: 0,
          text: 'EXH',
          tone: 0,
          textPos: 'above',
        } satisfies Marker);
      else if (b.l <= ll && b.delta / b.vol >= ratio)
        ctx.out.exhaustion.add({
          bar: i,
          value: b.l,
          shape: 'text',
          size: 0,
          text: 'EXH',
          tone: 1,
          textPos: 'below',
        } satisfies Marker);
    }
    if (ctx.inputs.unfinished) {
      const ch = b.clusters.get(b.h);
      const cl = b.clusters.get(b.l);
      if (ch && ch.bid > 0 && ch.ask > 0)
        ctx.out.unfinished.add({
          bar: i,
          value: b.h,
          shape: 'text',
          size: 0,
          text: 'U',
          tone: 0,
          textPos: 'above',
        } satisfies Marker);
      if (cl && cl.bid > 0 && cl.ask > 0)
        ctx.out.unfinished.add({
          bar: i,
          value: b.l,
          shape: 'text',
          size: 0,
          text: 'U',
          tone: 0,
          textPos: 'below',
        } satisfies Marker);
    }
  },
});

// ------------------------------------------------------------------ Cluster Search

export const ClusterSearch = defineIndicator({
  id: 'cluster-search',
  name: 'Cluster Search',
  short: 'Cluster Search',
  ...of,
  pane: 'overlay',
  autoscale: false,
  description:
    'Finds price clusters (footprint cells) matching rules and marks them: minimum volume, delta sign / size and position in the bar.',
  formula:
    'Match: Vol(p) ≥ minVol, Δ(p) = ask − bid satisfies the delta rule, p within N ticks of the bar high / low / at the POC',
  inputs: {
    minVol: input.float('Minimum cluster volume', 50, { min: 0, max: 1e12, step: 1 }),
    delta: input.enum('Delta', 'any', [
      ['any', 'Any'],
      ['positive', 'Positive'],
      ['negative', 'Negative'],
    ]),
    minDelta: input.float('Minimum |delta|', 0, { min: 0, max: 1e12, step: 1 }),
    where: input.enum('Position', 'any', [
      ['any', 'Anywhere in the bar'],
      ['high', 'At the high'],
      ['low', 'At the low'],
      ['extreme', 'At the high or low'],
      ['poc', 'At the bar POC'],
    ]),
    ticks: input.int('Ticks from the extreme', 1, { min: 0, max: 1000 }),
    cap: input.int('Max marks per bar', 5, { min: 1, max: 100 }),
  },
  outputs: { hits: output.markers('Clusters', HT.up, { color2: HT.down }) },
  title: (p) => `Cluster Search ≥${p.minVol} ${p.where}`,
  calc(ctx) {
    const { minVol, delta, minDelta, where, ticks, cap } = ctx.inputs;
    const b = ctx.bar;
    let pocPx = NaN_;
    if (where === 'poc') {
      let mv = -1;
      for (const [px, c] of b.clusters)
        if (c.bid + c.ask > mv) {
          mv = c.bid + c.ask;
          pocPx = px;
        }
    }
    const found: { px: number; vol: number; d: number }[] = [];
    for (const [px, c] of b.clusters) {
      const vol = c.bid + c.ask;
      const d = c.ask - c.bid;
      if (vol < minVol || Math.abs(d) < minDelta) continue;
      if (delta === 'positive' && d <= 0) continue;
      if (delta === 'negative' && d >= 0) continue;
      const nearHi = b.h - px <= ticks;
      const nearLo = px - b.l <= ticks;
      if (where === 'high' && !nearHi) continue;
      if (where === 'low' && !nearLo) continue;
      if (where === 'extreme' && !nearHi && !nearLo) continue;
      if (where === 'poc' && px !== pocPx) continue;
      found.push({ px, vol, d });
    }
    found.sort((a, c) => c.vol - a.vol);
    for (const f of found.slice(0, cap))
      ctx.out.hits.add({
        bar: ctx.i,
        value: f.px,
        shape: 'square',
        size: 4,
        tone: f.d >= 0 ? 0 : 1,
        text: formatCompact(f.vol),
        textPos: 'right',
      } satisfies Marker);
  },
});

// ------------------------------------------------------------------ Cluster Statistic (grid)

const STATS = [
  ['volume', 'Volume'],
  ['delta', 'Delta'],
  ['deltaPct', 'Delta %'],
  ['trades', 'Trades'],
  ['range', 'Range (ticks)'],
  ['poc', 'POC'],
] as const;
type StatId = (typeof STATS)[number][0];
const STAT_OPTS = [...STATS, ['none', 'None'] as const] as const;

function statOf(b: Bar, id: StatId): { text: string; tone: number } {
  switch (id) {
    case 'volume':
      return { text: formatCompact(b.vol), tone: 0 };
    case 'delta':
      return { text: formatCompact(b.delta), tone: b.delta >= 0 ? 1 : 2 };
    case 'deltaPct':
      return {
        text: b.vol > 0 ? `${((100 * b.delta) / b.vol).toFixed(0)}%` : '–',
        tone: b.delta >= 0 ? 1 : 2,
      };
    case 'trades':
      return { text: formatCompact(b.trades), tone: 0 };
    case 'range':
      return { text: String(Math.round(b.h - b.l)), tone: 0 };
    case 'poc': {
      let mv = -1;
      let px = b.c;
      for (const [p, c] of b.clusters)
        if (c.bid + c.ask > mv) {
          mv = c.bid + c.ask;
          px = p;
        }
      return { text: String(px), tone: 0 };
    }
  }
}

export const ClusterStatistic = defineIndicator({
  id: 'cluster-statistic',
  name: 'Cluster Statistic',
  short: 'Cluster Stat',
  ...of,
  listsAppendOnly: true,
  pane: 'new',
  range: [0, 5],
  description:
    'A grid under the chart: one row per statistic (volume, delta, delta %, trades, range, POC), one column per bar.',
  formula:
    'Row r shows stat_r(bar): Σ qty, Δ = ask − bid, 100·Δ/Vol, trade count, (H − L) in ticks, max-volume price',
  inputs: {
    r1: input.enum('Row 1', 'volume', STAT_OPTS),
    r2: input.enum('Row 2', 'delta', STAT_OPTS),
    r3: input.enum('Row 3', 'deltaPct', STAT_OPTS),
    r4: input.enum('Row 4', 'trades', STAT_OPTS),
  },
  outputs: {
    grid: output.markers('Grid', HT.soft, { color2: HT.up, color3: HT.down, legend: false }),
  },
  title: () => 'Cluster Statistic',
  calc(ctx) {
    const rows = [ctx.inputs.r1, ctx.inputs.r2, ctx.inputs.r3, ctx.inputs.r4];
    rows.forEach((r, k) => {
      if (r === 'none') return;
      const s = statOf(ctx.bar, r as StatId);
      ctx.out.grid.add({
        bar: ctx.i,
        value: 4.5 - k,
        shape: 'text',
        size: 0,
        text: s.text,
        tone: s.tone,
        textPos: 'center',
      } satisfies Marker);
    });
  },
});

// ------------------------------------------------------------------ Color Bar High Low / Open Close

export const ColorBarHighLow = defineIndicator({
  id: 'color-bar-high-low',
  name: 'Color Bar High Low',
  short: 'Bar H/L',
  ...of,
  pane: 'overlay',
  description:
    'Recolours bars that make a new n-bar high (up colour) or new n-bar low (down colour); other bars are dimmed.',
  formula: 'High bar: H ≥ HH(n); low bar: L ≤ LL(n); otherwise neutral',
  inputs: { n: input.int('Lookback bars', 20, { min: 2, max: 1000 }) },
  outputs: { bars: output.bars('Bars', HT.up, { color2: HT.down, color3: HT.dim, legend: false }) },
  title: (p) => `Color Bar H/L ${p.n}`,
  calc(ctx) {
    const { i, bar: b } = ctx;
    const n = ctx.inputs.n;
    if (i < n - 1) return;
    const up = b.h >= highest(ctx.src('high'), i, n);
    const dn = b.l <= lowest(ctx.src('low'), i, n);
    ctx.out.bars.setBar(i, b.o, b.h, b.l, b.c, up && !dn ? 0 : dn && !up ? 1 : 2);
  },
});

export const ColorBarOpenClose = defineIndicator({
  id: 'color-bar-open-close',
  name: 'Color Bar Open Close',
  short: 'Bar O/C',
  ...of,
  pane: 'overlay',
  description:
    'Recolours bars by body direction; weak bodies (smaller than a fraction of the ATR) are dimmed.',
  formula: 'Strong bull: C − O ≥ k·ATR; strong bear: O − C ≥ k·ATR; otherwise neutral',
  inputs: {
    period: input.int('ATR period', 14, { min: 1, max: 500 }),
    k: input.float('Strength (× ATR)', 0.5, { min: 0, max: 10, step: 0.1 }),
  },
  outputs: { bars: output.bars('Bars', HT.up, { color2: HT.down, color3: HT.dim, legend: false }) },
  title: (p) => `Color Bar O/C ${p.period} ${p.k}`,
  calc(ctx) {
    const { i, bar: b } = ctx;
    const tr = ctx.buf('tr');
    tr[i] = trueRange(b.h, b.l, i > 0 ? ctx.bars[i - 1]!.c : NaN_);
    const atr = ctx.buf('atr');
    atr[i] = rma(atr, tr, i, ctx.inputs.period);
    if (Number.isNaN(atr[i]!)) return;
    const body = b.c - b.o;
    const strong = Math.abs(body) >= ctx.inputs.k * atr[i]!;
    ctx.out.bars.setBar(i, b.o, b.h, b.l, b.c, !strong ? 2 : body > 0 ? 0 : 1);
  },
});

// ------------------------------------------------------------------ Support and Resistance Zones

export const SupportResistanceZones = defineIndicator({
  id: 'sr-zones',
  name: 'Support and Resistance Zones',
  short: 'S/R Zones',
  ...of,
  pane: 'overlay',
  autoscale: false,
  description:
    'Zones around confirmed swing highs / lows, optionally only where the swing bar had high volume (a volume node). A zone ends when price closes through it.',
  formula:
    'Zone = swing price ± w·ATR; kept if Vol(swing bar) ≥ k·SMA(Vol); overlapping same-side zones are merged; broken by a close beyond it',
  inputs: {
    n: input.int('Swing bars each side', 5, { min: 1, max: 50 }),
    width: input.float('Half-width (× ATR)', 0.25, { min: 0.01, max: 5, step: 0.05 }),
    period: input.int('ATR / volume average bars', 14, { min: 2, max: 500 }),
    volMult: input.float('Min swing-bar volume (× average)', 0, {
      min: 0,
      max: 20,
      step: 0.1,
      help: '0 = every swing; 1.5 = only high-volume nodes.',
    }),
    maxBars: input.int('Max zone length (bars)', 500, { min: 1, max: 100000 }),
  },
  outputs: { zones: output.zones('Zones', HT.up, { color2: HT.down, opacity: 0.2 }) },
  title: (p) => `S/R Zones ${p.n}`,
  calc(ctx) {
    const { n, width, period, volMult, maxBars } = ctx.inputs;
    const { i, bar: b } = ctx;
    const tr = ctx.buf('tr');
    tr[i] = trueRange(b.h, b.l, i > 0 ? ctx.bars[i - 1]!.c : NaN_);
    const atr = ctx.buf('atr');
    atr[i] = rma(atr, tr, i, period);
    for (const z of ctx.out.zones.items) {
      if (z.to >= 0 && z.to < i) continue;
      if (z.bar >= i) continue;
      const broken = z.tone === 1 ? b.c > z.top : b.c < z.bottom;
      z.to = broken || i - z.bar >= maxBars ? i : -1;
    }
    const j = i - n;
    if (j < n) return;
    const pv = pivotAt(ctx.src('high'), ctx.src('low'), j, n, n);
    const vol = ctx.src('volume');
    const avg = sma(vol, j, period);
    if (volMult > 0 && !(vol[j]! >= volMult * avg)) return;
    const half = width * atr[i]!;
    if (Number.isNaN(half)) return;
    const add = (price: number, tone: number) => {
      const top = price + half;
      const bottom = price - half;
      for (const z of ctx.out.zones.items)
        if (z.tone === tone && (z.to < 0 || z.to >= i) && z.bottom <= top && z.top >= bottom)
          return;
      ctx.out.zones.add({ bar: j, to: -1, top, bottom, tone } satisfies Zone);
    };
    if (pv.high) add(ctx.bars[j]!.h, 1);
    if (pv.low) add(ctx.bars[j]!.l, 0);
  },
});
