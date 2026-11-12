/** Chart → file exports (right-click → Export…): bars CSV, clusters CSV, bars JSON. */
import type { Bar, Instrument } from '@htflow/market-data';

const iso = (t: number) => new Date(t).toISOString();
const px = (ticks: number, inst: Instrument) =>
  (ticks * inst.tickSize).toFixed(Math.max(0, inst.pricePrecision));

export function barsCsv(bars: readonly Bar[], inst: Instrument): string {
  const rows = ['time,open,high,low,close,volume,buy,sell,delta,trades'];
  for (const b of bars)
    rows.push(
      [
        iso(b.t),
        px(b.o, inst),
        px(b.h, inst),
        px(b.l, inst),
        px(b.c, inst),
        b.vol,
        b.buy,
        b.sell,
        b.delta,
        b.trades,
      ].join(','),
    );
  return rows.join('\n') + '\n';
}

export function clustersCsv(bars: readonly Bar[], inst: Instrument): string {
  const rows = ['time,price,bid,ask,delta,trades'];
  for (const b of bars) {
    const levels = [...b.clusters.entries()].sort((a, c) => c[0] - a[0]);
    for (const [p, c] of levels)
      rows.push([iso(b.t), px(p, inst), c.bid, c.ask, c.ask - c.bid, c.trades].join(','));
  }
  return rows.join('\n') + '\n';
}

export function barsJson(bars: readonly Bar[], inst: Instrument): string {
  return JSON.stringify(
    {
      instrument: inst.id,
      symbol: inst.symbol,
      tickSize: inst.tickSize,
      bars: bars.map((b) => ({
        t: b.t,
        o: b.o * inst.tickSize,
        h: b.h * inst.tickSize,
        l: b.l * inst.tickSize,
        c: b.c * inst.tickSize,
        vol: b.vol,
        delta: b.delta,
        trades: b.trades,
      })),
    },
    null,
    1,
  );
}
