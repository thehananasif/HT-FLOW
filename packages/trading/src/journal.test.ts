import { describe, expect, it } from 'vitest';
import { OrderBook } from '@htflow/market-data';
import { PaperEngine } from './paperEngine';
import {
  dailyPnl,
  equityCurve,
  excursion,
  journalStats,
  periodStart,
  rMultiple,
  roundTrips,
  statsByTag,
  utcDayKey,
  type RoundTrip,
} from './journal';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TV = 12.5; // $ per tick per contract
const COMM = 2.25; // $ per contract per side
const START = 50_000;
const TAGS = ['Absorption', 'POC retest', 'Breakout', 'Failed auction'];

/** One spreadsheet row per closed lot (what a trader would type into Excel). */
interface Row {
  long: boolean;
  qty: number;
  entryPx: number;
  exitPx: number;
  exitTs: number;
  riskTicks: number | null;
  tag: string;
}

function simulate500() {
  const r = rng(20261104);
  const book = new OrderBook();
  const quote = (bid: number, ask: number) =>
    book.applySnapshot({ ts: 0, bids: [[bid, 10_000]], asks: [[ask, 10_000]] });
  let now = Date.UTC(2026, 7, 3, 13, 30);
  const eng = new PaperEngine({
    book: () => book,
    economics: () => ({ tickSize: 0.25, tickValue: TV }),
    now: () => now,
  });
  eng.createAccount({ id: 'P', name: 'Paper', startingBalance: START, commissionPerUnit: COMM });
  const rows: Row[] = [];
  const riskByOrder = new Map<string, number>();
  const tagByOrder = new Map<string, string>();
  for (let i = 0; i < 500; i++) {
    now += Math.floor(5 + r() * 400) * 60_000;
    const long = r() < 0.55;
    const qty = 1 + Math.floor(r() * 4);
    const mid = 20_000 + Math.floor(r() * 400) - 200;
    quote(mid - 1, mid);
    const entry = eng.place({
      accountId: 'P',
      instrumentId: 'NQ',
      side: long ? 'buy' : 'sell',
      type: 'market',
      qty,
    });
    const entryPx = long ? mid : mid - 1;
    expect(entry.avgFillPx).toBe(entryPx);
    const riskTicks = i % 3 === 0 ? null : 4 + Math.floor(r() * 16);
    if (riskTicks !== null) riskByOrder.set(entry.id, riskTicks);
    const tag = TAGS[i % TAGS.length]!;
    tagByOrder.set(entry.id, tag);
    const dir = long ? 1 : -1;
    const exitSide = long ? 'sell' : 'buy';
    // Exit in one or two pieces; profitable exits sometimes rest as limits (maker fills).
    const parts = qty >= 2 && r() < 0.3 ? [Math.floor(qty / 2), qty - Math.floor(qty / 2)] : [qty];
    for (const q of parts) {
      now += Math.floor(1 + r() * 120) * 60_000;
      const move = Math.floor(r() * 61) - 30;
      const exitPx = entryPx + dir * move;
      if (move > 0 && r() < 0.5) {
        // Resting take-profit limit, filled when the tape trades through it.
        if (long) quote(exitPx - 6, exitPx - 5);
        else quote(exitPx + 5, exitPx + 6);
        const o = eng.place({
          accountId: 'P',
          instrumentId: 'NQ',
          side: exitSide,
          type: 'limit',
          px: exitPx,
          qty: q,
        });
        expect(o.status).toBe('working');
        eng.onTrade('NQ', { ts: now, px: exitPx + dir, qty: 1, side: 'buy', id: i });
        expect(o.status).toBe('filled');
      } else {
        if (long) quote(exitPx, exitPx + 1);
        else quote(exitPx - 1, exitPx);
        const o = eng.place({
          accountId: 'P',
          instrumentId: 'NQ',
          side: exitSide,
          type: 'market',
          qty: q,
        });
        expect(o.avgFillPx).toBe(exitPx);
      }
      rows.push({ long, qty: q, entryPx, exitPx, exitTs: now, riskTicks, tag });
    }
    expect(eng.position('P', 'NQ').qty).toBe(0);
  }
  return { eng, rows, riskByOrder, tagByOrder };
}

describe('Trading Journal — acceptance: 500 deterministic paper trades', () => {
  const { eng, rows, riskByOrder, tagByOrder } = simulate500();
  const trips = roundTrips(eng.fills, () => TV).map((t) => {
    const rt = riskByOrder.get(t.entryOrderId!);
    return rt === undefined ? t : { ...t, risk: rt * TV * t.qty };
  });
  const tagsOf = (t: RoundTrip) => [tagByOrder.get(t.entryOrderId!)!];
  const s = journalStats(trips, { startingBalance: START, tagsOf });

  // ---- the independent "spreadsheet" calculation, straight from the rows ----
  const net = rows.map(
    (x) => (x.exitPx - x.entryPx) * (x.long ? 1 : -1) * x.qty * TV - 2 * COMM * x.qty,
  );
  const sum = (a: number[]) => a.reduce((p, v) => p + v, 0);
  const winsN = net.filter((v) => v > 0);
  const lossN = net.filter((v) => v < 0);
  const longRows = rows.map((x, i) => [x, net[i]!] as const).filter(([x]) => x.long);
  const shortRows = rows.map((x, i) => [x, net[i]!] as const).filter(([x]) => !x.long);
  const rs = rows
    .map((x, i) => (x.riskTicks === null ? null : net[i]! / (x.riskTicks * TV * x.qty)))
    .filter((v): v is number => v !== null);

  it('groups every fill into the expected round trips', () => {
    expect(eng.fills.length).toBeGreaterThan(500);
    expect(trips).toHaveLength(rows.length);
    expect(new Set(trips.map((t) => t.id)).size).toBe(trips.length);
    trips.forEach((t, i) => {
      expect(t.entryPx).toBe(rows[i]!.entryPx);
      expect(t.exitPx).toBe(rows[i]!.exitPx);
      expect(t.qty).toBe(rows[i]!.qty);
      expect(t.pnl - t.commission).toBe(net[i]);
    });
  });

  it('counts, win rates and the long/short split match', () => {
    expect(s.trades).toBe(rows.length);
    expect(s.wins).toBe(winsN.length);
    expect(s.losses).toBe(lossN.length);
    expect(s.breakeven).toBe(rows.length - winsN.length - lossN.length);
    expect(s.winRate).toBeCloseTo(winsN.length / rows.length, 12);
    expect(s.longTrades).toBe(longRows.length);
    expect(s.shortTrades).toBe(shortRows.length);
    expect(s.longWinRate).toBeCloseTo(
      longRows.filter(([, v]) => v > 0).length / longRows.length,
      12,
    );
    expect(s.shortWinRate).toBeCloseTo(
      shortRows.filter(([, v]) => v > 0).length / shortRows.length,
      12,
    );
  });

  it('money stats match: net after commission, gross, PF, expectancy ($ and R), averages', () => {
    expect(s.netPnl).toBeCloseTo(sum(net), 6);
    expect(s.commission).toBeCloseTo(sum(rows.map((x) => 2 * COMM * x.qty)), 6);
    expect(s.grossProfit).toBeCloseTo(sum(winsN), 6);
    expect(s.grossLoss).toBeCloseTo(-sum(lossN), 6);
    expect(s.profitFactor).toBeCloseTo(sum(winsN) / -sum(lossN), 9);
    expect(s.expectancy).toBeCloseTo(sum(net) / rows.length, 9);
    expect(s.rTrades).toBe(rs.length);
    expect(s.expectancyR).toBeCloseTo(sum(rs) / rs.length, 9);
    expect(s.avgWin).toBeCloseTo(sum(winsN) / winsN.length, 9);
    expect(s.avgLoss).toBeCloseTo(-sum(lossN) / lossN.length, 9);
    expect(s.winLossRatio).toBeCloseTo(sum(winsN) / winsN.length / (-sum(lossN) / lossN.length), 9);
    // The engine's cash balance agrees with the journal's net P&L.
    expect(eng.accounts.get('P')!.balance - START).toBeCloseTo(sum(net), 6);
  });

  it('max drawdown ($, %, date), equity curve and best setup match', () => {
    let eq = 0;
    let peak = 0;
    let dd = 0;
    let ddTs = Number.NaN;
    let ddPct = 0;
    for (let i = 0; i < net.length; i++) {
      eq += net[i]!;
      if (eq > peak) peak = eq;
      if (peak - eq > dd) {
        dd = peak - eq;
        ddTs = rows[i]!.exitTs;
        ddPct = dd / (START + peak);
      }
    }
    expect(s.maxDrawdown).toBeCloseTo(dd, 6);
    expect(s.maxDrawdownTs).toBe(ddTs);
    expect(s.maxDrawdownPct).toBeCloseTo(ddPct, 12);
    const curve = equityCurve(trips);
    expect(curve).toHaveLength(rows.length);
    expect(curve.at(-1)!.equity).toBeCloseTo(sum(net), 6);
    expect(Math.min(...curve.map((p) => p.drawdown))).toBeCloseTo(-dd, 6);

    const byTag = new Map<string, number>();
    rows.forEach((x, i) => byTag.set(x.tag, (byTag.get(x.tag) ?? 0) + net[i]!));
    const best = [...byTag].sort((a, b) => b[1] - a[1])[0]!;
    expect(s.bestSetup?.tag).toBe(best[0]);
    expect(s.bestSetup?.net).toBeCloseTo(best[1], 6);
    expect(s.bestSetup?.trades).toBe(rows.filter((x) => x.tag === best[0]).length);
  });

  it('daily P&L (calendar heatmap) matches a per-day sum', () => {
    const days = dailyPnl(trips, utcDayKey);
    const expected = new Map<string, number>();
    rows.forEach((x, i) => {
      const k = new Date(x.exitTs).toISOString().slice(0, 10);
      expected.set(k, (expected.get(k) ?? 0) + net[i]!);
    });
    expect(days.size).toBe(expected.size);
    expect(days.size).toBeGreaterThan(30);
    for (const [k, v] of expected) expect(days.get(k)!.net).toBeCloseTo(v, 6);
    expect(sum([...days.values()].map((d) => d.trades))).toBe(rows.length);
  });
});

describe('journal helpers', () => {
  const trip = (o: Partial<RoundTrip>): RoundTrip => ({
    id: 'x',
    instrumentId: 'I',
    accountId: 'A',
    side: 'long',
    qty: 1,
    entryPx: 100,
    exitPx: 110,
    entryTs: 1000,
    exitTs: 2000,
    pnl: 10,
    commission: 0,
    ...o,
  });

  it('MAE / MFE in ticks from the tape during the hold', () => {
    const tape = [
      { ts: 500, px: 50 }, // before entry: ignored
      { ts: 1100, px: 96 },
      { ts: 1500, px: 118 },
      { ts: 1900, px: 109 },
      { ts: 2500, px: 200 }, // after exit: ignored
    ];
    expect(excursion(trip({}), tape)).toEqual({ maeTicks: -4, mfeTicks: 18, samples: 3 });
    expect(excursion(trip({ side: 'short', exitPx: 95 }), tape)).toEqual({
      maeTicks: -18,
      mfeTicks: 5,
      samples: 3,
    });
    expect(excursion(trip({}), [])).toEqual({ maeTicks: 0, mfeTicks: 10, samples: 0 });
  });

  it('R multiple, tags, empty stats', () => {
    expect(rMultiple(trip({ pnl: 30, commission: 5, risk: 50 }))).toBe(0.5);
    expect(rMultiple(trip({}))).toBeNull();
    const by = statsByTag([trip({ pnl: 5 }), trip({ pnl: -20 })], (t) =>
      t.pnl > 0 ? ['A', 'B'] : ['B'],
    );
    expect(by.map((x) => [x.tag, x.net, x.trades])).toEqual([
      ['A', 5, 1],
      ['B', -15, 2],
    ]);
    const e = journalStats([]);
    expect(e.trades).toBe(0);
    expect(e.profitFactor).toBe(0);
    expect(Number.isNaN(e.expectancyR)).toBe(true);
    expect(e.bestSetup).toBeNull();
  });

  it('period starts are local midnights (week starts Monday)', () => {
    const now = new Date(2026, 10, 5, 14, 30).getTime(); // Thu 5 Nov 2026
    expect(periodStart('today', now)).toBe(new Date(2026, 10, 5).getTime());
    expect(periodStart('week', now)).toBe(new Date(2026, 10, 2).getTime());
    expect(periodStart('month', now)).toBe(new Date(2026, 10, 1).getTime());
    expect(periodStart('year', now)).toBe(new Date(2026, 0, 1).getTime());
    expect(periodStart('all', now)).toBe(-Infinity);
  });
});
