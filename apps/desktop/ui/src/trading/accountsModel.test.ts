import { describe, expect, it } from 'vitest';
import { normalizeSavedAccounts } from './accountsModel';

describe('saved paper accounts', () => {
  it('keeps balances and defaults older saves to the starting balance', () => {
    const out = normalizeSavedAccounts([
      { id: 'a', name: 'Main', currency: 'EUR', startingBalance: 10_000, balance: 9_412.5 },
      { id: 'b', name: ' ', startingBalance: 25_000 },
      { id: 'c', name: 'Bad', startingBalance: -1, balance: Number.NaN, slippageTicks: 2 },
      { name: 'no id' },
      null,
    ]);
    expect(out).toEqual([
      {
        id: 'a',
        name: 'Main',
        currency: 'EUR',
        startingBalance: 10_000,
        slippageTicks: 0,
        balance: 9_412.5,
      },
      {
        id: 'b',
        name: 'Paper',
        currency: 'USD',
        startingBalance: 25_000,
        slippageTicks: 0,
        balance: 25_000,
      },
      {
        id: 'c',
        name: 'Bad',
        currency: 'USD',
        startingBalance: 50_000,
        slippageTicks: 2,
        balance: 50_000,
      },
    ]);
    expect(normalizeSavedAccounts('x')).toEqual([]);
  });

  it('keeps the open state and risk day counters, dropping damaged parts', () => {
    const [a] = normalizeSavedAccounts([
      {
        id: 'a',
        name: 'Main',
        startingBalance: 10_000,
        balance: 9_000,
        state: {
          v: 1,
          positions: [{ instrumentId: 'mock:ESZ6', qty: -2, avgPx: 18000, realized: 0 }],
          orders: [{ id: 'bad' }],
          brackets: [],
          managed: [],
          options: [],
        },
        risk: { day: '2026-11-13', dayStartEquity: 9_500, peakEquity: 10_000, tradesToday: 2 },
      },
    ]);
    expect(a!.state!.positions).toHaveLength(1);
    expect(a!.state!.orders).toEqual([]);
    expect(a!.risk).toEqual({
      day: '2026-11-13',
      dayStartEquity: 9_500,
      peakEquity: 10_000,
      tradesToday: 2,
    });
    const [b] = normalizeSavedAccounts([{ id: 'b', name: 'B', risk: { day: 1 }, state: 'x' }]);
    expect(b!.risk).toBeUndefined();
    expect(b!.state!.positions).toEqual([]);
  });
});
