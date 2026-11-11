import {
  HT,
  RESET_OPTIONS,
  defineIndicator,
  input,
  isNewPeriod,
  output,
  periodStart,
  sma,
  type ResetMode,
  type TimeframeId,
} from '@htflow/indicator-sdk';
import { finishProfile, formatCompact, type Bar, type ProfileLevel } from '@htflow/market-data';
import { MA_TYPES, maAt } from './common';

const of = { category: 'volume-orderflow' as const };
const NaN_ = Number.NaN;

export const Volume = defineIndicator({
  id: 'volume',
  name: 'Volume',
  short: 'Vol',
  ...of,
  pane: 'new',
  description: 'Bar volume coloured by candle direction or by delta sign, with a moving average.',
  formula: 'Vol = Σ trade qty; MA = SMA(Vol, n)',
  inputs: {
    color: input.enum('Colour by', 'direction', [
      ['direction', 'Candle direction'],
      ['delta', 'Delta sign'],
    ]),
    ma: input.int('MA period', 20, { min: 1, max: 500 }),
  },
  outputs: {
    vol: output.histogram('Volume', HT.up, { color2: HT.down, opacity: 0.55, unit: 'volume' }),
    ma: output.line('MA', HT.soft, { unit: 'volume', width: 1 }),
  },
  title: (p) => `Volume (${p.color === 'delta' ? 'Δ' : 'dir'}) MA ${p.ma}`,
  calc(ctx) {
    const b = ctx.bar;
    const up = ctx.inputs.color === 'delta' ? b.delta >= 0 : b.c >= b.o;
    ctx.out.vol.set(ctx.i, b.vol, up ? 0 : 1);
    ctx.out.ma.set(ctx.i, sma(ctx.src('volume'), ctx.i, ctx.inputs.ma));
  },
});

export const Delta = defineIndicator({
  id: 'delta',
  name: 'Delta',
  short: 'Delta',
  ...of,
  pane: 'new',
  zeroLine: true,
  description: 'Bar delta (ask − bid volume) histogram with max / min intrabar delta wicks.',
  formula: 'Δ = Σask − Σbid; wick = [min Δ, max Δ] during the bar',
  inputs: { wicks: input.bool('Show max/min delta wicks', true) },
  outputs: { delta: output.histogram('Delta', HT.up, { color2: HT.down, unit: 'volume' }) },
  calc(ctx) {
    const b = ctx.bar;
    ctx.out.delta.set(ctx.i, b.delta, b.delta >= 0 ? 0 : 1);
    if (ctx.inputs.wicks) ctx.out.delta.setPair(ctx.i, b.maxDelta, b.minDelta);
  },
});

export const CumulativeDelta = defineIndicator({
  id: 'cumulative-delta',
  name: 'Cumulative Delta',
  short: 'CVD',
  ...of,
  pane: 'new',
  zeroLine: true,
  description:
    'Running sum of bar delta as candles or a line, reset per session, week, month or never.',
  formula: 'CVD = CVD₋₁ + Δ (0 at reset); candle O = CVD₋₁, H/L = O + max/min Δ, C = CVD',
  inputs: {
    mode: input.enum('Display', 'candles', [
      ['candles', 'Candles'],
      ['line', 'Line'],
    ]),
    reset: input.enum('Reset', 'session', RESET_OPTIONS),
  },
  outputs: {
    candles: output.bars('CVD', HT.up, { color2: HT.down, unit: 'volume' }),
    line: output.line('CVD line', HT.info, { unit: 'volume' }),
  },
  title: (p) => `CVD ${p.mode} · reset ${p.reset}`,
  calc(ctx) {
    const { i, bar } = ctx;
    const cum = ctx.buf('cum');
    const reset = i === 0 || isNewPeriod(ctx.bars[i - 1]!.t, bar.t, ctx.inputs.reset as ResetMode);
    const o = reset ? 0 : cum[i - 1]!;
    cum[i] = o + bar.delta;
    if (ctx.inputs.mode === 'candles')
      ctx.out.candles.setBar(i, o, o + bar.maxDelta, o + bar.minDelta, cum[i]!);
    else ctx.out.line.set(i, cum[i]!);
  },
});

export const BidAsk = defineIndicator({
  id: 'bid-ask',
  name: 'Bid Ask',
  short: 'Bid/Ask',
  ...of,
  pane: 'new',
  zeroLine: true,
  description: 'Ask (buy) volume above zero and bid (sell) volume below zero, mirrored.',
  formula: 'Ask = Σ buy-aggressor qty; Bid = −Σ sell-aggressor qty',
  inputs: {},
  outputs: {
    ask: output.histogram('Ask', HT.up, { opacity: 0.8, unit: 'volume' }),
    bid: output.histogram('Bid', HT.down, { opacity: 0.8, unit: 'volume' }),
  },
  calc(ctx) {
    ctx.out.ask.set(ctx.i, ctx.bar.buy);
    ctx.out.bid.set(ctx.i, -ctx.bar.sell);
  },
});

export const BidAskVR = defineIndicator({
  id: 'bid-ask-vr',
  name: 'Bid Ask VR',
  short: 'VR',
  ...of,
  pane: 'new',
  description: 'Ratio of ask to bid volume, smoothed.',
  formula: 'VR = SMA(ask, n) / SMA(bid, n)',
  inputs: { period: input.int('Smoothing', 14, { min: 1, max: 500 }) },
  outputs: { vr: output.line('VR', HT.info) },
  guides: () => [1],
  title: (p) => `Bid Ask VR ${p.period}`,
  calc(ctx) {
    const a = sma(ctx.src('buy'), ctx.i, ctx.inputs.period);
    const b = sma(ctx.src('sell'), ctx.i, ctx.inputs.period);
    ctx.out.vr.set(ctx.i, b > 0 ? a / b : NaN_);
  },
});

export const AverageDelta = defineIndicator({
  id: 'average-delta',
  name: 'Average Delta',
  short: 'AvgΔ',
  ...of,
  pane: 'new',
  zeroLine: true,
  description: 'Moving average of bar delta.',
  formula: 'AvgΔ = MA(Δ, n)',
  inputs: {
    period: input.int('Period', 14, { min: 1, max: 500 }),
    type: input.enum('MA type', 'ema', MA_TYPES),
  },
  outputs: {
    avg: output.histogram('Avg delta', HT.up, { color2: HT.down, opacity: 0.8, unit: 'volume' }),
  },
  title: (p) => `Avg Delta ${p.type.toUpperCase()} ${p.period}`,
  calc(ctx) {
    const v = ctx.out.avg.v;
    const x = maAt(ctx.inputs.type, v, ctx.src('delta'), ctx.i, ctx.inputs.period);
    ctx.out.avg.set(ctx.i, x, x >= 0 ? 0 : 1);
  },
});

export const BigTrades = defineIndicator({
  id: 'big-trades',
  name: 'Big Trades',
  short: 'Big Trades',
  ...of,
  pane: 'overlay',
  autoscale: false,
  needsTrades: true,
  description: 'Bubbles for single (aggregated) prints at or above the minimum size.',
  formula: 'Consecutive same-side prints within the window are merged; radius ∝ √size (or linear)',
  inputs: {
    min: input.float('Minimum trade size', 20, { min: 0.0001, max: 1e9, step: 1, unit: 'lots' }),
    window: input.int('Aggregation window', 50, {
      min: 0,
      max: 5000,
      unit: 'ms',
      help: '0 = no aggregation',
    }),
    scaling: input.enum('Bubble scaling', 'sqrt', [
      ['sqrt', 'Square root'],
      ['linear', 'Linear'],
    ]),
    maxSize: input.int('Max bubble size', 24, { min: 4, max: 80, unit: 'px' }),
    label: input.bool('Show size label', true),
  },
  outputs: { bubbles: output.markers('Bubbles', HT.up, { color2: HT.down }) },
  title: (p) => `Big Trades ≥ ${p.min}`,
  calc(ctx) {
    const { min, window, scaling, maxSize, label } = ctx.inputs;
    const trades = ctx.trades(ctx.i);
    let k = 0;
    while (k < trades.length) {
      const t0 = trades[k]!;
      let qty = 0;
      let pv = 0;
      let j = k;
      while (
        j < trades.length &&
        trades[j]!.side === t0.side &&
        (j === k || (window > 0 && trades[j]!.ts - t0.ts <= window))
      ) {
        qty += trades[j]!.qty;
        pv += trades[j]!.qty * trades[j]!.px;
        j++;
      }
      k = j;
      if (qty < min || t0.side === 'unknown') continue;
      const f = scaling === 'sqrt' ? Math.sqrt(qty / min) : qty / min;
      ctx.out.bubbles.add({
        bar: ctx.i,
        value: pv / qty,
        shape: 'circle',
        size: Math.min(maxSize, 3 + 3 * f),
        tone: t0.side === 'buy' ? 0 : 1,
        text: label ? formatCompact(qty) : undefined,
        textPos: 'center',
      });
    }
  },
});

export const StackedImbalance = defineIndicator({
  id: 'stacked-imbalance',
  name: 'Stacked Imbalance',
  short: 'Stacked Imb',
  ...of,
  pane: 'overlay',
  autoscale: false,
  description:
    'Zones where N or more consecutive prices show diagonal bid/ask imbalance; extended until price trades through.',
  formula: 'Buy imb at p: ask[p] ≥ ratio·bid[p−1]; sell imb at p: bid[p] ≥ ratio·ask[p+1]',
  inputs: {
    ratio: input.float('Imbalance ratio', 3, { min: 1.1, max: 50, step: 0.1, unit: '×' }),
    levels: input.int('Stacked levels', 3, { min: 2, max: 20 }),
    minVol: input.float('Minimum volume', 1, { min: 0, max: 1e9, step: 1 }),
    extend: input.bool('Extend until filled', true),
  },
  outputs: { zones: output.zones('Zones', HT.up, { color2: HT.down }) },
  title: (p) => `Stacked Imbalance ${p.levels}× ${p.ratio}`,
  calc(ctx) {
    const { ratio, levels, minVol, extend } = ctx.inputs;
    const b = ctx.bar;
    // Close zones that this bar trades through.
    for (const z of ctx.out.zones.items) {
      if (z.to >= 0 && z.to < ctx.i) continue;
      if (z.bar >= ctx.i) continue;
      if (z.tone === 0 ? b.l <= z.bottom : b.h >= z.top) z.to = ctx.i;
      else if (!extend) z.to = z.bar;
    }
    const pxs = [...b.clusters.keys()].sort((x, y) => x - y);
    const scan = (buy: boolean) => {
      let runStart = NaN_;
      let runEnd = NaN_;
      let n = 0;
      const flush = () => {
        if (n >= levels)
          ctx.out.zones.add({
            bar: ctx.i,
            to: extend ? -1 : ctx.i,
            top: runEnd + 0.5,
            bottom: runStart - 0.5,
            tone: buy ? 0 : 1,
          });
        n = 0;
      };
      for (const p of pxs) {
        const c = b.clusters.get(p)!;
        const imb = buy
          ? c.ask >= minVol &&
            c.ask >= ratio * (b.clusters.get(p - 1)?.bid ?? 0) &&
            (b.clusters.get(p - 1)?.bid ?? 0) > 0
          : c.bid >= minVol &&
            c.bid >= ratio * (b.clusters.get(p + 1)?.ask ?? 0) &&
            (b.clusters.get(p + 1)?.ask ?? 0) > 0;
        if (imb && n > 0 && p === runEnd + 1) {
          runEnd = p;
          n++;
        } else if (imb) {
          flush();
          runStart = runEnd = p;
          n = 1;
        } else flush();
      }
      flush();
    };
    scan(true);
    scan(false);
  },
});

interface ProfState {
  key: number;
  levels: Map<number, ProfileLevel>;
  total: number;
  buy: number;
  sell: number;
}

function addBar(s: ProfState, b: Bar, sign: 1 | -1): void {
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

/** Runs fn with the developing period profile including bar i; commits only when the bar is final. */
function withPeriodProfile<T>(
  st: ProfState,
  b: Bar,
  tf: TimeframeId,
  final: boolean,
  fn: (s: ProfState) => T,
): T {
  const key = periodStart(b.t, tf);
  let s = st;
  if (key !== st.key) {
    if (final) {
      st.key = key;
      st.levels = new Map();
      st.total = st.buy = st.sell = 0;
    } else s = { key, levels: new Map(), total: 0, buy: 0, sell: 0 };
  }
  addBar(s, b, 1);
  const r = fn(s);
  if (!final) addBar(s, b, -1);
  return r;
}

const newProf = (): ProfState => ({ key: NaN_, levels: new Map(), total: 0, buy: 0, sell: 0 });

export const DynamicLevels = defineIndicator({
  id: 'dynamic-levels',
  name: 'Dynamic Levels',
  short: 'Dyn Levels',
  ...of,
  pane: 'overlay',
  autoscale: false,
  description: 'Developing POC, VAH and VAL of the current session / week / month.',
  formula: 'POC = price with max volume so far; VA = 70 % of volume expanded from POC',
  inputs: {
    period: input.timeframe('Period', 'D', { options: ['H1', 'H4', 'D', 'W', 'MN'] }),
    va: input.int('Value area', 70, { min: 10, max: 99, unit: '%' }),
  },
  outputs: {
    vah: output.step('VAH', HT.info, { unit: 'price', width: 1, style: 'dashed' }),
    poc: output.step('POC', HT.warning, { unit: 'price', width: 1.5 }),
    val: output.step('VAL', HT.info, { unit: 'price', width: 1, style: 'dashed' }),
  },
  title: (p) => `Dynamic Levels ${p.period} VA ${p.va}%`,
  init: () => newProf(),
  calc(ctx) {
    const r = withPeriodProfile(ctx.state, ctx.bar, ctx.inputs.period, ctx.final, (s) =>
      finishProfile(s.levels, s.total, s.buy, s.sell, ctx.inputs.va / 100),
    );
    ctx.out.poc.set(ctx.i, r.poc);
    ctx.out.vah.set(ctx.i, r.vah);
    ctx.out.val.set(ctx.i, r.val);
  },
});

export const MaximumLevels = defineIndicator({
  id: 'maximum-levels',
  name: 'Maximum Levels',
  short: 'Max Levels',
  ...of,
  pane: 'overlay',
  autoscale: false,
  description:
    'Price with the maximum volume, positive delta and negative delta in the period, as extended lines.',
  formula: 'max over prices p of Σvol(p), Σ(ask−bid)(p), Σ(bid−ask)(p)',
  inputs: { period: input.timeframe('Period', 'D', { options: ['H1', 'H4', 'D', 'W', 'MN'] }) },
  outputs: {
    vol: output.step('Max volume', HT.warning, { unit: 'price', width: 1.5 }),
    pos: output.step('Max +delta', HT.up, { unit: 'price', width: 1 }),
    neg: output.step('Max −delta', HT.down, { unit: 'price', width: 1 }),
  },
  title: (p) => `Maximum Levels ${p.period}`,
  init: () => newProf(),
  calc(ctx) {
    const r = withPeriodProfile(ctx.state, ctx.bar, ctx.inputs.period, ctx.final, (s) => {
      let mv = -1;
      let pv = NaN_;
      let md = -Infinity;
      let pd = NaN_;
      let nd = Infinity;
      let pn = NaN_;
      for (const [px, l] of s.levels) {
        if (l.vol > mv) [mv, pv] = [l.vol, px];
        const d = l.buy - l.sell;
        if (d > md) [md, pd] = [d, px];
        if (d < nd) [nd, pn] = [d, px];
      }
      return [pv, md > 0 ? pd : NaN_, nd < 0 ? pn : NaN_];
    });
    ctx.out.vol.set(ctx.i, r[0]!);
    ctx.out.pos.set(ctx.i, r[1]!);
    ctx.out.neg.set(ctx.i, r[2]!);
  },
});

export const VWAP = defineIndicator({
  id: 'vwap',
  name: 'VWAP',
  short: 'VWAP',
  ...of,
  pane: 'overlay',
  description: 'Volume-weighted average price with standard-deviation bands, reset per period.',
  formula:
    'VWAP = Σ(p·v)/Σv over all prints (clusters); σ = √(Σ(p²·v)/Σv − VWAP²); bands = VWAP ± kσ',
  inputs: {
    reset: input.enum('Reset', 'session', RESET_OPTIONS),
    bands: input.int('σ bands', 2, { min: 0, max: 3, help: 'Number of band pairs (1σ, 2σ, 3σ).' }),
  },
  outputs: {
    vwap: output.line('VWAP', HT.warning, { unit: 'price', width: 2, priceTag: true }),
    u1: output.line('+1σ', HT.grey, { unit: 'price', width: 1, style: 'dashed', legend: false }),
    l1: output.line('−1σ', HT.grey, { unit: 'price', width: 1, style: 'dashed', legend: false }),
    u2: output.line('+2σ', HT.grey, { unit: 'price', width: 1, style: 'dashed', legend: false }),
    l2: output.line('−2σ', HT.grey, { unit: 'price', width: 1, style: 'dashed', legend: false }),
    u3: output.line('+3σ', HT.grey, { unit: 'price', width: 1, style: 'dotted', legend: false }),
    l3: output.line('−3σ', HT.grey, { unit: 'price', width: 1, style: 'dotted', legend: false }),
  },
  title: (p) => `VWAP (${p.reset}${p.bands ? `, ±${p.bands}σ` : ''})`,
  calc(ctx) {
    const { i, bar } = ctx;
    const spv = ctx.buf('spv');
    const sv = ctx.buf('sv');
    const sp2 = ctx.buf('sp2');
    const reset = i === 0 || isNewPeriod(ctx.bars[i - 1]!.t, bar.t, ctx.inputs.reset as ResetMode);
    let a = 0;
    let v = 0;
    let q = 0;
    for (const [px, c] of bar.clusters) {
      const vol = c.bid + c.ask;
      a += px * vol;
      v += vol;
      q += px * px * vol;
    }
    spv[i] = (reset ? 0 : spv[i - 1]!) + a;
    sv[i] = (reset ? 0 : sv[i - 1]!) + v;
    sp2[i] = (reset ? 0 : sp2[i - 1]!) + q;
    if (!(sv[i]! > 0)) return;
    const w = spv[i]! / sv[i]!;
    const sd = Math.sqrt(Math.max(0, sp2[i]! / sv[i]! - w * w));
    ctx.out.vwap.set(i, w);
    const o = ctx.out;
    const pairs = [
      [o.u1, o.l1],
      [o.u2, o.l2],
      [o.u3, o.l3],
    ] as const;
    for (let k = 0; k < ctx.inputs.bands; k++) {
      pairs[k]![0].set(i, w + (k + 1) * sd);
      pairs[k]![1].set(i, w - (k + 1) * sd);
    }
  },
});

export const SpeedOfTape = defineIndicator({
  id: 'speed-of-tape',
  name: 'Speed of Tape',
  short: 'SoT',
  ...of,
  pane: 'new',
  description: 'Trades (or volume) per bar; bars above k × average are highlighted.',
  formula: 'x = trades per bar; spike when x ≥ k · SMA(x, n)',
  inputs: {
    metric: input.enum('Measure', 'trades', [
      ['trades', 'Trades'],
      ['volume', 'Volume'],
    ]),
    period: input.int('Average period', 20, { min: 1, max: 500 }),
    k: input.float('Spike multiplier', 2, { min: 1, max: 20, step: 0.1 }),
  },
  outputs: { speed: output.histogram('Speed', HT.grey, { color2: HT.warning, unit: 'count' }) },
  title: (p) => `Speed of Tape (${p.metric})`,
  calc(ctx) {
    const s = ctx.src(ctx.inputs.metric);
    const avg = sma(s, ctx.i - 1, ctx.inputs.period);
    const x = s[ctx.i]!;
    ctx.out.speed.set(ctx.i, x, !Number.isNaN(avg) && x >= ctx.inputs.k * avg ? 1 : 0);
  },
});

export const OrderFlowRhythm = defineIndicator({
  id: 'order-flow-rhythm',
  name: 'Order Flow Rhythm',
  short: 'OF Rhythm',
  ...of,
  pane: 'new',
  description: 'Trades per second and volume per second within each bar.',
  formula: 'rate = count / max(1 s, bar duration)',
  inputs: {},
  outputs: {
    tps: output.line('Trades/s', HT.info, { unit: 'value' }),
    vps: output.line('Volume/s', HT.warning, { unit: 'value' }),
  },
  calc(ctx) {
    const b = ctx.bar;
    const next = ctx.bars[ctx.i + 1];
    const dur = Math.max(1, ((next ? next.t : b.tEnd) - b.t) / 1000);
    ctx.out.tps.set(ctx.i, b.trades / dur);
    ctx.out.vps.set(ctx.i, b.vol / dur);
  },
});

export const DailyChange = defineIndicator({
  id: 'daily-change',
  name: 'Daily Change',
  short: 'Daily Δ%',
  ...of,
  pane: 'overlay',
  autoscale: false,
  description:
    'Prior session close as a level and the % change from it as a label at the last bar.',
  formula: 'Change % = 100 · (C − prior close) / prior close',
  inputs: {},
  outputs: {
    prior: output.step('Prior close', HT.grey, { unit: 'price', width: 1, style: 'dashed' }),
    label: output.markers('Label', HT.up, { color2: HT.down }),
  },
  calc(ctx) {
    const { i, bar } = ctx;
    const pc = ctx.buf('pc');
    pc[i] =
      i === 0
        ? NaN_
        : isNewPeriod(ctx.bars[i - 1]!.t, bar.t, 'session')
          ? ctx.bars[i - 1]!.c
          : pc[i - 1]!;
    const p = pc[i]!;
    if (Number.isNaN(p)) return;
    ctx.out.prior.set(i, p);
    if (i === ctx.count - 1) {
      const ch = (100 * (bar.c - p)) / p;
      ctx.out.label.add({
        bar: i,
        value: bar.h,
        shape: 'text',
        size: 4,
        tone: ch >= 0 ? 0 : 1,
        text: `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`,
        textPos: 'above',
      });
    }
  },
});

export const PsychologicalLevels = defineIndicator({
  id: 'psychological-levels',
  name: 'Psychological Levels',
  short: 'Psy Levels',
  ...of,
  pane: 'overlay',
  autoscale: false,
  description: 'Horizontal lines at round-number prices around the last price.',
  formula: 'levels = round(C / step)·step ± k·step',
  inputs: {
    step: input.float('Step (price)', 100, {
      min: 0.00001,
      max: 1e7,
      step: 1,
      help: 'In price units.',
    }),
    count: input.int('Levels each side', 5, { min: 1, max: 50 }),
  },
  outputs: { levels: output.levels('Levels', HT.dim, { style: 'dotted' }) },
  title: (p) => `Psychological ${p.step}`,
  calc(ctx) {
    if (ctx.i !== ctx.count - 1) return;
    const step = Math.max(1e-9, ctx.inputs.step / ctx.tickSize);
    const base = Math.round(ctx.bar.c / step) * step;
    for (let k = -ctx.inputs.count; k <= ctx.inputs.count; k++) {
      const v = base + k * step;
      ctx.out.levels.add({
        bar: 0,
        to: -1,
        value: v,
        tone: 0,
        label: String(+(v * ctx.tickSize).toPrecision(10)),
      });
    }
  },
});

export const CandleStatistics = defineIndicator({
  id: 'candle-statistics',
  name: 'Candle Statistics',
  short: 'Candle Stats',
  ...of,
  pane: 'overlay',
  autoscale: false,
  description: 'Volume and delta printed under every bar (trades and duration in the legend).',
  formula: 'Per bar: Σvol, Δ, trades, duration (s)',
  inputs: {
    minWidth: input.int('Hide labels below bar width', 0, { min: 0, max: 200, unit: 'px' }),
  },
  outputs: {
    labels: output.markers('Labels', HT.soft, { color2: HT.up, color3: HT.down }),
    trades: output.line('Trades', HT.grey, { unit: 'count', visible: false }),
    duration: output.line('Duration s', HT.grey, { unit: 'value', visible: false }),
  },
  calc(ctx) {
    const b = ctx.bar;
    ctx.out.labels.add({
      bar: ctx.i,
      value: b.l,
      shape: 'text',
      size: 6,
      tone: b.delta >= 0 ? 1 : 2,
      text: `${formatCompact(b.vol)} ${b.delta >= 0 ? '+' : ''}${formatCompact(b.delta)}`,
      textPos: 'below',
    });
    ctx.out.trades.set(ctx.i, b.trades);
    ctx.out.duration.set(ctx.i, (b.tEnd - b.t) / 1000);
  },
});

export const MarketPower = defineIndicator({
  id: 'market-power',
  name: 'Market Power',
  short: 'Mkt Power',
  ...of,
  pane: 'new',
  zeroLine: true,
  description: 'Delta weighted by the price movement it produced, smoothed.',
  formula: 'raw = Δ · |C − C₋₁| (ticks); MP = MA(raw, n)',
  inputs: {
    period: input.int('Period', 10, { min: 1, max: 500 }),
    type: input.enum('MA type', 'ema', MA_TYPES),
  },
  outputs: { mp: output.histogram('Power', HT.up, { color2: HT.down, unit: 'value' }) },
  title: (p) => `Market Power ${p.period}`,
  calc(ctx) {
    const raw = ctx.buf('raw');
    raw[ctx.i] = ctx.i > 0 ? ctx.bar.delta * Math.abs(ctx.bar.c - ctx.bars[ctx.i - 1]!.c) : 0;
    const v = ctx.out.mp.v;
    const x = maAt(ctx.inputs.type, v, raw, ctx.i, ctx.inputs.period);
    ctx.out.mp.set(ctx.i, x, x >= 0 ? 0 : 1);
  },
});
