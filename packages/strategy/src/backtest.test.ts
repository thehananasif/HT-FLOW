import { describe, expect, it } from 'vitest';
import type { Trade } from '@htflow/market-data';
import { DeltaLog, simulatedDataset } from '@htflow/replay';
import {
  Backtest,
  runBacktest,
  tradesCsv,
  type BacktestConfig,
  type BacktestData,
} from './backtest';
import { STRATEGIES, strategyById } from './examples';
import { asAnyStrategy, defineStrategy } from './types';
import { input } from '@htflow/indicator-sdk';
import { monteCarloDrawdown, sharpeRatio, sortinoRatio } from './metrics';

const INST = { id: 'test:X', symbol: 'X', tickSize: 1, tickValue: 10, pricePrecision: 0 };

function tapeData(rows: [number, 'buy' | 'sell'][]): BacktestData {
  const trades: Trade[] = rows.map(([px, side], i) => ({
    ts: 1_000 * (i + 1),
    px,
    qty: 1,
    side,
    id: i + 1,
  }));
  return {
    start: 0,
    end: trades[trades.length - 1]!.ts,
    trades,
    snapshots: [],
    deltas: new DeltaLog(1).trim(),
  };
}

/** Buys after bar 1, flattens after bar 3, sells with a bracket after bar 5. */
const Scripted = asAnyStrategy(
  defineStrategy({
    id: 'scripted',
    name: 'Scripted',
    category: 'custom',
    description: 'test',
    inputs: { q: input.int('Qty', 1) },
    onBar(ctx) {
      if (ctx.index === 1) ctx.buy(ctx.inputs.q, { label: 'go long' });
      if (ctx.index === 3) ctx.flatten('exit');
      if (ctx.index === 5)
        ctx.sell(ctx.inputs.q, { bracket: { stopTicks: 3, targetTicks: 5 }, label: 'go short' });
    },
  }),
);

const CFG: BacktestConfig = {
  instrument: INST,
  bars: { kind: 'tick', n: 2 },
  startingBalance: 10_000,
  commissionPerUnit: 2,
  takerFee: 0,
  slippageTicks: 1,
  fillModel: 'tape',
};

describe('backtester', () => {
  // prettier-ignore
  const data = tapeData([
    [100, 'buy'], [101, 'buy'], // bar 0
    [102, 'sell'], [103, 'buy'], // bar 1 → buy at ask 103 + 1 slip = 104
    [104, 'buy'], [105, 'sell'], // bar 2
    [106, 'sell'], [107, 'sell'], // bar 3 → sell at bid 107 − 1 slip = 106
    [108, 'buy'], [109, 'buy'], // bar 4
    [110, 'buy'], [110, 'buy'], // bar 5 → sell at bid 109 − 1 = 108; SL 111, TP 103
    [111, 'buy'], // stop triggers: ask 111 + 1 slip = 112
    [111, 'sell'],
  ]);

  it('matches a hand-checked fixed trade sequence', () => {
    const r = runBacktest(Scripted, undefined, data, CFG);
    expect(r.trades).toHaveLength(2);
    const [a, b] = r.trades;
    expect(a).toMatchObject({
      side: 'long',
      entryPx: 104,
      exitPx: 106,
      pnl: 20,
      commission: 4,
      net: 16,
      entryLabel: 'go long',
      exitLabel: 'exit',
      exitReason: 'signal',
      entryBar: 1,
      exitBar: 3,
    });
    expect(b).toMatchObject({
      side: 'short',
      entryPx: 108,
      exitPx: 112,
      pnl: -40,
      commission: 4,
      net: -44,
      exitReason: 'stop',
      risk: 30,
    });
    expect(b!.r).toBeCloseTo(-44 / 30, 10);
    expect(r.stats.netPnl).toBe(-28);
    expect(r.stats.trades).toBe(2);
    expect(r.stats.winRate).toBe(0.5);
    expect(r.stats.profitFactor).toBeCloseTo(16 / 44, 10);
    expect(r.stats.maxDrawdown).toBe(44);
    expect(r.stats.expectancy).toBe(-14);
    expect(r.equity.at(-1)!.equity).toBe(10_000 - 28);
    expect(tradesCsv(r).split('\r\n')[1]).toContain('long,1');
  });

  it('applies no slippage to resting targets and flattens at the end of data', () => {
    const r = runBacktest(
      Scripted,
      undefined,
      // prettier-ignore
      tapeData([
        [100, 'buy'], [100, 'buy'], [100, 'buy'], [100, 'buy'], [100, 'buy'], [100, 'buy'],
        [100, 'buy'], [100, 'buy'], [100, 'buy'], [100, 'buy'],
        [101, 'sell'], [101, 'sell'], // bar 5: short at bid 101 − 1 = 100, TP 95
        [94, 'sell'], // trades through 95 → target fills at 95
      ]),
      CFG,
    );
    const short = r.trades.find((t) => t.side === 'short')!;
    expect(short).toMatchObject({ entryPx: 100, exitPx: 95, pnl: 50, exitReason: 'target' });
  });

  it('is deterministic and independent of chunking', () => {
    const now = Date.UTC(2026, 9, 6, 3);
    const ds = simulatedDataset('mock:ESZ6', now - 2 * 3_600_000, now);
    for (const def of STRATEGIES) {
      const cfg: BacktestConfig = {
        ...CFG,
        instrument: {
          id: 'mock:ESZ6',
          symbol: 'ESZ6',
          tickSize: 0.25,
          tickValue: 12.5,
          pricePrecision: 2,
        },
        bars: { kind: 'time', ms: 60_000 },
        fillModel: 'book',
      };
      const a = runBacktest(def, undefined, ds, cfg);
      const b = runBacktest(def, undefined, ds, cfg);
      expect(b).toEqual(a);
      const chunked = new Backtest(def, undefined, ds, cfg);
      let guard = 0;
      while (!chunked.step(0) && guard++ < 1e6);
      expect(chunked.result()).toEqual(a);
      expect(a.ticks).toBe(ds.trades.length);
    }
    // At least one example trades on two hours of one-minute bars.
    const counts = STRATEGIES.map(
      (d) =>
        runBacktest(d, undefined, ds, {
          ...CFG,
          instrument: {
            id: 'mock:ESZ6',
            symbol: 'ESZ6',
            tickSize: 0.25,
            tickValue: 12.5,
            pricePrecision: 2,
          },
          bars: { kind: 'time', ms: 60_000 },
        }).stats.trades,
    );
    expect(counts.some((n) => n > 0)).toBe(true);
  });

  it('ignores orders outside the trading window and is flat at its end', () => {
    const r = runBacktest(Scripted, undefined, data, {
      ...CFG,
      window: { from: 5_000, to: 9_500 },
    });
    // Bar 1 closes at t=4000 (outside); bar 3 closes at 8000 (flatten with no position);
    // the bar-5 short at 12000 is after the window.
    expect(r.trades).toHaveLength(0);
  });

  it('looks up built-ins by id', () => {
    expect(strategyById('opening-range-breakout')?.name).toBe('Opening range breakout');
    expect(STRATEGIES).toHaveLength(5);
  });
});

describe('metrics', () => {
  it('computes Sharpe, Sortino and a seeded Monte-Carlo drawdown', () => {
    expect(sharpeRatio([1, 1])).toBe(0);
    expect(sharpeRatio([1, 3])).toBeCloseTo(2 / Math.SQRT2, 10);
    expect(sortinoRatio([2, -2])).toBe(0);
    expect(sortinoRatio([4, -2])).toBeCloseTo(1 / Math.sqrt(2), 10);
    const nets = [10, -5, 7, -20, 3, 8, -1];
    expect(monteCarloDrawdown(nets)).toBe(monteCarloDrawdown(nets));
    expect(monteCarloDrawdown(nets)).toBeGreaterThanOrEqual(20);
  });
});
