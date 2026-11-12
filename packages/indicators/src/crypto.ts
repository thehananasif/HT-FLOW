import {
  HT,
  NO_FEED_NOTICE,
  RESET_OPTIONS,
  between,
  defineIndicator,
  input,
  isNewPeriod,
  lastAtOrBefore,
  output,
  sma,
  type ResetMode,
  type Level,
  type Marker,
} from '@htflow/indicator-sdk';
import { formatCompact } from '@htflow/market-data';

const crypto = { category: 'crypto' as const };
const NaN_ = Number.NaN;

const FUND_KEY = (x: { ts: number }) => x.ts;

/** [start, end) of bar i: up to the next bar's open (the last bar is open-ended). */
function span(ctx: { bars: readonly { t: number }[]; i: number }): [number, number] {
  const nxt = ctx.bars[ctx.i + 1];
  return [ctx.bars[ctx.i]!.t, nxt ? nxt.t : Infinity];
}

export const FundingRate = defineIndicator({
  id: 'funding-rate',
  name: 'Funding Rate Tracker',
  short: 'Funding',
  ...crypto,
  pane: 'new',
  zeroLine: true,
  description:
    'Perpetual-swap funding rate in force at each bar (the latest funding sample at the bar close). Positive: longs pay shorts. Needs a derivatives feed.',
  formula:
    'rate(i) = last funding sample with ts < next bar open; % per funding interval (or annualised = rate × intervals/day × 365)',
  inputs: {
    annualize: input.bool('Annualise', false),
    perDay: input.float('Funding intervals per day', 3, { min: 0.1, max: 100, step: 1 }),
    smooth: input.int('Smoothing (bars)', 1, { min: 1, max: 500, help: '1 = raw.' }),
  },
  outputs: {
    rate: output.histogram('Funding %', HT.warning, {
      color2: HT.info,
      opacity: 0.8,
      unit: 'percent',
    }),
    avg: output.line('Average', HT.white, { unit: 'percent', width: 1, legend: false }),
  },
  title: (p) => `Funding${p.annualize ? ' (annualised)' : ''}`,
  calc(ctx) {
    const f = ctx.derivatives?.funding ?? [];
    if (f.length === 0) {
      ctx.notice(NO_FEED_NOTICE);
      return;
    }
    const [, end] = span(ctx);
    const s = lastAtOrBefore(f, end - 1e-9, FUND_KEY);
    if (!s) return;
    const k = ctx.inputs.annualize ? ctx.inputs.perDay * 365 : 1;
    const v = s.rate * 100 * k;
    ctx.out.rate.set(ctx.i, v, v >= 0 ? 0 : 1);
    if (ctx.inputs.smooth > 1) {
      const raw = ctx.buf('raw');
      raw[ctx.i] = v;
      ctx.out.avg.set(ctx.i, sma(raw, ctx.i, ctx.inputs.smooth));
    }
  },
});

/** OI (contracts or quote value) at the end of bar i and at its start; NaN when unknown. */
function oiSpan(
  ctx: {
    bars: readonly { t: number }[];
    i: number;
    derivatives: { openInterest: readonly { ts: number; oi: number; value: number }[] } | undefined;
  },
  quote: boolean,
): [number, number] {
  const list = ctx.derivatives?.openInterest ?? [];
  const [t0, t1] = span(ctx);
  const pick = (x: { oi: number; value: number } | undefined) =>
    x === undefined ? NaN_ : quote ? x.value : x.oi;
  return [
    pick(lastAtOrBefore(list, t0 - 1e-9, FUND_KEY)),
    pick(lastAtOrBefore(list, t1 - 1e-9, FUND_KEY)),
  ];
}

export const OpenInterest = defineIndicator({
  id: 'open-interest',
  name: 'Open Interest',
  short: 'OI',
  ...crypto,
  pane: 'new',
  description:
    "Open interest of the instrument's venue at each bar close, with its change per bar as a histogram. Needs a derivatives feed (no cross-exchange aggregation: one venue per chart).",
  formula: 'OI(i) = last open-interest sample before the next bar open; ΔOI = OI(i) − OI(i−1)',
  inputs: {
    unit: input.enum('Unit', 'contracts', [
      ['contracts', 'Contracts'],
      ['value', 'Quote value'],
    ]),
  },
  outputs: {
    delta: output.histogram('ΔOI', HT.up, { color2: HT.down, opacity: 0.6, unit: 'volume' }),
    oi: output.line('OI', HT.info, { unit: 'volume', width: 1.5 }),
  },
  title: (p) => `Open Interest (${p.unit})`,
  calc(ctx) {
    if (!ctx.derivatives?.openInterest.length) {
      ctx.notice(NO_FEED_NOTICE);
      return;
    }
    const [a, b] = oiSpan(ctx, ctx.inputs.unit === 'value');
    if (Number.isNaN(b)) return;
    ctx.out.oi.set(ctx.i, b);
    if (!Number.isNaN(a)) ctx.out.delta.set(ctx.i, b - a, b >= a ? 0 : 1);
  },
});

export const OIAnalyzer = defineIndicator({
  id: 'oi-analyzer',
  name: 'OI Analyzer',
  short: 'OI Analyzer',
  ...crypto,
  pane: 'new',
  zeroLine: true,
  description:
    'Classifies each bar by price change versus open-interest change: long build-up, short build-up, short covering or long liquidation. Needs a derivatives feed.',
  formula:
    'Δp = C − O, ΔOI = OI − OI₋: (+,+) long build-up; (−,+) short build-up; (+,−) short covering; (−,−) long liquidation',
  inputs: {
    minPct: input.float('Ignore |ΔOI| below', 0, { min: 0, max: 100, step: 0.01, unit: '% of OI' }),
    labels: input.bool('Show labels', true),
  },
  outputs: {
    delta: output.histogram('ΔOI', HT.up, {
      color2: HT.down,
      color3: HT.warning,
      opacity: 0.8,
      unit: 'volume',
    }),
    tag: output.markers('Class', HT.up, { color2: HT.down, color3: HT.warning, legend: false }),
  },
  title: () => 'OI Analyzer',
  calc(ctx) {
    if (!ctx.derivatives?.openInterest.length) {
      ctx.notice(NO_FEED_NOTICE);
      return;
    }
    const [a, b] = oiSpan(ctx, false);
    if (Number.isNaN(a + b)) return;
    const d = b - a;
    if (a > 0 && (Math.abs(d) / a) * 100 < ctx.inputs.minPct) return;
    const dp = ctx.bar.c - ctx.bar.o;
    const up = dp >= 0;
    const build = d >= 0;
    // tone: 0 long build-up, 1 short build-up, 2 covering / liquidation
    const tone = build ? (up ? 0 : 1) : 2;
    ctx.out.delta.set(ctx.i, d, tone);
    if (ctx.inputs.labels && d !== 0)
      ctx.out.tag.add({
        bar: ctx.i,
        value: d,
        shape: 'text',
        size: 0,
        text: build ? (up ? 'LB' : 'SB') : up ? 'SC' : 'LL',
        tone,
        textPos: d >= 0 ? 'above' : 'below',
      } satisfies Marker);
  },
});

export const BalanceOI = defineIndicator({
  id: 'balance-oi',
  name: 'Balance OI',
  short: 'Balance OI',
  ...crypto,
  pane: 'new',
  zeroLine: true,
  description:
    'Cumulative open-interest change signed by price direction: rises when positioning is added with the move or unwound against it. Needs a derivatives feed.',
  formula: 'Balance = Σ sign(C − O)·|ΔOI| (0 at reset)',
  inputs: { reset: input.enum('Reset', 'session', RESET_OPTIONS) },
  outputs: { bal: output.line('Balance OI', HT.info, { unit: 'volume' }) },
  title: (p) => `Balance OI (${p.reset})`,
  calc(ctx) {
    if (!ctx.derivatives?.openInterest.length) {
      ctx.notice(NO_FEED_NOTICE);
      return;
    }
    const { i, bar } = ctx;
    const [a, b] = oiSpan(ctx, false);
    const o = ctx.out.bal.v;
    const reset = i === 0 || isNewPeriod(ctx.bars[i - 1]!.t, bar.t, ctx.inputs.reset as ResetMode);
    const prev = reset || i === 0 || Number.isNaN(o[i - 1]!) ? 0 : o[i - 1]!;
    if (Number.isNaN(a + b)) {
      if (!reset && !Number.isNaN(o[i - 1]!)) o[i] = prev;
      return;
    }
    const dp = bar.c - bar.o;
    o[i] = prev + Math.sign(dp) * Math.abs(b - a);
  },
});

const TIERS = [10, 25, 50, 100];

export const LiquidationHeatmap = defineIndicator({
  id: 'liquidation-heatmap',
  name: 'Liquidation Heatmap',
  short: 'Liquidations',
  ...crypto,
  pane: 'overlay',
  autoscale: false,
  description:
    'Actual liquidations from the feed as bubbles (down colour: a long was liquidated; up colour: a short) plus estimated liquidation levels by leverage tier projected from high-volume bars, extended until touched.',
  formula:
    'Long liq = P·(1 − 1/L), short liq = P·(1 + 1/L) for P = close of bars with Vol ≥ k·SMA(Vol); tiers L = 10 / 25 / 50 / 100×',
  inputs: {
    actual: input.bool('Actual liquidations', true),
    estimated: input.bool('Estimated levels', true),
    minQty: input.float('Min liquidation size', 0, { min: 0, max: 1e12, step: 1 }),
    ref: input.float('Reference size', 10, { min: 0.0001, max: 1e12, step: 1 }),
    volMult: input.float('Estimate from bars with volume ×', 2, { min: 0.5, max: 50, step: 0.5 }),
    period: input.int('Volume average bars', 20, { min: 2, max: 500 }),
    t1: input.int('Tier 1 leverage', TIERS[0]!, { min: 0, max: 200, help: '0 = off.' }),
    t2: input.int('Tier 2 leverage', TIERS[1]!, { min: 0, max: 200 }),
    t3: input.int('Tier 3 leverage', TIERS[2]!, { min: 0, max: 200 }),
    t4: input.int('Tier 4 leverage', TIERS[3]!, { min: 0, max: 200 }),
    maxBars: input.int('Max level length (bars)', 500, { min: 1, max: 100000 }),
  },
  outputs: {
    liqs: output.markers('Liquidations', HT.up, { color2: HT.down }),
    levels: output.levels('Estimated levels', HT.down, { color2: HT.up, style: 'dotted' }),
  },
  title: () => 'Liquidation Heatmap',
  calc(ctx) {
    const { i, bar: b } = ctx;
    const inp = ctx.inputs;
    // extend / close estimated levels
    for (const l of ctx.out.levels.items) {
      if (l.to >= 0 && l.to < i) continue;
      if (l.bar >= i) continue;
      const hit = l.tone === 0 ? b.l <= l.value : b.h >= l.value;
      l.to = hit || i - l.bar >= inp.maxBars ? i : -1;
    }
    if (inp.actual) {
      const liq = ctx.derivatives?.liquidations ?? [];
      if (liq.length === 0) ctx.notice(NO_FEED_NOTICE);
      const [t0, t1] = span(ctx);
      for (const q of between(liq, t0, t1 - 1e-9, FUND_KEY)) {
        if (q.qty < inp.minQty) continue;
        ctx.out.liqs.add({
          bar: i,
          value: q.px,
          shape: 'circle',
          size: Math.min(30, Math.max(2, 3 * Math.sqrt(q.qty / inp.ref))),
          tone: q.side === 'buy' ? 0 : 1,
          text: formatCompact(q.qty),
          textPos: 'center',
        } satisfies Marker);
      }
    }
    if (inp.estimated) {
      const avg = sma(ctx.src('volume'), i - 1, inp.period);
      if (avg > 0 && b.vol >= inp.volMult * avg)
        for (const L of [inp.t1, inp.t2, inp.t3, inp.t4]) {
          if (L <= 0) continue;
          ctx.out.levels.add({
            bar: i,
            to: -1,
            value: b.c * (1 - 1 / L),
            label: `${L}× long`,
            tone: 0,
          } satisfies Level);
          ctx.out.levels.add({
            bar: i,
            to: -1,
            value: b.c * (1 + 1 / L),
            label: `${L}× short`,
            tone: 1,
          } satisfies Level);
        }
    }
  },
});
