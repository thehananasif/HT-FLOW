import { beforeEach, describe, expect, it } from 'vitest';
import { barIndexAt, plotLines, plotOverlay, plotSlots, type PlotRunLike } from './plotOverlay';

const run = (over: Partial<PlotRunLike> = {}): PlotRunLike => ({
  id: 'r1',
  name: 'MA cross',
  instrumentId: 'mock:ESZ6',
  status: 'running',
  bridge: {
    plots: [
      { name: 'fast', t: 60_000, value: 5000.5, overlay: true },
      { name: 'slow', t: 60_000, value: 5001, overlay: true, color: '#112233' },
      { name: 'rsi', t: 60_000, value: 55, overlay: false },
      { name: 'fast', t: 120_000, value: 5001.5, overlay: true },
    ],
  },
  ...over,
});

describe('strategy plot overlay on the chart', () => {
  beforeEach(() => plotOverlay.reset());

  it('draws overlay plots of an active run on its instrument, grouped by name', () => {
    const lines = plotLines([run()], 'mock:ESZ6');
    expect(lines.map((l) => l.name)).toEqual(['fast', 'slow']);
    expect(lines[0]!.points).toEqual([
      { t: 60_000, value: 5000.5 },
      { t: 120_000, value: 5001.5 },
    ]);
    expect(lines[1]!.color).toBe('#112233');
  });

  it('ignores other instruments, stopped runs and own-pane plots', () => {
    expect(plotLines([run()], 'mock:NQZ6')).toEqual([]);
    expect(plotLines([run({ status: 'stopped' })], 'mock:ESZ6')).toEqual([]);
    expect(plotLines([run({ status: 'error' })], 'mock:ESZ6')).toEqual([]);
    expect(plotLines([run({ bridge: null })], 'mock:ESZ6')).toEqual([]);
    expect(plotLines([run()], 'mock:ESZ6').some((l) => l.name === 'rsi')).toBe(false);
  });

  it('is removable: master switch and per run', () => {
    expect(plotLines([run()], 'mock:ESZ6')).toHaveLength(2);
    plotOverlay.setRunVisible('r1', false);
    expect(plotLines([run()], 'mock:ESZ6')).toEqual([]);
    plotOverlay.setRunVisible('r1', true);
    expect(plotLines([run()], 'mock:ESZ6')).toHaveLength(2);
    plotOverlay.setEnabled(false);
    expect(plotLines([run()], 'mock:ESZ6')).toEqual([]);
  });

  it('notifies subscribers once per tick when plots change', async () => {
    let n = 0;
    const off = plotOverlay.subscribe(() => n++);
    plotOverlay.changed();
    plotOverlay.changed();
    plotOverlay.changed();
    await Promise.resolve();
    expect(n).toBe(1);
    off();
  });

  it('maps plot times to bar slots and converts price to ticks, last value per bar wins', () => {
    const bars = [{ t: 0 }, { t: 60_000 }, { t: 120_000 }];
    expect(barIndexAt(bars, -1)).toBe(-1);
    expect(barIndexAt(bars, 90_000)).toBe(1);
    expect(barIndexAt(bars, 999_999)).toBe(2);
    expect(
      plotSlots(
        bars,
        [
          { t: 60_000, value: 100 },
          { t: 70_000, value: 101 },
          { t: 130_000, value: 102 },
        ],
        0.25,
      ),
    ).toEqual([
      { i: 1, ticks: 404 },
      { i: 2, ticks: 408 },
    ]);
    expect(plotSlots(bars, [{ t: 0, value: 1 }], 0)).toEqual([]);
  });
});
