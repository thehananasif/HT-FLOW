import type { Fill } from './types';

export interface RoundTrip {
  /** Stable id: `<exit fill id>:<n>` (or a manual-entry id). */
  id: string;
  instrumentId: string;
  accountId: string;
  side: 'long' | 'short';
  qty: number;
  /** Prices in ticks. */
  entryPx: number;
  exitPx: number;
  entryTs: number;
  exitTs: number;
  /** Gross P&L in account currency (before commission). */
  pnl: number;
  commission: number;
  entryOrderId?: string;
  exitOrderId?: string;
  /** Money at risk at entry (stop distance × value), when known — enables R multiples. */
  risk?: number;
  manual?: boolean;
}

export interface JournalStats {
  trades: number;
  wins: number;
  losses: number;
  /** Trades that netted exactly zero. */
  breakeven: number;
  winRate: number;
  longTrades: number;
  shortTrades: number;
  longWinRate: number;
  shortWinRate: number;
  /** Net P&L after commission. */
  netPnl: number;
  commission: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  /** Net P&L per trade. */
  expectancy: number;
  /** Mean R multiple over trades with a known risk (NaN when none). */
  expectancyR: number;
  rTrades: number;
  avgWin: number;
  avgLoss: number;
  /** avgWin / avgLoss. */
  winLossRatio: number;
  maxDrawdown: number;
  /** Max drawdown as a fraction of the equity peak (starting balance + cumulative net). */
  maxDrawdownPct: number;
  /** Exit time of the trade at the bottom of the max drawdown (NaN when none). */
  maxDrawdownTs: number;
  bestSetup: TagStats | null;
}

export interface TagStats {
  tag: string;
  trades: number;
  wins: number;
  net: number;
}

export interface JournalStatsOptions {
  startingBalance?: number;
  /** Setup tags per trip (for "best setup"). */
  tagsOf?(trip: RoundTrip): readonly string[];
}

export const netOf = (t: RoundTrip): number => t.pnl - t.commission;

/** R multiple of a trip, or null when its risk is unknown. */
export function rMultiple(t: RoundTrip): number | null {
  return t.risk && t.risk > 0 ? netOf(t) / t.risk : null;
}

/**
 * Groups fills into FIFO round trips (P36). `pnlPerTick(instrumentId)` converts ticks × qty into money.
 */
export function roundTrips(
  fills: readonly Fill[],
  pnlPerTick: (instrumentId: string) => number,
): RoundTrip[] {
  const open = new Map<
    string,
    {
      side: 1 | -1;
      lots: { qty: number; px: number; ts: number; comm: number; orderId: string }[];
    }
  >();
  const out: RoundTrip[] = [];
  for (const f of fills) {
    const key = `${f.accountId}|${f.instrumentId}`;
    const dir: 1 | -1 = f.side === 'buy' ? 1 : -1;
    let book = open.get(key);
    if (!book || book.lots.length === 0) {
      book = { side: dir, lots: [] };
      open.set(key, book);
    }
    let rem = f.qty;
    const commPerUnit = f.commission / f.qty;
    // A fill that closed a position whose opening fills are not in the list (e.g. a position
    // restored after a restart): book the missing part as a lot at the engine's average entry.
    if (f.closedQty && f.entryAvg !== undefined) {
      const have = book.side === -dir ? book.lots.reduce((a, l) => a + l.qty, 0) : 0;
      const missing = f.closedQty - have;
      if (missing > 1e-12) {
        if (book.side !== -dir) book = { side: (-dir) as 1 | -1, lots: [] };
        open.set(key, book);
        book.lots.push({ qty: missing, px: f.entryAvg, ts: f.ts, comm: 0, orderId: '' });
      }
    }
    if (book.side === dir) {
      book.lots.push({ qty: rem, px: f.px, ts: f.ts, comm: commPerUnit, orderId: f.orderId });
      continue;
    }
    let n = 0;
    while (rem > 1e-12 && book.lots.length) {
      const lot = book.lots[0]!;
      const q = Math.min(rem, lot.qty);
      const pnl = (f.px - lot.px) * book.side * q * pnlPerTick(f.instrumentId);
      out.push({
        id: `${f.id}:${n++}`,
        instrumentId: f.instrumentId,
        accountId: f.accountId,
        side: book.side === 1 ? 'long' : 'short',
        qty: q,
        entryPx: lot.px,
        exitPx: f.px,
        entryTs: lot.ts,
        exitTs: f.ts,
        pnl,
        commission: (lot.comm + commPerUnit) * q,
        entryOrderId: lot.orderId || undefined,
        exitOrderId: f.orderId,
      });
      lot.qty -= q;
      rem -= q;
      if (lot.qty <= 1e-12) book.lots.shift();
    }
    if (rem > 1e-12) {
      book.side = dir;
      book.lots.push({ qty: rem, px: f.px, ts: f.ts, comm: commPerUnit, orderId: f.orderId });
    }
  }
  return out;
}

const byExit = (trips: readonly RoundTrip[]) =>
  [...trips].sort((a, b) => a.exitTs - b.exitTs || a.entryTs - b.entryTs);

export function journalStats(
  trips: readonly RoundTrip[],
  opts: JournalStatsOptions = {},
): JournalStats {
  const start = opts.startingBalance ?? 0;
  let wins = 0;
  let losses = 0;
  let be = 0;
  let gp = 0;
  let gl = 0;
  let comm = 0;
  let longN = 0;
  let shortN = 0;
  let longW = 0;
  let shortW = 0;
  let rSum = 0;
  let rN = 0;
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let maxDdPct = 0;
  let maxDdTs = Number.NaN;
  for (const t of byExit(trips)) {
    const net = netOf(t);
    comm += t.commission;
    if (net > 0) {
      wins++;
      gp += net;
    } else if (net < 0) {
      losses++;
      gl += -net;
    } else be++;
    if (t.side === 'long') {
      longN++;
      if (net > 0) longW++;
    } else {
      shortN++;
      if (net > 0) shortW++;
    }
    const r = rMultiple(t);
    if (r !== null) {
      rSum += r;
      rN++;
    }
    equity += net;
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdTs = t.exitTs;
      const base = start + peak;
      maxDdPct = base > 0 ? dd / base : 0;
    }
  }
  const n = trips.length;
  const avgWin = wins ? gp / wins : 0;
  const avgLoss = losses ? gl / losses : 0;
  return {
    trades: n,
    wins,
    losses,
    breakeven: be,
    winRate: n ? wins / n : 0,
    longTrades: longN,
    shortTrades: shortN,
    longWinRate: longN ? longW / longN : 0,
    shortWinRate: shortN ? shortW / shortN : 0,
    netPnl: gp - gl,
    commission: comm,
    grossProfit: gp,
    grossLoss: gl,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    expectancy: n ? (gp - gl) / n : 0,
    expectancyR: rN ? rSum / rN : Number.NaN,
    rTrades: rN,
    avgWin,
    avgLoss,
    winLossRatio: avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    maxDrawdownTs: maxDdTs,
    bestSetup: opts.tagsOf ? (statsByTag(trips, opts.tagsOf)[0] ?? null) : null,
  };
}

/** Net P&L per tag, best first. */
export function statsByTag(
  trips: readonly RoundTrip[],
  tagsOf: (t: RoundTrip) => readonly string[],
): TagStats[] {
  const m = new Map<string, TagStats>();
  for (const t of trips) {
    const net = netOf(t);
    for (const tag of new Set(tagsOf(t))) {
      let s = m.get(tag);
      if (!s) m.set(tag, (s = { tag, trades: 0, wins: 0, net: 0 }));
      s.trades++;
      if (net > 0) s.wins++;
      s.net += net;
    }
  }
  return [...m.values()].sort((a, b) => b.net - a.net || b.trades - a.trades);
}

export const utcDayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

export const localDayKey = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export interface DayPnl {
  net: number;
  trades: number;
  wins: number;
}

/** Net P&L per day of exit (calendar heatmap). */
export function dailyPnl(
  trips: readonly RoundTrip[],
  keyOf: (ts: number) => string = utcDayKey,
): Map<string, DayPnl> {
  const m = new Map<string, DayPnl>();
  for (const t of byExit(trips)) {
    const k = keyOf(t.exitTs);
    let d = m.get(k);
    if (!d) m.set(k, (d = { net: 0, trades: 0, wins: 0 }));
    const net = netOf(t);
    d.net += net;
    d.trades++;
    if (net > 0) d.wins++;
  }
  return m;
}

export interface EquityPoint {
  ts: number;
  equity: number;
  /** ≤ 0: distance below the running peak. */
  drawdown: number;
}

/** Cumulative net equity after each trip, with the running drawdown. */
export function equityCurve(trips: readonly RoundTrip[]): EquityPoint[] {
  let eq = 0;
  let peak = 0;
  return byExit(trips).map((t) => {
    eq += netOf(t);
    peak = Math.max(peak, eq);
    return { ts: t.exitTs, equity: eq, drawdown: eq - peak };
  });
}

/**
 * Maximum adverse / favourable excursion in ticks during the hold, from the tape. MAE ≤ 0,
 * MFE ≥ 0. Trades outside [entryTs, exitTs] are ignored; the exit price always counts.
 */
export function excursion(
  t: Pick<RoundTrip, 'side' | 'entryPx' | 'exitPx' | 'entryTs' | 'exitTs'>,
  tape: readonly { ts: number; px: number }[],
): { maeTicks: number; mfeTicks: number; samples: number } {
  const dir = t.side === 'long' ? 1 : -1;
  let best = Math.max(0, (t.exitPx - t.entryPx) * dir);
  let worst = Math.min(0, (t.exitPx - t.entryPx) * dir);
  let n = 0;
  for (const p of tape) {
    if (p.ts < t.entryTs || p.ts > t.exitTs) continue;
    const d = (p.px - t.entryPx) * dir;
    if (d > best) best = d;
    if (d < worst) worst = d;
    n++;
  }
  return { maeTicks: worst, mfeTicks: best, samples: n };
}

export type JournalPeriod = 'today' | 'week' | 'month' | 'year' | 'all';

/** Start (local time) of the period containing `now`; weeks start on Monday. */
export function periodStart(period: JournalPeriod, now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  switch (period) {
    case 'today':
      return d.getTime();
    case 'week': {
      const dow = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - dow);
      return d.getTime();
    }
    case 'month':
      d.setDate(1);
      return d.getTime();
    case 'year':
      d.setMonth(0, 1);
      return d.getTime();
    default:
      return -Infinity;
  }
}
