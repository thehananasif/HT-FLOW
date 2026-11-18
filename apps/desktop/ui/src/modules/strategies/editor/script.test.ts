import { describe, expect, it } from 'vitest';
import { simulatedDataset } from '@htflow/replay';
import {
  DEFAULT_LIMITS,
  DEFAULT_ORDER_LIMITS,
  InProcessTransport,
  SCRIPT_TEMPLATES,
  SandboxCore,
  parseHtstrat,
  parseTimeframe,
  runScriptBacktest,
  serializeHtstrat,
  validateIntent,
  type BacktestConfig,
  type HostEvent,
  type HostSnapshot,
  type StrategyFile,
} from '@htflow/strategy';
import { compileProject } from './compile';

const INST = { id: 'mock:ESZ6', symbol: 'ESZ6', tickSize: 0.25, tickValue: 12.5, pricePrecision: 2 };
const CFG: Omit<BacktestConfig, 'bars'> = {
  instrument: INST,
  startingBalance: 50_000,
  commissionPerUnit: 2.5,
  takerFee: 0,
  slippageTicks: 1,
  fillModel: 'tape',
};
const DAY = Date.parse('2026-03-03T00:00:00Z');
const data = simulatedDataset('mock:ESZ6', DAY + 13 * 3_600_000, DAY + 21 * 3_600_000, {
  ticks: true,
  depth: false,
});

const file = (source: string, name = 'strategy.ts'): StrategyFile => ({ name, source });
const compile = (...files: StrategyFile[]) => {
  const out = compileProject(files);
  if (!out.project) throw new Error(out.diagnostics.map((d) => d.message).join('; '));
  return out.project;
};

const SNAP: HostSnapshot = {
  time: 1,
  last: 20_000,
  canTrade: true,
  position: { qty: 0, avgPx: 0, openPnl: 0 },
  account: { balance: 1000, equity: 1000, dayPnl: 0, currency: 'USD' },
  orders: [],
  book: null,
};
const bar = (t: number, px: number) => ({
  t,
  tEnd: t + 1,
  o: px,
  h: px + 2,
  l: px - 2,
  c: px,
  vol: 10,
  buy: 6,
  sell: 4,
  delta: 2,
  maxDelta: 2,
  minDelta: 0,
  trades: 3,
  clusters: new Map([[px, { bid: 4, ask: 6, trades: 3, maxTrade: 2, tap: 0 }]]),
  closed: true,
});

function core(source: string, params: Record<string, unknown> = {}) {
  const c = new SandboxCore(INST, DEFAULT_LIMITS);
  const desc = c.load(compile(file(source)), params);
  return { c, desc };
}

describe('compiler', () => {
  it('strips TypeScript and reports syntax errors with a line', () => {
    const ok = compileProject([file('export function onBar(b: Bar): void { const x: number = 1; }')]);
    expect(ok.project).not.toBeNull();
    const bad = compileProject([file('export function onBar(b) {\n  const = 3;\n}')]);
    expect(bad.project).toBeNull();
    expect(bad.diagnostics[0]).toMatchObject({ line: 2, severity: 'error' });
  });

  it('flags sandbox-blocked globals and unknown indicators', () => {
    const d = compileProject([
      file("export function onBar() { fetch('x'); indicator('nope'); }"),
    ]).diagnostics.map((x) => x.message);
    expect(d.some((m) => m.includes("'fetch'"))).toBe(true);
    expect(d.some((m) => m.includes("Unknown indicator 'nope'"))).toBe(true);
  });

  it('turns dynamic import() into a blocked require', () => {
    const { c } = core("export function onBar() { import('https://x.example/a.js').catch(() => {}); }");
    const r = c.call({ kind: 'bar', index: 0, snapshot: SNAP, bars: { '': [bar(0, 20_000)] } });
    // require() of anything but the project's own files is refused (async: no throw here).
    expect(r.error).toBeUndefined();
  });
});

describe('sandbox API bridge', () => {
  it('describes meta, params and hooks; params become values', () => {
    const { c, desc } = core(
      `export const meta = { name: 'T', timeframe: '1m', timeframes: ['5m'] };
       export const params = { n: param.int('N', 3, { min: 1, max: 5 }) };
       export function onBar(b) { log('n', params.n, b.close); }`,
      { n: 99 },
    );
    expect(desc).toMatchObject({ name: 'T', timeframe: '1m', timeframes: ['5m'], hooks: ['onBar'] });
    expect(desc.params.n).toMatchObject({ type: 'int', default: 3 });
    const r = c.call({ kind: 'bar', index: 0, snapshot: SNAP, bars: { '': [bar(0, 20_000)] } });
    expect(r.logs[0]!.text).toBe('n 5 5000'); // clamped to max; ticks → price
  });

  it('produces intents with client ids and converts bars, footprint and book', () => {
    const { c } = core(`export function onBar(b) {
        const fp = footprint();
        log(fp[0].price, fp[0].ask, delta(), position().side, bars().length);
        buy(2, { stop: 8, target: [8, 16], label: 'go' });
        limit('sell', 1, b.close + 5);
        cancel('c1');
      }`);
    const r = c.call({
      kind: 'bar',
      index: 1,
      snapshot: SNAP,
      bars: { '': [bar(0, 19_990), bar(60_000, 20_000)] },
    });
    expect(r.error).toBeUndefined();
    expect(r.logs[0]!.text).toBe('5000 6 2 flat 2');
    expect(r.intents).toEqual([
      { op: 'order', cid: 'c1', side: 'buy', type: 'market', qty: 2, bracket: { stop: 8, target: [8, 16] }, label: 'go' },
      { op: 'order', cid: 'c2', side: 'sell', type: 'limit', qty: 1, price: 5005 },
      { op: 'cancel', cid: 'c1' },
    ]);
  });

  it('ignores order calls while trading is disabled', () => {
    const { c } = core('export function onBar() { buy(1); }');
    const r = c.call({ kind: 'bar', index: 0, snapshot: { ...SNAP, canTrade: false }, bars: { '': [bar(0, 1)] } });
    expect(r.intents).toEqual([]);
  });

  it('shadows network and global capabilities', () => {
    const { c } = core(`export function onBar() {
        log(typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof globalThis, typeof self,
            typeof eval, typeof Function, typeof process, typeof setTimeout, typeof importScripts);
      }`);
    const r = c.call({ kind: 'bar', index: 0, snapshot: SNAP, bars: { '': [bar(0, 1)] } });
    expect(r.logs[0]!.text).toBe(Array(10).fill('undefined').join(' '));
  });

  it('maps runtime errors to file and line', () => {
    const { c } = core('export function onBar() {\n  const x = null;\n  x.boom();\n}');
    const r = c.call({ kind: 'bar', index: 0, snapshot: SNAP, bars: { '': [bar(0, 1)] } });
    expect(r.error).toMatchObject({ kind: 'runtime', file: 'strategy.ts', line: 3 });
  });

  it('reports a CPU budget overrun', () => {
    const c = new SandboxCore(INST, { ...DEFAULT_LIMITS, budgetMs: 5 });
    c.load(compile(file('export function onBar() { const t = Date.now(); while (Date.now() - t < 30) {} }')));
    const r = c.call({ kind: 'bar', index: 0, snapshot: SNAP, bars: { '': [bar(0, 1)] } });
    expect(r.error?.kind).toBe('budget');
  });

  it('caps intents per callback', () => {
    const { c } = core('export function onBar() { for (let i = 0; i < 100; i++) buy(1); }');
    const r = c.call({ kind: 'bar', index: 0, snapshot: SNAP, bars: { '': [bar(0, 1)] } });
    expect(r.intents).toHaveLength(DEFAULT_LIMITS.maxIntentsPerCall);
    expect(r.logs.at(-1)!.level).toBe('warn');
  });

  it('imports sibling files and refuses anything else', () => {
    const c = new SandboxCore(INST, DEFAULT_LIMITS);
    c.load(
      compile(
        file("import { twice } from './util';\nexport function onBar() { log(twice(21)); }"),
        file('export const twice = (x: number) => x * 2;', 'util.ts'),
      ),
    );
    const ev: HostEvent = { kind: 'bar', index: 0, snapshot: SNAP, bars: { '': [bar(0, 1)] } };
    expect(c.call(ev).logs[0]!.text).toBe('42');
    const d = new SandboxCore(INST, DEFAULT_LIMITS);
    expect(() => d.load(compile(file("import x from 'fs';\nexport function onBar() { x; }")))).toThrow();
  });
});

describe('order validation', () => {
  const st = { last: 20_000, position: 0 };
  const lim = { ...DEFAULT_ORDER_LIMITS, maxOrderQty: 5, maxPosition: 3 };
  const order = (o: Record<string, unknown>) => ({ op: 'order', cid: 'c1', side: 'buy', type: 'market', qty: 1, ...o });

  it('accepts a valid bracket order and converts prices to ticks', () => {
    const v = validateIntent(order({ type: 'limit', price: 4999.75, bracket: { stop: 8, target: [4] } }), INST, lim, st);
    expect(v).toEqual({
      ok: true,
      intent: { op: 'order', cid: 'c1', side: 'buy', type: 'limit', qty: 1, px: 19_999, bracket: { stopTicks: 8, targetTicks: [4] } },
    });
  });

  it.each([
    [{ qty: -1 }, 'positive'],
    [{ qty: Number.NaN }, 'positive'],
    [{ qty: 6 }, 'max order size'],
    [{ qty: 4 }, 'strategy limit'],
    [{ side: 'long' }, 'Side'],
    [{ type: 'iceberg' }, 'Order type'],
    [{ type: 'limit' }, 'positive price'],
    [{ type: 'limit', price: 9000 }, 'away from the last price'],
    [{ bracket: { stop: -2 } }, 'Stop'],
    [{ bracket: { target: [1, 2, 3, 4, 5] } }, 'Up to 4'],
    [{ cid: 'evil();' }, 'order id'],
  ])('rejects %j', (patch, reason) => {
    const v = validateIntent(order(patch), INST, lim, st);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain(reason);
  });

  it('allows reducing orders beyond the position limit check', () => {
    expect(validateIntent(order({ side: 'sell', qty: 3 }), INST, lim, { last: 20_000, position: 3 }).ok).toBe(true);
    expect(validateIntent({ op: 'drop-tables' }, INST, lim, st).ok).toBe(false);
  });
});

describe('templates', () => {
  it.each(SCRIPT_TEMPLATES.map((t) => [t.id, t.source]))('%s compiles and loads', (_id, src) => {
    const { desc } = core(src);
    expect(desc.hooks).toContain('onBar');
    expect(parseTimeframe(desc.timeframe)).not.toBeNull();
  });

  it('MA cross backtest produces trades deterministically', async () => {
    const tpl = SCRIPT_TEMPLATES.find((t) => t.id === 'ma-cross')!;
    const run = () =>
      runScriptBacktest(compile(file(tpl.source)), new InProcessTransport(), data, CFG, {
        params: { fast: 3, slow: 8 },
        bars: { kind: 'time', ms: 60_000 },
      });
    const a = await run();
    const b = await run();
    expect(a.error).toBeNull();
    expect(a.result.trades.length).toBeGreaterThan(2);
    expect(a.result.trades.map((t) => [t.side, t.entryPx, t.exitPx, t.net])).toEqual(
      b.result.trades.map((t) => [t.side, t.entryPx, t.exitPx, t.net]),
    );
    expect(a.result.equity.length).toBeGreaterThan(10);
    expect(a.plots.some((p) => p.name === 'Fast MA')).toBe(true);
    expect(a.logs[0]!.text).toContain('MA cross started');
    expect(a.result.trades[0]!.entryLabel).toMatch(/MA cross/);
  });

  it.each(['delta-breakout', 'vwap-reversion', 'footprint-imbalance'])(
    '%s backtests without errors',
    async (id) => {
      const tpl = SCRIPT_TEMPLATES.find((t) => t.id === id)!;
      const r = await runScriptBacktest(compile(file(tpl.source)), new InProcessTransport(), data, CFG, {
        bars: { kind: 'time', ms: 60_000 },
      });
      expect(r.error).toBeNull();
      expect(r.calls).toBeGreaterThan(100);
    },
  );

  it('the risk engine stops a strategy at its position limit', async () => {
    const src = 'export function onBar() { buy(1); }';
    const r = await runScriptBacktest(compile(file(src)), new InProcessTransport(), data, CFG, {
      bars: { kind: 'time', ms: 300_000 },
      limits: { ...DEFAULT_ORDER_LIMITS, maxPosition: 2 },
    });
    expect(r.logs.some((l) => l.text.includes('strategy limit of 2'))).toBe(true);
    expect(r.result.trades.reduce((a, t) => a + t.qty, 0)).toBeLessThanOrEqual(2);
  });
});

describe('.htstrat', () => {
  it('round-trips and validates', () => {
    const p = {
      id: 'stg-1',
      name: 'X',
      files: [file('export function onBar() {}')],
      params: { fast: 3 },
      createdAt: 1,
      updatedAt: 2,
    };
    expect(parseHtstrat(serializeHtstrat(p))).toEqual(p);
    expect(() => parseHtstrat('{}')).toThrow(/Not a .htstrat/);
    expect(() =>
      parseHtstrat(JSON.stringify({ format: 'htstrat', version: 1, files: [{ name: '../x.ts', source: '' }] })),
    ).toThrow(/Invalid file name/);
  });
});
