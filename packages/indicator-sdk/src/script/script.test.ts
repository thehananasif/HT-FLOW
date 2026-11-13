import { describe, expect, it } from 'vitest';
import type { Bar } from '@htflow/market-data';
import { ListOut, SeriesOut } from '../buffers';
import { ema, sma } from '../math';
import { IndicatorRuntime, computeIndicator } from '../runtime';
import { checkScript, compileFormula, scriptIndicator } from './compile';
import { SAMPLE_SCRIPT, parseHtind, serializeHtind } from './htind';
import { parseProgram } from './lang';

function bars(closes: number[]): Bar[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1]! : c;
    const delta = c >= o ? 3 : -2;
    return {
      t: i * 60_000,
      tEnd: i * 60_000 + 59_000,
      o,
      h: Math.max(o, c) + 1,
      l: Math.min(o, c) - 1,
      c,
      vol: 10 + (i % 4),
      buy: 6,
      sell: 4,
      delta,
      maxDelta: 3,
      minDelta: -2,
      trades: 3,
      clusters: new Map(),
      closed: true,
    };
  });
}

const CLOSES = [10, 12, 11, 13, 15, 14, 16, 18, 17, 19, 21, 20, 22, 21, 23, 25, 24, 26];
const vals = (rt: IndicatorRuntime, k: string) =>
  Array.from((rt.outputs[k] as SeriesOut).v.slice(0, rt.count));

describe('HT Script language', () => {
  it('parses statements, precedence, named args and indexing', () => {
    const p = parseProgram(
      'a = 1 + 2 * 3 ^ 2\nvar b = 0; b := b[1] + 1\nplot("x", a, color="#FFFFFF")',
    );
    expect(p).toHaveLength(4);
    expect(p[0]).toMatchObject({ t: 'assign', name: 'a', e: { t: 'bin', op: '+' } });
    expect(p[1]).toMatchObject({ t: 'assign', persist: true });
    expect(p[3]).toMatchObject({ t: 'expr', e: { t: 'call', name: 'plot' } });
  });

  it('declares inputs, outputs, guides and pane', () => {
    const def = scriptIndicator('script:t', SAMPLE_SCRIPT);
    expect(def.name).toBe('Delta momentum');
    expect(def.short).toBe('DMOM');
    expect(def.pane).toBe('new');
    expect(Object.keys(def.inputs)).toEqual(['length', 'source']);
    expect(def.inputs.length).toMatchObject({ type: 'int', default: 14, min: 1, max: 500 });
    expect(Object.keys(def.outputs)).toEqual(['fast_slow', 'fast', 'cross_up']);
    expect(def.outputs.cross_up!.kind).toBe('markers');
    expect(def.guides!({} as never)).toEqual([0]);
  });

  it('computes series functions like the SDK math helpers', () => {
    const src = `indicator("t", pane="overlay")
n = input.int("N", 3)
plot("sma", sma(close, n))
plot("ema", ema(close, n))
plot("prev", close[1])
plot("diff", close - close[2], unit="value")`;
    const rt = computeIndicator(
      scriptIndicator('script:t', src),
      bars(CLOSES),
      { n: 4 },
      { tickSize: 0.25 },
    );
    const c = Float64Array.from(CLOSES.map((x) => x * 0.25));
    const o = new Float64Array(CLOSES.length).fill(Number.NaN);
    for (let i = 0; i < CLOSES.length; i++) {
      // Price outputs are stored back in ticks.
      const near = (a: number, b: number) =>
        Number.isNaN(b) ? expect(a).toBeNaN() : expect(a).toBeCloseTo(b, 9);
      near(vals(rt, 'sma')[i]!, sma(c, i, 4) / 0.25);
      o[i] = ema(o, c, i, 4);
      near(vals(rt, 'ema')[i]!, o[i]! / 0.25);
    }
    expect(vals(rt, 'prev').slice(0, 3)).toEqual([Number.NaN, 10, 12]);
    expect(vals(rt, 'diff')[3]).toBeCloseTo((13 - 12) * 0.25, 9);
  });

  it('var keeps state across bars and survives last-bar recomputes', () => {
    const src = 'var n = 0\nn := n + (close > open ? 1 : 0)\nplot("ups", n)';
    const def = scriptIndicator('script:c', src);
    const b = bars(CLOSES);
    const full = computeIndicator(def, b);
    const inc = new IndicatorRuntime(def);
    for (let k = 1; k <= b.length; k++) {
      // The forming bar is recomputed several times.
      inc.update({ bars: b.slice(0, k), version: k * 3, tickSize: 1 });
      inc.update({ bars: b.slice(0, k), version: k * 3 + 1, tickSize: 1 });
    }
    expect(vals(inc, 'ups')).toEqual(vals(full, 'ups'));
    expect(vals(full, 'ups').at(-1)).toBe(b.filter((x) => x.c > x.o).length);
  });

  it('markers, histogram tones and crossovers', () => {
    const src = `f = sma(close, 2)
s = sma(close, 5)
plot.histogram("d", f - s, color="#20C77A", color2="#F04A5D")
plot.marker("x", crossover(f, s), f)`;
    const rt = computeIndicator(
      scriptIndicator('script:m', src),
      bars([5, 4, 3, 2, 1, 2, 4, 6, 8, 9]),
    );
    const d = rt.outputs.d as SeriesOut;
    const tones = Array.from(d.tone.slice(0, rt.count));
    expect(tones).toContain(1);
    expect(tones).toContain(0);
    expect((rt.outputs.x as ListOut<{ bar: number }>).items.map((m) => m.bar)).toEqual([6]);
  });

  it('reports errors with line and column', () => {
    const r = checkScript('a = 1\nplot("x", b)');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/Unknown name 'b'/);
      expect(r.pos).toEqual({ line: 2, col: 11 });
    }
    expect(checkScript('a = (1').ok).toBe(false);
    expect(checkScript('a = 1').ok).toBe(false); // plots nothing
    expect(checkScript('plot("x", sma(close))').ok).toBe(false); // arity
  });
});

describe('HT Script sandbox', () => {
  const blocked = [
    'plot("x", fetch("https://example.com"))',
    'plot("x", XMLHttpRequest())',
    'plot("x", document)',
    'plot("x", window)',
    'plot("x", self)',
    'plot("x", globalThis)',
    'plot("x", importScripts("evil.js"))',
    'plot("x", eval("1"))',
    'plot("x", Function("return 1"))',
    'plot("x", close.constructor)',
    'plot("x", document.cookie)',
    'plot("x", window.location)',
    'plot("x", localStorage)',
    'plot("x", postMessage(1))',
    'plot("x", constructor)',
    'x = `1`\nplot("x", x)',
  ];
  it.each(blocked)('rejects %s', (src) => {
    const r = checkScript(src);
    expect(r.ok).toBe(false);
  });

  it('cannot reach fetch or the DOM even when they exist on the host', () => {
    const g = globalThis as Record<string, unknown>;
    let called = false;
    const prev = g.fetch;
    g.fetch = () => {
      called = true;
    };
    g.document = { title: 'host' };
    try {
      expect(checkScript('plot("x", fetch(1))').ok).toBe(false);
      expect(checkScript('plot("x", document)').ok).toBe(false);
      // A valid script runs without touching any host global.
      computeIndicator(scriptIndicator('script:s', 'plot("x", close * 2)'), bars(CLOSES));
      expect(called).toBe(false);
    } finally {
      g.fetch = prev;
      delete g.document;
    }
  });

  it('indexing with a string is an unknown value, not a property access', () => {
    const rt = computeIndicator(scriptIndicator('script:i', 'plot("x", close["1"])'), bars(CLOSES));
    expect(vals(rt, 'x').every((v) => Number.isNaN(v))).toBe(true);
  });

  it('limits script size', () => {
    expect(checkScript(`${'a'.repeat(30_000)}`).ok).toBe(false);
    const big = Array.from({ length: 3000 }, (_, k) => `a${k} = 1 + 2`).join('\n');
    expect(checkScript(`${big}\nplot("x", 1)`).ok).toBe(false);
  });
});

describe('Custom Formula', () => {
  it('evaluates an expression per bar', () => {
    const fn = compileFormula('(close - sma(close, 3)) * 2');
    const b = bars(CLOSES);
    const rt = computeIndicator(
      {
        id: 'f',
        name: 'f',
        category: 'technical',
        pane: 'new',
        description: '',
        inputs: {},
        outputs: { v: { kind: 'line', label: 'v', color: '#FFFFFF' } },
        calc: (ctx) => (ctx.out.v as SeriesOut).set(ctx.i, fn(ctx as never)),
      },
      b,
    );
    const c = Float64Array.from(CLOSES);
    expect(vals(rt, 'v')[5]).toBeCloseTo((c[5]! - sma(c, 5, 3)) * 2, 9);
    expect(() => compileFormula('close +')).toThrow();
    expect(() => compileFormula('fetch(1)')).toThrow(/Unknown function/);
  });
});

describe('.htind files', () => {
  it('round-trips and accepts plain script text', () => {
    const f = parseHtind(SAMPLE_SCRIPT);
    expect(f).toMatchObject({
      format: 'htind',
      version: 1,
      id: 'delta-momentum',
      name: 'Delta momentum',
    });
    const again = parseHtind(serializeHtind(f));
    expect(again).toEqual(f);
    expect(() => parseHtind('{"format":"other"}')).toThrow(/Not an .htind/);
    expect(() => parseHtind('{bad')).toThrow(/bad JSON/);
    expect(() => parseHtind('plot("x", fetch(1))')).toThrow(/Script error/);
  });
});
