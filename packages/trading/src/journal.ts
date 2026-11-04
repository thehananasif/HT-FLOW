import type { Fill } from './types';

export interface RoundTrip {
  instrumentId: string;
  accountId: string;
  side: 'long' | 'short';
  qty: number;
  entryPx: number;
  exitPx: number;
  entryTs: number;
  exitTs: number;
  pnl: number;
  commission: number;
}

export interface JournalStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
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
    { side: 1 | -1; lots: { qty: number; px: number; ts: number; comm: number }[] }
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
    if (book.side === dir) {
      book.lots.push({ qty: rem, px: f.px, ts: f.ts, comm: commPerUnit });
      continue;
    }
    while (rem > 1e-12 && book.lots.length) {
      const lot = book.lots[0]!;
      const q = Math.min(rem, lot.qty);
      const pnl = (f.px - lot.px) * book.side * q * pnlPerTick(f.instrumentId);
      out.push({
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
      });
      lot.qty -= q;
      rem -= q;
      if (lot.qty <= 1e-12) book.lots.shift();
    }
    if (rem > 1e-12) {
      book.side = dir;
      book.lots.push({ qty: rem, px: f.px, ts: f.ts, comm: commPerUnit });
    }
  }
  return out;
}

export function journalStats(trips: readonly RoundTrip[]): JournalStats {
  let wins = 0;
  let losses = 0;
  let gp = 0;
  let gl = 0;
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trips) {
    const net = t.pnl - t.commission;
    if (net > 0) {
      wins++;
      gp += net;
    } else {
      losses++;
      gl += -net;
    }
    equity += net;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  const n = trips.length;
  return {
    trades: n,
    wins,
    losses,
    winRate: n ? wins / n : 0,
    netPnl: gp - gl,
    grossProfit: gp,
    grossLoss: gl,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    expectancy: n ? (gp - gl) / n : 0,
    avgWin: wins ? gp / wins : 0,
    avgLoss: losses ? gl / losses : 0,
    maxDrawdown: maxDd,
  };
}
