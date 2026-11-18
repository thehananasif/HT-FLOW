import { describe, expect, it } from 'vitest';
import { feedProviders, providerFor } from './registry';
import { OKX_SWAP } from './okx';
import { BINANCE_COINM, BINANCE_SPOT } from './binance';
import { BYBIT_INVERSE, BYBIT_SPOT } from './bybit';
import { STREAMING_VENUES } from '@htflow/market-catalog';
import { LIVE_VENUES, toStats } from '../state/liveFeed';
import { PROVIDERS } from '../modules/connections/providers';

describe('live venue feed providers', () => {
  it('registers one desktop-only provider per connector venue', () => {
    expect(OKX_SWAP[0]!.id).toBe('okx-swap:BTC-USDT-SWAP');
    expect(BINANCE_SPOT[0]!.displayName).toBe('BTCUSDT Spot');
    expect(BINANCE_COINM[0]!.currency).toBe('USD');
    for (const prefix of ['okx-swap:', 'binance-spot:', 'binance-coinm:']) {
      const p = feedProviders().find((x) => x.prefix === prefix);
      expect(p?.desktopOnly).toBe(true);
    }
    expect(providerFor('okx-swap:ETH-USDT-SWAP')?.label).toBe('OKX (live)');
  });

  it('streams Bybit spot and inverse (inverse sizes are USD contracts)', () => {
    expect(BYBIT_SPOT[0]!.id).toBe('bybit-spot:BTCUSDT');
    expect(BYBIT_SPOT[0]!.displayName).toBe('BTCUSDT Spot');
    expect(BYBIT_INVERSE[0]!.id).toBe('bybit-inverse:BTCUSD');
    expect(BYBIT_INVERSE[0]!.currency).toBe('USD');
    expect(BYBIT_INVERSE[0]!.qtyPrecision).toBe(0);
    for (const prefix of ['bybit-spot:', 'bybit-inverse:', 'bybit-linear:']) {
      expect(feedProviders().find((x) => x.prefix === prefix)?.desktopOnly).toBe(true);
    }
    expect(providerFor('bybit-inverse:ETHUSD')?.label).toBe('Bybit Inverse (live)');
    for (const v of ['bybit-spot', 'bybit-inverse'] as const) {
      expect(LIVE_VENUES).toContain(v);
      expect(STREAMING_VENUES.has(v)).toBe(true);
    }
  });

  it('every live venue is available in the Connections catalog with a test symbol', () => {
    for (const v of LIVE_VENUES) {
      const p = PROVIDERS.find((x) => x.venue === v);
      expect(p, v).toBeDefined();
      expect(p!.blocked).toBeUndefined();
      expect(p!.testSymbol).toBeTruthy();
    }
  });

  it('converts Rust stats (ns, null for NaN) to UI stats', () => {
    expect(
      toStats([
        { kind: 'funding', ts_ns: 2e12, rate: 1e-4, next_ts_ns: 3e12, mark_price: null },
        { kind: 'open_interest', ts_ns: 2e12, oi: 5, value: 10 },
        { kind: 'liquidation', ts_ns: 2e12, side: 'sell', px: 7, qty: 1 },
      ]),
    ).toEqual([
      { kind: 'funding', ts: 2e6, rate: 1e-4, nextTs: 3e6, markPrice: Number.NaN },
      { kind: 'open_interest', ts: 2e6, oi: 5, value: 10 },
      { kind: 'liquidation', ts: 2e6, side: 'sell', px: 7, qty: 1 },
    ]);
  });
});
