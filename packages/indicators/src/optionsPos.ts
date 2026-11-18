import {
  HT,
  defineIndicator,
  input,
  output,
  type AccountOption,
  type AccountSnapshot,
  type Level,
  type Zone,
} from '@htflow/indicator-sdk';
import {
  analyzeStrategy,
  firstExpiry,
  paperOptionExpiry,
  paperOptionLeg,
  payoffRange,
  pnlAt,
  type Leg,
  type StrategyAnalysis,
  type StrategyEnv,
} from '@htflow/options';

/** Open (non-expired, non-flat) option positions as strategy legs with the valuation env. */
export function optionLegs(
  a: AccountSnapshot | null,
  spot: number,
  now: number,
): { legs: Leg[]; env: StrategyEnv; opts: readonly AccountOption[] } | null {
  const opts = (a?.options ?? []).filter((o) => o.qty !== 0 && paperOptionExpiry(o) > now);
  if (!opts.length) return null;
  const first = opts[0]!;
  const env: StrategyEnv = {
    model: first.model ?? 'bs',
    r: first.r ?? 0,
    q: first.q ?? 0,
    multiplier: first.multiplier,
    now,
  };
  return { legs: opts.map((o) => paperOptionLeg(o, spot, spot)), env, opts };
}

const num = (v: number, d = 2) =>
  v === Infinity ? 'unlimited' : v === -Infinity ? 'unlimited loss' : v.toFixed(d);

/** Legend text of a position analysis. */
export function analysisNote(an: StrategyAnalysis, legs: number): string {
  return (
    `${legs} option leg${legs === 1 ? '' : 's'} · net premium ${num(an.netPremium)} · ` +
    `max profit ${num(an.maxProfit)} · max loss ${num(an.maxLoss)} · ` +
    `break-even ${an.breakevens.length ? an.breakevens.map((b) => b.toFixed(2)).join(' / ') : 'none'} · ` +
    `PoP ${(an.pop * 100).toFixed(0)}%`
  );
}

/**
 * Profit / loss segments of a payoff over a price grid: contiguous runs of one sign, split at the
 * midpoint between samples that straddle zero.
 */
export function pnlSegments(
  prices: readonly number[],
  pnl: readonly number[],
): { from: number; to: number; profit: boolean }[] {
  const out: { from: number; to: number; profit: boolean }[] = [];
  let start = prices[0]!;
  let sign = pnl[0]! >= 0;
  for (let k = 1; k < prices.length; k++) {
    const s = pnl[k]! >= 0;
    if (s !== sign) {
      const x0 = prices[k - 1]!;
      const y0 = pnl[k - 1]!;
      const y1 = pnl[k]!;
      const cut = y1 === y0 ? x0 : x0 + ((prices[k]! - x0) * (0 - y0)) / (y1 - y0);
      out.push({ from: start, to: cut, profit: sign });
      start = cut;
      sign = s;
    }
  }
  out.push({ from: start, to: prices[prices.length - 1]!, profit: sign });
  return out;
}

/**
 * Options Position (Options Analytics): the paper account's open option legs on the underlying
 * chart: a level per strike (long / short), the break-evens and the position's risk summary.
 */
export const OptionsPosition = defineIndicator({
  id: 'options-position',
  name: 'Options Position',
  short: 'Opt pos',
  category: 'options',
  pane: 'overlay',
  needsHost: true,
  autoscale: false,
  description:
    'Open option positions of the active paper account on this underlying: strike levels (long / short), break-evens and max profit / loss / probability of profit at the earliest expiry.',
  formula:
    'P/L(S) = Σ qty·mult·(value(S, t) − premium); break-evens = roots of P/L at the earliest expiry; PoP under a lognormal distribution at the legs’ mean IV',
  inputs: {
    breakevens: input.bool('Show break-evens', true),
  },
  outputs: {
    levels: output.levels('Strikes', HT.up, { color2: HT.down, color3: HT.warning }),
  },
  title: () => 'Options position',
  calc(ctx) {
    if (ctx.i !== ctx.count - 1) return;
    if (!ctx.account) {
      ctx.notice('no trading account');
      return;
    }
    const spot = ctx.bar.c * ctx.tickSize;
    const p = optionLegs(ctx.account, spot, ctx.bar.tEnd);
    if (!p) {
      ctx.notice('no open option positions on this instrument');
      return;
    }
    const an = analyzeStrategy(p.legs, spot, p.env);
    const from = Math.max(0, ctx.i - 60);
    p.opts.forEach((o) =>
      ctx.out.levels.add({
        bar: from,
        to: -1,
        value: o.strike / ctx.tickSize,
        label: `${o.qty > 0 ? '+' : '−'}${Math.abs(o.qty)} ${o.right === 'call' ? 'C' : 'P'} ${o.strike}`,
        tone: o.qty > 0 ? 0 : 1,
      } satisfies Level),
    );
    if (ctx.inputs.breakevens)
      for (const b of an.breakevens)
        ctx.out.levels.add({
          bar: from,
          to: -1,
          value: b / ctx.tickSize,
          label: `BE ${b.toFixed(2)}`,
          tone: 2,
        } satisfies Level);
    ctx.notice(analysisNote(an, p.legs.length));
  },
});

/**
 * Options Risk Profile (Options Analytics): where the open option position makes or loses money,
 * drawn as profit / loss zones across the price axis, at the earliest expiry or at the last bar.
 */
export const OptionsRiskProfile = defineIndicator({
  id: 'options-risk-profile',
  name: 'Options Risk Profile',
  short: 'Opt risk',
  category: 'options',
  pane: 'overlay',
  needsHost: true,
  autoscale: false,
  description:
    'Profit and loss zones of the open option positions across the underlying price, at the earliest expiry or marked now (model value at the last bar).',
  formula:
    'Zone = price interval where Σ qty·mult·(value(S, t) − premium) keeps one sign; t = earliest expiry or the last bar time',
  inputs: {
    at: input.enum('Valued at', 'expiry', [
      ['expiry', 'Earliest expiry'],
      ['now', 'Now (model value)'],
    ]),
    width: input.int('Zone width', 40, {
      min: 5,
      max: 500,
      unit: 'bars',
      help: 'How far the zones extend left of the last bar; they always reach the right edge.',
    }),
  },
  outputs: {
    zones: output.zones('Profit / loss', HT.up, { color2: HT.down, opacity: 0.18 }),
  },
  title: (p) => `Options risk profile (${p.at === 'expiry' ? 'expiry' : 'now'})`,
  calc(ctx) {
    if (ctx.i !== ctx.count - 1) return;
    if (!ctx.account) {
      ctx.notice('no trading account');
      return;
    }
    const spot = ctx.bar.c * ctx.tickSize;
    const p = optionLegs(ctx.account, spot, ctx.bar.tEnd);
    if (!p) {
      ctx.notice('no open option positions on this instrument');
      return;
    }
    const an = analyzeStrategy(p.legs, spot, p.env);
    const t = ctx.inputs.at === 'expiry' ? firstExpiry(p.legs, p.env.now) : p.env.now;
    const r = payoffRange(p.legs, spot, an.breakevens);
    const steps = 120;
    const prices = Array.from(
      { length: steps },
      (_, k) => r.from + ((r.to - r.from) * k) / (steps - 1),
    );
    const pnl = prices.map((x) => pnlAt(p.legs, x, t, p.env));
    const from = Math.max(0, ctx.i - ctx.inputs.width);
    for (const s of pnlSegments(prices, pnl))
      ctx.out.zones.add({
        bar: from,
        to: -1,
        top: s.to / ctx.tickSize,
        bottom: s.from / ctx.tickSize,
        tone: s.profit ? 0 : 1,
        label: s.profit ? 'profit' : 'loss',
      } satisfies Zone);
    ctx.notice(analysisNote(an, p.legs.length));
  },
});
