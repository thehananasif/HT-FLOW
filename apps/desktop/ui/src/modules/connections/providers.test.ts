import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONNECTIONS,
  GROUPS,
  PROVIDERS,
  latencyLevel,
  providerById,
  searchProviders,
  validateConnection,
} from './providers';

describe('provider catalog', () => {
  it('has exactly the spec groups, in order, with the spec providers', () => {
    expect(GROUPS).toEqual([
      'US and EU markets',
      'Prop connections',
      'Crypto',
      'Simulator',
      'Other',
    ]);
    const names = (g: string) => PROVIDERS.filter((p) => p.group === g).map((p) => p.name);
    expect(names('Crypto')).toEqual([
      'Binance',
      'Binance Futures',
      'Binance COIN-M',
      'Bitfinex',
      'Bitget',
      'BitMEX',
      'Bybit',
      'Bybit Spot',
      'Bybit Inverse',
      'Deribit',
      'Kraken',
      'OKX',
      'Phemex',
      'Whitebit',
    ]);
    expect(names('US and EU markets')).toHaveLength(18);
    expect(names('Prop connections')).toHaveLength(3);
    expect(names('Simulator')).toEqual([
      'HT Sim (15-min delayed)',
      'Crypto data',
      'Crypto Sim',
      'dxFeed (15-min delayed)',
      'SBE',
    ]);
    expect(names('Other')).toEqual([
      'Exante',
      'MT5',
      'Quik',
      'Transaq Connector',
      'CSV / Parquet import',
      'Custom WebSocket',
    ]);
    expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length);
  });

  it('searches by name, group and capability', () => {
    expect(searchProviders('bybit').flatMap((g) => g.items.map((i) => i.id))).toEqual([
      'bybit',
      'bybit-spot',
      'bybit-inverse',
    ]);
    expect(searchProviders('prop').map((g) => g.group)).toContain('Prop connections');
    expect(searchProviders('mbo').flatMap((g) => g.items).length).toBeGreaterThan(2);
    expect(searchProviders('zzz')).toEqual([]);
  });

  it('colours latency by thresholds', () => {
    expect(latencyLevel(12)).toBe('ok');
    expect(latencyLevel(400)).toBe('warn');
    expect(latencyLevel(2000)).toBe('bad');
    expect(latencyLevel(null)).toBe('none');
  });

  it('validates forms per provider kind', () => {
    const ib = providerById('ib')!;
    const base = DEFAULT_CONNECTIONS.list[0]!;
    const errs = validateConnection(ib, { ...base, name: '', gatewayPort: 70000 });
    expect(Object.keys(errs).sort()).toEqual(
      ['gatewayHost', 'gatewayPort', 'name', 'server', 'username'].sort(),
    );
    expect(validateConnection(providerById('bybit')!, { ...base, name: 'Bybit' })).toEqual({});
    expect(
      validateConnection(providerById('crypto-sim')!, { ...base, startingBalance: 5 }),
    ).toHaveProperty('startingBalance');
  });
});
