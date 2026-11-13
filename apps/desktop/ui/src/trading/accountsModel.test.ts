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
});
