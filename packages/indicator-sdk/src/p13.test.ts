import { describe, expect, it } from 'vitest';
import type { Bar } from '@htflow/market-data';
import {
  alertTriggered,
  describeIndicatorAlert,
  newIndicatorAlert,
  normalizeAlerts,
} from './alerts';
import type { SeriesOut } from './buffers';
import { createConfig, movePane, normalizeExt, paneGroups, type IndicatorConfig } from './config';
import { ForeignRuntime } from './foreign';
import { HT, input, output } from './inputs';
import { sma } from './math';
import { defineIndicator, asAny } from './types';

const Sma = asAny(
  defineIndicator({
    id: 'sma-t',
    name: 'SMA',
    category: 'technical',
    pane: 'overlay',
    description: '',
    inputs: { n: input.int('N', 2) },
    outputs: { v: output.line('V', HT.info, { unit: 'price' }) },
    calc(ctx) {
      ctx.out.v.set(ctx.i, sma(ctx.src('close'), ctx.i, ctx.inputs.n));
    },
  }),
);
const Osc = asAny({ ...Sma, id: 'osc-t', pane: 'new' });
const lookup = (id: string) => (id === 'sma-t' ? Sma : id === 'osc-t' ? Osc : undefined);

describe('indicator alerts', () => {
  it('detects crosses and level transitions', () => {
    expect(alertTriggered('crossAbove', { x: 1, y: 2 }, { x: 3, y: 2 })).toBe(true);
    expect(alertTriggered('crossAbove', { x: 3, y: 2 }, { x: 4, y: 2 })).toBe(false);
    expect(alertTriggered('crossAbove', null, { x: 3, y: 2 })).toBe(false);
    expect(alertTriggered('crossBelow', { x: 3, y: 2 }, { x: 1, y: 2 })).toBe(true);
    expect(alertTriggered('cross', { x: 3, y: 2 }, { x: 1, y: 2 })).toBe(true);
    expect(alertTriggered('cross', { x: 1, y: 2 }, { x: 3, y: 2 })).toBe(true);
    expect(alertTriggered('above', null, { x: 3, y: 2 })).toBe(true);
    expect(alertTriggered('above', { x: 3, y: 2 }, { x: 4, y: 2 })).toBe(false);
    expect(alertTriggered('below', { x: 3, y: 2 }, { x: 1, y: 2 })).toBe(true);
    expect(alertTriggered('crossAbove', { x: 1, y: 2 }, { x: Number.NaN, y: 2 })).toBe(false);
  });

  it('normalizes saved alerts against the outputs', () => {
    const a = normalizeAlerts(
      [
        { output: 'v', cond: 'nope', value: 'x', target: 'output', other: 'zz' },
        { output: 'missing' },
        null,
      ],
      ['v'],
    );
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      output: 'v',
      cond: 'crossAbove',
      value: 0,
      target: 'output',
      other: 'v',
    });
    expect(
      describeIndicatorAlert({ ...newIndicatorAlert('v'), value: 5 }, (o) => o.toUpperCase()),
    ).toBe('V crosses above 5');
  });

  it('round-trips through the saved config', () => {
    const c = {
      ...createConfig(Sma, 'u1'),
      alerts: [newIndicatorAlert('v', 'a1')],
      tf: 'H1',
      symbol: 'mock:ES',
    };
    const ext = normalizeExt({ items: [c] }, lookup);
    expect(ext.items[0]).toMatchObject({ tf: 'H1', tfMode: 'closed', symbol: 'mock:ES' });
    expect(ext.items[0]!.alerts[0]!.id).toBe('a1');
    const bad = normalizeExt({ items: [{ ...c, tf: 'X9', alerts: 3 }] }, lookup);
    expect(bad.items[0]).toMatchObject({ tf: 'chart', alerts: [] });
  });
});

describe('movePane (drag to pane)', () => {
  const mk = (uid: string, pane: string, type = 'osc-t'): IndicatorConfig => ({
    ...createConfig(lookup(type)!, uid),
    pane,
  });
  const ids = (l: IndicatorConfig[]) => paneGroups(l).map((g) => g.map((c) => c.uid));

  it('joins another pane and keeps references to earlier items', () => {
    const items = [mk('a', 'new'), mk('b', 'new'), mk('c', 'a')];
    const out = movePane(items, 'b', { join: 'a' });
    expect(ids(out)).toEqual([['a', 'c', 'b']]);
    expect(normalizeExt({ items: out }, lookup).items.map((c) => c.pane)).toEqual([
      'new',
      'a',
      'a',
    ]);
  });

  it('re-homes followers when a pane leader moves to the price pane', () => {
    const items = [mk('a', 'new'), mk('b', 'a'), mk('c', 'a'), mk('o', 'overlay', 'sma-t')];
    const out = movePane(items, 'a', 'overlay');
    expect(ids(out)).toEqual([['b', 'c']]);
    expect(out.find((c) => c.uid === 'a')!.pane).toBe('overlay');
  });

  it('moves an overlay into a new pane with its own scale', () => {
    const items = [mk('o', 'overlay', 'sma-t')];
    const out = movePane(items, 'o', 'new');
    expect(out[0]).toMatchObject({ pane: 'new', scale: 'own' });
    expect(movePane(items, 'o', { join: 'o' })).toBe(items);
  });
});

describe('ForeignRuntime (overlay another symbol)', () => {
  const mkBars = (closes: number[], t0: number, ms: number): Bar[] =>
    closes.map((c, i) => ({
      t: t0 + i * ms,
      tEnd: t0 + i * ms + ms - 1,
      o: c,
      h: c,
      l: c,
      c,
      vol: 1,
      buy: 1,
      sell: 0,
      delta: 1,
      maxDelta: 1,
      minDelta: 0,
      trades: 1,
      clusters: new Map(),
      closed: true,
    }));

  it('maps values by time and rescales price outputs to chart ticks', () => {
    // Other symbol: 2-minute bars, tick 0.5. Chart: 1-minute bars, tick 0.25.
    const other = mkBars([10, 20, 30, 40], 0, 120_000);
    const chart = mkBars([1, 1, 1, 1, 1, 1, 1, 1], 0, 60_000);
    const rt = new ForeignRuntime(
      Sma,
      { n: 2 },
      () => ({ bars: other, version: 1, tickSize: 0.5 }),
      0.25,
      'OTHER',
    );
    expect(rt.update({ bars: chart, version: 1, tickSize: 0.25 })).toBe('full');
    const v = Array.from((rt.outputs.v as SeriesOut).v.slice(0, rt.count));
    // SMA(2) of other = [NaN, 15, 25, 35] ticks of 0.5 → ×2 in chart ticks.
    expect(v).toEqual([Number.NaN, Number.NaN, 30, 30, 50, 50, 70, 70]);
    expect(rt.update({ bars: chart, version: 1, tickSize: 0.25 })).toBe('none');
    const more = [...chart, ...mkBars([1], 8 * 60_000, 60_000)];
    other.push(...mkBars([50], 8 * 60_000, 120_000));
    expect(rt.update({ bars: more, version: 2, tickSize: 0.25 })).not.toBe('none');
    expect(rt.valueAt('v', 8)).toBe(90);
  });

  it('waits for the other symbol', () => {
    const rt = new ForeignRuntime(Sma, {}, () => null, 1, 'X');
    expect(rt.update({ bars: [], version: 1, tickSize: 1 })).toBe('none');
    expect(rt.notice).toMatch(/waiting for X/);
  });
});
