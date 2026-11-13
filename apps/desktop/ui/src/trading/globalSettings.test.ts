import { beforeEach, describe, expect, it } from 'vitest';
import { STATIC_DEFAULTS, setSetting, useSettingsStore } from '../state/settings';
import {
  autoBracket,
  marketSlippageTicks,
  parseQtyPresets,
  slippageReason,
  tifOf,
  tradingDefaults,
} from './globalSettings';

beforeEach(() => {
  useSettingsStore.setState({ values: STATIC_DEFAULTS, defaults: STATIC_DEFAULTS });
});

describe('Settings → Trading', () => {
  it('parses quick-size presets and maps time in force', () => {
    expect(parseQtyPresets('1, 3;x 7 3')).toEqual([1, 3, 7]);
    expect(parseQtyPresets('')).toEqual([1, 2, 5, 10]);
    expect(tifOf('ioc')).toBe('IOC');
    expect(tifOf('gtc')).toBe('GTC');
    expect(autoBracket(20, 40)).toEqual({ slTicks: 20, tpTicks: [40] });
  });

  it('slippage guard walks the book', () => {
    const asks: [number, number][] = [
      [101, 2],
      [100, 1],
      [107, 10],
    ];
    expect(marketSlippageTicks('buy', 1, asks)).toBe(0);
    expect(marketSlippageTicks('buy', 3, asks)).toBe(1);
    expect(marketSlippageTicks('buy', 4, asks)).toBe(7);
    expect(slippageReason({ type: 'market', side: 'buy', qty: 4 }, asks, 5)).toMatch(/7 ticks/);
    expect(slippageReason({ type: 'market', side: 'buy', qty: 3 }, asks, 5)).toBeNull();
    expect(slippageReason({ type: 'limit', side: 'buy', qty: 4 }, asks, 5)).toBeNull();
    expect(slippageReason({ type: 'market', side: 'buy', qty: 4 }, asks, 0)).toBeNull();
  });

  it('defaults follow the stored settings live', () => {
    expect(tradingDefaults()).toMatchObject({ qty: 1, tif: 'GTC', orderHotkeys: true });
    setSetting('trading.defaultQty', 3);
    setSetting('trading.qtyPresets', '3,6,9');
    setSetting('trading.defaultTif', 'day' as never);
    setSetting('trading.orderHotkeys', false);
    setSetting('trading.showOrderLines', false);
    setSetting('general.confirmOrders', true);
    expect(tradingDefaults()).toMatchObject({
      qty: 3,
      qtyPresets: [3, 6, 9],
      tif: 'DAY',
      orderHotkeys: false,
      showOrderLines: false,
      confirmOrders: true,
    });
  });
});
