import { describe, expect, it } from 'vitest';
import { optionsOriginFor } from './optionsFeed';

describe('options chain origin', () => {
  it('BTC / ETH instruments of a real venue use Deribit', () => {
    for (const [id, symbol, cur] of [
      ['binance-futures:BTCUSDT', 'BTCUSDT', 'BTC'],
      ['deribit:BTC-PERPETUAL', 'BTC-PERPETUAL', 'BTC'],
      ['okx-swap:ETH-USDT-SWAP', 'ETH-USDT-SWAP', 'ETH'],
    ] as const)
      expect(optionsOriginFor({ id, symbol })).toEqual({ kind: 'deribit', currency: cur });
  });
  it('demo-feed instruments use the built-in simulated chain', () => {
    expect(optionsOriginFor({ id: 'mock:BTCUSDT', symbol: 'BTCUSDT' })).toEqual({
      kind: 'sim',
      builtin: true,
    });
    expect(optionsOriginFor({ id: 'mock:ESZ6', symbol: 'ESZ6' })).toEqual({
      kind: 'sim',
      builtin: true,
    });
  });
  it('everything else gets a generic simulated chain', () => {
    expect(optionsOriginFor({ id: 'binance-futures:SOLUSDT', symbol: 'SOLUSDT' })).toEqual({
      kind: 'sim',
      builtin: false,
    });
    expect(optionsOriginFor({ id: 'x:BTCDOMUSDT', symbol: 'BTCDOMUSDT' }).kind).toBe('sim');
  });
});
