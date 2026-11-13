import { beforeEach, describe, expect, it } from 'vitest';
import { appendedSlots, offsetAfterGrowth } from '@htflow/chart-engine';
import { STATIC_DEFAULTS, setSetting, useSettingsStore } from '../../state/settings';
import {
  footprintStatRows,
  globalCandleColors,
  globalChartDefaults,
  globalChartOptions,
  newChartDefaults,
  newChartState,
} from './globals';

beforeEach(() => {
  useSettingsStore.setState({ values: STATIC_DEFAULTS, defaults: STATIC_DEFAULTS });
});

describe('global Chart / Footprint settings reach the charts', () => {
  it('magnet and status line map onto per-chart keys', () => {
    expect(globalChartDefaults()['crosshair.snap']).toBe(false);
    expect(globalChartDefaults()['other.indicatorValues']).toBe(true);
    setSetting('chart.magnet', 'strong' as never);
    setSetting('chart.statusLine', false);
    expect(globalChartDefaults()['crosshair.snap']).toBe(true);
    expect(globalChartDefaults()['other.indicatorValues']).toBe(false);
  });

  it('footprint cell defaults follow Settings → Footprint', () => {
    setSetting('footprint.colorMode', 'delta');
    setSetting('footprint.cellOpacity', 40);
    setSetting('footprint.fontSize', 14);
    setSetting('footprint.minCellHeight', 16);
    setSetting('footprint.showValueArea', true);
    setSetting('footprint.absorptionMarkers', true);
    const d = globalChartDefaults();
    expect(d).toMatchObject({
      'fp.colorMode': 'delta',
      'fp.cellOpacity': 40,
      'fp.fontSize': 14,
      'fp.minCellHeight': 16,
      'fp.vaShow': true,
      'fp.absorption': true,
    });
  });

  it('wick / border colours, auto-scroll, crosshair labels and statistic rows', () => {
    expect(globalCandleColors().wickUp).toBe('');
    setSetting('chart.wickUp', '#112233');
    setSetting('chart.borderDown', '#445566');
    expect(globalCandleColors()).toMatchObject({ wickUp: '#112233', borderDown: '#445566' });
    expect(globalChartOptions()).toMatchObject({ autoScroll: true, crosshairLabels: true });
    expect(globalChartOptions().statRows).toEqual(['delta', 'sessionDelta', 'volume']);
    setSetting('chart.autoScroll', false);
    setSetting('chart.crosshairLabels', false);
    setSetting('footprint.showVolumeRow', false);
    setSetting('footprint.showCumDelta', true);
    expect(globalChartOptions()).toMatchObject({ autoScroll: false, crosshairLabels: false });
    expect(globalChartOptions().statRows).toEqual(['delta', 'sessionDelta', 'cumDelta']);
    expect(footprintStatRows(false, false, false)).toEqual(['sessionDelta']);
  });

  it('new charts take the default timeframe and footprint cell content', () => {
    expect(newChartDefaults('15m', 'delta')).toEqual({
      timeframe: { kind: 'time', ms: 900_000 },
      footprintMode: 'delta',
    });
    expect(newChartState('mock:X', 'footprint')).toMatchObject({
      timeframe: { kind: 'time', ms: 300_000 },
      footprintMode: 'bidask',
    });
    setSetting('chart.defaultTimeframe', '1h');
    setSetting('footprint.cellMode', 'volumeDelta');
    expect(newChartState('mock:X', 'footprint')).toMatchObject({
      timeframe: { kind: 'time', ms: 3_600_000 },
      footprintMode: 'volume-x-delta',
    });
  });

  it('auto-scroll off keeps the view still when bars are appended (not prepended)', () => {
    const times = [10, 20, 30, 40, 50];
    const at = (i: number) => times[i]!;
    expect(appendedSlots(at, 5, 30)).toBe(2);
    expect(appendedSlots(at, 5, 50)).toBe(0);
    expect(appendedSlots(at, 5, null)).toBe(0);
    expect(offsetAfterGrowth(3, 2, false)).toBe(1);
    expect(offsetAfterGrowth(3, 2, true)).toBe(3);
  });
});
