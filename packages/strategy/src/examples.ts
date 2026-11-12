import { input } from '@htflow/indicator-sdk';
import { asAnyStrategy, defineStrategy, type AnyStrategy } from './types';
import { volumeAt } from './footprint';

const qty = () => input.int('Quantity', 1, { min: 1, max: 1000, help: 'Contracts per entry.' });
const stop = (d: number) =>
  input.int('Stop', d, { min: 1, max: 2000, unit: 'ticks', help: 'Stop-loss distance.' });
const target = (d: number) =>
  input.int('Target', d, { min: 1, max: 5000, unit: 'ticks', help: 'Take-profit distance.' });
const trail = () =>
  input.int('Trailing stop', 0, {
    min: 0,
    max: 2000,
    unit: 'ticks',
    help: '0 = fixed stop. Otherwise the stop follows price at this distance.',
  });

const M5 = { kind: 'time', ms: 300_000 } as const;
const M1 = { kind: 'time', ms: 60_000 } as const;

/** Price makes a new N-bar extreme but the bar's delta disagrees → fade the move. */
export const DeltaDivergence = defineStrategy({
  id: 'delta-divergence',
  name: 'Delta divergence reversal',
  category: 'reversal',
  description:
    'Short a new N-bar high printed on negative delta (buyers did not push it); buy a new N-bar low printed on positive delta. Bracket exit.',
  bars: M5,
  inputs: {
    lookback: input.int('Lookback', 10, { min: 2, max: 200, unit: 'bars' }),
    minDelta: input.float('Min. opposite delta', 0, { min: 0, max: 1e6, step: 1 }),
    qty: qty(),
    stop: stop(12),
    target: target(20),
    trail: trail(),
  },
  onBar(ctx) {
    const { lookback, minDelta, qty: q, stop: sl, target: tp, trail: tr } = ctx.inputs;
    if (ctx.index < lookback || ctx.position.side !== 'flat' || ctx.workingOrders().length) return;
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = ctx.index - lookback; k < ctx.index; k++) {
      hi = Math.max(hi, ctx.bars[k]!.h);
      lo = Math.min(lo, ctx.bars[k]!.l);
    }
    const b = ctx.bar;
    const bracket = { stopTicks: sl, targetTicks: tp, trailTicks: tr };
    if (b.h > hi && b.delta < -minDelta) ctx.sell(q, { bracket, label: 'new high, delta < 0' });
    else if (b.l < lo && b.delta > minDelta) ctx.buy(q, { bracket, label: 'new low, delta > 0' });
  },
});

/** N stacked diagonal imbalances in the direction of the bar → join the move. */
export const StackedImbalance = defineStrategy({
  id: 'stacked-imbalance',
  name: 'Stacked imbalance continuation',
  category: 'continuation',
  description:
    'Buy after a bullish bar with N or more stacked buy imbalances (ask ≥ ratio × diagonal bid); sell the mirror image.',
  bars: M5,
  inputs: {
    ratio: input.float('Imbalance ratio', 3, { min: 1.1, max: 50, step: 0.1, unit: '×' }),
    levels: input.int('Stacked levels', 3, { min: 2, max: 20 }),
    minVol: input.float('Min. volume', 1, { min: 0, max: 1e9, step: 1 }),
    qty: qty(),
    stop: stop(10),
    target: target(20),
    trail: trail(),
  },
  onBar(ctx) {
    const { ratio, levels, minVol, qty: q, stop: sl, target: tp, trail: tr } = ctx.inputs;
    if (ctx.position.side !== 'flat' || ctx.workingOrders().length) return;
    const s = ctx.stackedImbalances(undefined, { ratio, minVolume: minVol });
    if (s.count < levels) return;
    const b = ctx.bar;
    const bracket = { stopTicks: sl, targetTicks: tp, trailTicks: tr };
    if (s.side === 'buy' && b.c > b.o)
      ctx.buy(q, { bracket, label: `${s.count} stacked buy imb.` });
    else if (s.side === 'sell' && b.c < b.o)
      ctx.sell(q, { bracket, label: `${s.count} stacked sell imb.` });
  },
});

/** Close outside a VWAP σ band → fade back to VWAP. */
export const VwapReversion = defineStrategy({
  id: 'vwap-reversion',
  name: 'VWAP band mean reversion',
  category: 'mean-reversion',
  description:
    'Buy a close below VWAP − kσ, sell a close above VWAP + kσ; exit when price returns to VWAP or at the stop.',
  bars: M5,
  inputs: {
    band: input.int('Band', 2, { min: 1, max: 3, unit: 'σ' }),
    reset: input.enum('VWAP reset', 'session', [
      ['session', 'Session'],
      ['week', 'Week'],
      ['month', 'Month'],
    ]),
    qty: qty(),
    stop: stop(16),
    exitAtVwap: input.bool('Exit at VWAP', true),
    target: target(40),
  },
  onBar(ctx) {
    const { band, reset, qty: q, stop: sl, exitAtVwap, target: tp } = ctx.inputs;
    const v = ctx.indicator('vwap', { bands: 3, reset });
    const vwap = v.value('vwap');
    const up = v.value(`u${band}`);
    const dn = v.value(`l${band}`);
    if (Number.isNaN(vwap) || Number.isNaN(up) || up - dn < 2) return;
    const c = ctx.bar.c;
    const pos = ctx.position.side;
    if (exitAtVwap && ((pos === 'long' && c >= vwap) || (pos === 'short' && c <= vwap))) {
      ctx.flatten('back to VWAP');
      return;
    }
    if (pos !== 'flat' || ctx.workingOrders().length) return;
    const bracket = { stopTicks: sl, targetTicks: exitAtVwap ? undefined : tp };
    if (c < dn) ctx.buy(q, { bracket, label: `below −${band}σ` });
    else if (c > up) ctx.sell(q, { bracket, label: `above +${band}σ` });
  },
});

interface OrbState {
  day: number;
  hi: number;
  lo: number;
  armed: boolean;
  done: boolean;
  entries: string[];
}

const DAY = 86_400_000;

/** Range of the first minutes of the session; stop entries just outside it. */
export const OpeningRangeBreakout = defineStrategy({
  id: 'opening-range-breakout',
  name: 'Opening range breakout',
  category: 'breakout',
  description:
    'Records the high / low of the first minutes after the session start, then places buy-stop above and sell-stop below (one-cancels-other). One trade per session, flat at session end.',
  bars: M1,
  inputs: {
    sessionHour: input.int('Session start (UTC hour)', 0, { min: 0, max: 23 }),
    sessionMinute: input.int('Session start (minute)', 0, { min: 0, max: 59 }),
    rangeMinutes: input.int('Opening range', 30, { min: 1, max: 600, unit: 'min' }),
    sessionHours: input.float('Session length', 7, { min: 0.5, max: 24, step: 0.5, unit: 'h' }),
    offset: input.int('Breakout offset', 1, { min: 0, max: 100, unit: 'ticks' }),
    qty: qty(),
    stop: stop(16),
    target: target(32),
  },
  init: (): OrbState => ({
    day: -1,
    hi: -Infinity,
    lo: Infinity,
    armed: false,
    done: false,
    entries: [],
  }),
  onTrade(ctx, t) {
    const p = ctx.inputs;
    const s = ctx.state;
    const startOfDay = Math.floor(t.ts / DAY) * DAY;
    const open = startOfDay + (p.sessionHour * 60 + p.sessionMinute) * 60_000;
    const rangeEnd = open + p.rangeMinutes * 60_000;
    const close = open + p.sessionHours * 3_600_000;
    if (t.ts < open) return;
    if (s.day !== open) {
      Object.assign(s, {
        day: open,
        hi: -Infinity,
        lo: Infinity,
        armed: false,
        done: false,
        entries: [],
      });
    }
    if (t.ts >= close) {
      if (!s.done) {
        s.done = true;
        ctx.cancelAll();
        if (ctx.position.side !== 'flat') ctx.flatten('session end');
      }
      return;
    }
    if (t.ts < rangeEnd) {
      s.hi = Math.max(s.hi, t.px);
      s.lo = Math.min(s.lo, t.px);
      return;
    }
    if (s.armed || s.done || !Number.isFinite(s.hi) || !ctx.canTrade) return;
    s.armed = true;
    const bracket = { stopTicks: p.stop, targetTicks: p.target };
    const b = ctx.buyStop(p.qty, s.hi + p.offset, { bracket, label: 'ORB high break' });
    const sl = ctx.sellStop(p.qty, s.lo - p.offset, { bracket, label: 'ORB low break' });
    s.entries = [b?.id, sl?.id].filter((x): x is string => !!x);
  },
  onFill(ctx, fill) {
    const s = ctx.state;
    if (!s.entries.includes(fill.orderId)) return;
    // One-cancels-other between the two entry stops.
    for (const id of s.entries) if (id !== fill.orderId) ctx.cancel(id);
    s.entries = [];
    s.done = false;
  },
});

/** Heavy volume at the bar's POC near its extreme, yet price closed away → absorption. */
export const AbsorptionPoc = defineStrategy({
  id: 'absorption-poc',
  name: 'Absorption at POC',
  category: 'reversal',
  description:
    'A bar whose POC sits at its low with sellers dominating there, but which closes above the POC, shows passive buyers absorbing: buy. Mirror for shorts.',
  bars: M5,
  inputs: {
    pocShare: input.float('Min. POC volume share', 0.04, {
      min: 0.01,
      max: 1,
      step: 0.01,
      help: 'Volume at the POC as a fraction of the bar volume.',
    }),
    extreme: input.float('POC in outer part of bar', 0.35, {
      min: 0.05,
      max: 0.5,
      step: 0.05,
      help: '0.3 = POC in the lowest (or highest) 30 % of the bar range.',
    }),
    minRange: input.int('Min. bar range', 4, { min: 1, max: 1000, unit: 'ticks' }),
    qty: qty(),
    stop: stop(10),
    target: target(18),
  },
  onBar(ctx) {
    const p = ctx.inputs;
    if (ctx.position.side !== 'flat' || ctx.workingOrders().length) return;
    const b = ctx.bar;
    const range = b.h - b.l;
    if (range < p.minRange || b.vol <= 0) return;
    const poc = ctx.poc();
    const at = volumeAt(b, poc);
    if (at.total / b.vol < p.pocShare) return;
    const bracket = { stopTicks: p.stop, targetTicks: p.target };
    if (poc <= b.l + range * p.extreme && at.bid > at.ask && b.c > poc)
      ctx.buy(p.qty, { bracket, label: 'sellers absorbed at POC' });
    else if (poc >= b.h - range * p.extreme && at.ask > at.bid && b.c < poc)
      ctx.sell(p.qty, { bracket, label: 'buyers absorbed at POC' });
  },
});

/** Built-in example strategies, in display order. */
export const STRATEGIES: AnyStrategy[] = [
  asAnyStrategy(DeltaDivergence),
  asAnyStrategy(StackedImbalance),
  asAnyStrategy(VwapReversion),
  asAnyStrategy(OpeningRangeBreakout),
  asAnyStrategy(AbsorptionPoc),
];

const extra: AnyStrategy[] = [];

/** Registers a user / plug-in strategy (replaces one with the same id). */
export function registerStrategy(s: AnyStrategy): void {
  const i = extra.findIndex((x) => x.id === s.id);
  if (i >= 0) extra[i] = s;
  else extra.push(s);
}

export function allStrategies(): AnyStrategy[] {
  return [...STRATEGIES, ...extra.filter((e) => !STRATEGIES.some((s) => s.id === e.id))];
}

export function strategyById(id: string): AnyStrategy | undefined {
  return allStrategies().find((s) => s.id === id);
}
