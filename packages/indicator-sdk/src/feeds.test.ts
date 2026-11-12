import { describe, expect, it } from 'vitest';
import type { Bar, FundingStat, LiquidationStat, OpenInterestStat } from '@htflow/market-data';
import {
  DerivativesLog,
  IndicatorRuntime,
  NO_FEED_NOTICE,
  between,
  defineIndicator,
  input,
  lastAtOrBefore,
  output,
  type DerivativesSource,
} from './index';

const bar = (t: number): Bar => ({
  t,
  tEnd: t + 1,
  o: 1,
  h: 1,
  l: 1,
  c: 1,
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

describe('DerivativesLog', () => {
  it('attaches to a store: seeds with the latest values and follows events', () => {
    const fl = new Set<(f: FundingStat) => void>();
    const ol = new Set<(o: OpenInterestStat) => void>();
    const ll = new Set<(l: LiquidationStat[]) => void>();
    const src: DerivativesSource = {
      funding: { kind: 'funding', ts: 1, rate: 0.1, nextTs: 0, markPrice: 1 },
      openInterest: null,
      liquidations: [{ kind: 'liquidation', ts: 2, side: 'buy', px: 1, qty: 1 }],
      onFunding: (f) => (fl.add(f), () => fl.delete(f)),
      onOpenInterest: (f) => (ol.add(f), () => ol.delete(f)),
      onLiquidation: (f) => (ll.add(f), () => ll.delete(f)),
    };
    const log = new DerivativesLog();
    const off = log.attach(src);
    expect([log.funding.length, log.openInterest.length, log.liquidations.length]).toEqual([
      1, 0, 1,
    ]);
    const v = log.version;
    for (const f of fl) f({ kind: 'funding', ts: 5, rate: 0.2, nextTs: 0, markPrice: 1 });
    for (const f of fl) f({ kind: 'funding', ts: 3, rate: 0.9, nextTs: 0, markPrice: 1 }); // out of order: ignored
    for (const f of ol) f({ kind: 'open_interest', ts: 6, oi: 1, value: 1 });
    expect(log.funding.map((x) => x.ts)).toEqual([1, 5]);
    expect(log.openInterest).toHaveLength(1);
    expect(log.version).toBeGreaterThan(v);
    off();
    expect(fl.size + ol.size + ll.size).toBe(0);
  });
  it('search helpers', () => {
    const a = [{ ts: 1 }, { ts: 5 }, { ts: 9 }];
    expect(lastAtOrBefore(a, 5, (x) => x.ts)?.ts).toBe(5);
    expect(lastAtOrBefore(a, 0, (x) => x.ts)).toBeUndefined();
    expect(between(a, 2, 9, (x) => x.ts).map((x) => x.ts)).toEqual([5, 9]);
  });
});

describe('runtime feeds and notice', () => {
  const def = defineIndicator({
    id: 'feed-probe',
    name: 'probe',
    category: 'crypto',
    pane: 'new',
    description: '',
    inputs: { x: input.int('x', 1) },
    outputs: { v: output.line('v', '#ffffff') },
    calc(ctx) {
      const f = ctx.derivatives?.funding ?? [];
      if (!f.length) {
        ctx.notice(NO_FEED_NOTICE);
        return;
      }
      ctx.out.v.set(ctx.i, f.length);
    },
  });
  it('notice reflects the last bar and clears when data arrives; feed changes recompute the last bar', () => {
    const rt = new IndicatorRuntime(def);
    const log = new DerivativesLog();
    const bars = [bar(0), bar(10)];
    const data = { bars, version: 1, tickSize: 1, derivatives: log };
    rt.update(data);
    expect(rt.notice).toBe('no data from this feed');
    expect(rt.update(data)).toBe('none');
    log.addFunding({ kind: 'funding', ts: 1, rate: 0, nextTs: 0, markPrice: 1 });
    expect(rt.update(data)).toBe('incremental');
    expect(rt.notice).toBeNull();
    expect(rt.valueAt('v', 1)).toBe(1);
  });
});
