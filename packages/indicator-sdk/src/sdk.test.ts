import { describe, expect, it } from 'vitest';
import { createConfig, normalizeExt, paneGroups, titleOf } from './config';
import { HT, input, output, resolveInputs } from './inputs';
import { ema, linreg, sma, stdev } from './math';
import { periodStart, tfClassOf } from './periods';
import { IndicatorRuntime } from './runtime';
import { defineIndicator, asAny } from './types';
import { formatValue, niceStep } from './format';

const Demo = defineIndicator({
  id: 'demo',
  name: 'Demo',
  category: 'technical',
  pane: 'new',
  description: 'test',
  inputs: {
    n: input.int('N', 3, { min: 1, max: 10 }),
    f: input.float('F', 0.5, { min: 0, max: 1 }),
    on: input.bool('On', true),
    mode: input.enum('Mode', 'a', [
      ['a', 'A'],
      ['b', 'B'],
    ]),
    col: input.color('Colour', '#FFFFFF'),
    src: input.source('Source', 'close', { sources: ['close', 'volume'] }),
    tf: input.timeframe('TF', 'D'),
    s: input.string('Label', 'x', { maxLength: 3 }),
    ls: input.lineStyle('Style', 'solid'),
  },
  outputs: { v: output.line('V', HT.info), z: output.zones('Z', HT.up) },
  title: (p) => `Demo ${p.n} ${p.mode}`,
  calc(ctx) {
    ctx.out.v.set(ctx.i, ctx.src(ctx.inputs.src)[ctx.i]!);
  },
});

describe('inputs', () => {
  it('validates, clamps and falls back to defaults', () => {
    const v = resolveInputs(Demo.inputs, {
      n: 99.6,
      f: -1,
      on: 'yes',
      mode: 'zzz',
      col: 'red',
      src: 'delta',
      tf: 'W',
      s: 'abcdef',
      ls: 'dashed',
      junk: 1,
    } as never);
    expect(v).toEqual({ n: 10, f: 0, on: true, mode: 'a', col: '#FFFFFF', src: 'close', tf: 'W', s: 'abc', ls: 'dashed' });
  });
});

describe('math', () => {
  const x = [1, 2, 3, 4, 5];
  it('sma / ema / stdev / linreg', () => {
    expect(sma(x, 4, 5)).toBe(3);
    expect(sma(x, 2, 5)).toBeNaN();
    const out = new Float64Array(5).fill(Number.NaN);
    for (let i = 0; i < 5; i++) out[i] = ema(out, x, i, 3);
    expect(out[2]).toBe(2);
    expect(out[4]).toBe(4);
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9], 7, 8)).toBe(2);
    const r = linreg([1, 3, 5, 7], 3, 4);
    expect(r.slope).toBeCloseTo(2);
    expect(r.value).toBeCloseTo(7);
    expect(r.r2).toBeCloseTo(1);
  });
});

describe('periods & format', () => {
  it('period starts (UTC day, Monday weeks, months)', () => {
    const t = Date.UTC(2026, 10, 12, 15, 30); // Thu 12 Nov 2026
    expect(periodStart(t, 'D')).toBe(Date.UTC(2026, 10, 12));
    expect(periodStart(t, 'W')).toBe(Date.UTC(2026, 10, 9));
    expect(periodStart(t, 'MN')).toBe(Date.UTC(2026, 10, 1));
    expect(periodStart(t, 'H1')).toBe(Date.UTC(2026, 10, 12, 15));
    expect(tfClassOf({ kind: 'time', ms: 300_000 })).toBe('minutes');
    expect(tfClassOf({ kind: 'tick', n: 100 })).toBe('tick');
  });
  it('formats by unit and picks nice steps', () => {
    const inst = { tickSize: 0.25, pricePrecision: 2 };
    expect(formatValue(10, 'price', inst)).toBe('2.50');
    expect(formatValue(12.345, 'percent', inst)).toBe('12.35%');
    expect(formatValue(Number.NaN, 'value', inst)).toBe('—');
    expect(niceStep(100, 4)).toBe(25);
  });
});

describe('config', () => {
  const lookup = (id: string) => (id === 'demo' ? asAny(Demo) : undefined);
  it('normalizes saved data and drops unknown types', () => {
    const ext = normalizeExt(
      {
        items: [
          { uid: 'a', type: 'demo', inputs: { n: 5 }, styles: { v: { width: 99, color: 'bad' } }, height: 5 },
          { uid: 'b', type: 'nope' },
          { uid: 'c', type: 'demo', pane: 'a', scale: 'merged' },
          { uid: 'd', type: 'demo', pane: 'missing' },
        ],
      },
      lookup,
    );
    expect(ext.items.map((i) => i.uid)).toEqual(['a', 'c', 'd']);
    expect(ext.items[0]!.inputs.n).toBe(5);
    expect(ext.items[0]!.styles.v!.width).toBe(8);
    expect(ext.items[0]!.styles.v!.color).toBe(HT.info);
    expect(ext.items[0]!.height).toBe(40);
    expect(ext.items[2]!.pane).toBe('new');
    expect(paneGroups(ext.items).map((g) => g.map((c) => c.uid))).toEqual([['a', 'c'], ['d']]);
    expect(titleOf(asAny(Demo), { n: 4 })).toBe('Demo 4 a');
    expect(createConfig(asAny(Demo)).pane).toBe('new');
  });
});

describe('runtime', () => {
  it('updates incrementally when bars are appended and fully when replaced', () => {
    const mk = (c: number) => ({
      t: 0,
      tEnd: 0,
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
    });
    const bars = [mk(1), mk(2)];
    const data = { bars, version: 1, tickSize: 1 };
    const rt = new IndicatorRuntime(asAny(Demo));
    expect(rt.update(data)).toBe('full');
    expect(rt.update(data)).toBe('none');
    bars.push(mk(3));
    expect(rt.update({ ...data, version: 2 })).toBe('incremental');
    expect(rt.valueAt('v', 2)).toBe(3);
    expect(rt.update({ bars: [mk(9)], version: 3, tickSize: 1 })).toBe('full');
    expect(rt.valueAt('v', 0)).toBe(9);
  });
});
