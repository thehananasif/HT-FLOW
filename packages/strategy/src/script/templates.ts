/** Starter strategies of the HT Editor (Templates menu). Written against docs/STRATEGY-API.md. */

export interface ScriptTemplate {
  id: string;
  name: string;
  description: string;
  source: string;
}

const MA_CROSS = `// MA cross: long when the fast moving average crosses above the slow one, short on the
// opposite cross. Every entry carries a stop and a target (in ticks).
export const meta = {
  name: 'MA cross',
  description: 'Fast / slow SMA crossover with a bracket on every entry.',
  timeframe: '5m',
};

export const params = {
  fast: param.int('Fast MA', 9, { min: 2, max: 200 }),
  slow: param.int('Slow MA', 21, { min: 3, max: 500 }),
  qty: param.int('Quantity', 1, { min: 1, max: 100 }),
  stopTicks: param.int('Stop (ticks)', 16, { min: 1, max: 2000 }),
  targetTicks: param.int('Target (ticks)', 32, { min: 1, max: 4000 }),
};

export function onStart() {
  log('MA cross started on', instrument.symbol, 'fast', params.fast, 'slow', params.slow);
}

export function onBar(bar: Bar) {
  const c: number[] = closes();
  if (c.length < params.slow + 1) return;
  const prev = c.slice(0, -1);
  const fast = [ta.sma(prev, params.fast), ta.sma(c, params.fast)];
  const slow = [ta.sma(prev, params.slow), ta.sma(c, params.slow)];
  plot('Fast MA', fast[1], { color: '#4fc3f7' });
  plot('Slow MA', slow[1], { color: '#ffb74d' });

  const pos = position();
  const bracket = { stop: params.stopTicks, target: params.targetTicks };
  if (ta.crossOver(fast, slow) && pos.side !== 'long') {
    if (pos.side === 'short') close('reverse');
    buy(params.qty, { ...bracket, label: 'MA cross up' });
  } else if (ta.crossUnder(fast, slow) && pos.side !== 'short') {
    if (pos.side === 'long') close('reverse');
    sell(params.qty, { ...bracket, label: 'MA cross down' });
  }
}

export function onOrderUpdate(order: Order) {
  if (order.status === 'filled') log('Filled', order.side, order.qty, '@', order.avgFillPrice);
}
`;

const DELTA_BREAKOUT = `// Delta breakout: enter when a bar closes beyond the range of the last N bars AND its delta
// confirms the move (aggressive buyers above, aggressive sellers below).
export const meta = {
  name: 'Delta breakout',
  description: 'Range breakout confirmed by bar delta.',
  timeframe: '5m',
};

export const params = {
  lookback: param.int('Range bars', 12, { min: 2, max: 200 }),
  minDelta: param.float('Min |delta|', 50, { min: 0, max: 1e6, step: 10 }),
  qty: param.int('Quantity', 1, { min: 1, max: 100 }),
  stopTicks: param.int('Stop (ticks)', 12, { min: 1, max: 2000 }),
  targetTicks: param.int('Target (ticks)', 24, { min: 1, max: 4000 }),
};

export function onBar(bar: Bar) {
  const all = bars();
  if (all.length < params.lookback + 1) return;
  const range = all.slice(-params.lookback - 1, -1);
  const hi = ta.highest(range.map((b) => b.high), params.lookback);
  const lo = ta.lowest(range.map((b) => b.low), params.lookback);
  plot('Range high', hi, { color: '#66bb6a' });
  plot('Range low', lo, { color: '#ef5350' });
  plot('Delta', bar.delta, { overlay: false });
  if (position().side !== 'flat') return;
  const exits = { stop: params.stopTicks, target: params.targetTicks };
  if (bar.close > hi && bar.delta >= params.minDelta) buy(params.qty, { ...exits, label: 'breakout up' });
  else if (bar.close < lo && bar.delta <= -params.minDelta)
    sell(params.qty, { ...exits, label: 'breakout down' });
}
`;

const VWAP_REVERSION = `// VWAP reversion: fade stretched moves away from the session VWAP, target the VWAP.
export const meta = {
  name: 'VWAP reversion',
  description: 'Fades moves beyond k standard deviations from VWAP.',
  timeframe: '5m',
};

export const params = {
  length: param.int('Deviation bars', 20, { min: 5, max: 500 }),
  k: param.float('Bands (σ)', 1.5, { min: 0.5, max: 5, step: 0.1 }),
  qty: param.int('Quantity', 1, { min: 1, max: 100 }),
  stopTicks: param.int('Stop (ticks)', 16, { min: 1, max: 2000 }),
};

export function onBar(bar: Bar) {
  const vwap = indicator('vwap').value('vwap');
  const c = closes(undefined, params.length);
  if (!Number.isFinite(vwap) || c.length < params.length) return;
  const sd = ta.stdev(c, params.length);
  plot('VWAP', vwap, { color: '#ab47bc' });
  if (position().side !== 'flat' || sd <= 0) return;
  const dist = Math.round(Math.abs(bar.close - vwap) / instrument.tickSize);
  const target = Math.max(1, dist);
  if (bar.close < vwap - params.k * sd) buy(params.qty, { stop: params.stopTicks, target, label: 'below VWAP' });
  else if (bar.close > vwap + params.k * sd)
    sell(params.qty, { stop: params.stopTicks, target, label: 'above VWAP' });
}
`;

const FOOTPRINT_IMBALANCE = `// Footprint imbalance: stacked diagonal imbalances show one side taking liquidity level after
// level. Enter with them when the bar's delta agrees.
export const meta = {
  name: 'Footprint imbalance',
  description: 'Stacked buy / sell imbalances confirmed by delta.',
  timeframe: '5m',
};

export const params = {
  ratio: param.float('Imbalance ratio', 3, { min: 1.5, max: 10, step: 0.5 }),
  stacked: param.int('Stacked levels', 3, { min: 2, max: 10 }),
  qty: param.int('Quantity', 1, { min: 1, max: 100 }),
  stopTicks: param.int('Stop (ticks)', 10, { min: 1, max: 2000 }),
  targetTicks: param.int('Target (ticks)', 20, { min: 1, max: 4000 }),
};

export function onBar(bar: Bar) {
  const s = stackedImbalances(0, { ratio: params.ratio });
  plot('POC', poc(), { color: '#ffd54f' });
  if (position().side !== 'flat' || s.count < params.stacked) return;
  const exits = { stop: params.stopTicks, target: params.targetTicks };
  if (s.side === 'buy' && bar.delta > 0) buy(params.qty, { ...exits, label: 'stacked buy imbalance' });
  else if (s.side === 'sell' && bar.delta < 0)
    sell(params.qty, { ...exits, label: 'stacked sell imbalance' });
}
`;

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  { id: 'ma-cross', name: 'MA cross', description: 'Fast / slow SMA crossover', source: MA_CROSS },
  {
    id: 'delta-breakout',
    name: 'Delta breakout',
    description: 'Range breakout confirmed by delta',
    source: DELTA_BREAKOUT,
  },
  {
    id: 'vwap-reversion',
    name: 'VWAP reversion',
    description: 'Fade stretched moves back to VWAP',
    source: VWAP_REVERSION,
  },
  {
    id: 'footprint-imbalance',
    name: 'Footprint imbalance',
    description: 'Stacked imbalances with delta',
    source: FOOTPRINT_IMBALANCE,
  },
];

export const BLANK_SCRIPT = `export const meta = { name: 'My strategy', timeframe: '5m' };

export const params = {
  qty: param.int('Quantity', 1, { min: 1, max: 100 }),
};

export function onBar(bar: Bar) {
  // log(bar.close, delta(), position().side);
}
`;

export function templateById(id: string): ScriptTemplate | undefined {
  return SCRIPT_TEMPLATES.find((t) => t.id === id);
}
