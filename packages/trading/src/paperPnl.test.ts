import { describe, expect, it } from 'vitest';
import { OrderBook, type Trade } from '@htflow/market-data';
import { PaperEngine, type InstrumentEconomics } from './index';
import { roundTrips } from './journal';
import { normalizeAccountState } from './persistState';

/** Engine on a one-level book around `px` (bid px, ask px + 1), prices in ticks. */
function setup(econ: InstrumentEconomics, opts: { commission?: number } = {}) {
  const book = new OrderBook();
  const quote = (px: number) =>
    book.applySnapshot({ ts: 0, bids: [[px, 1000]], asks: [[px + 1, 1000]] });
  quote(100);
  let t = 0;
  const eng = new PaperEngine({ book: () => book, economics: () => econ, now: () => ++t });
  eng.createAccount({
    id: 'A',
    name: 'Paper',
    startingBalance: 10_000,
    commissionPerUnit: opts.commission ?? 0,
  });
  /** Moves the market: book around `px` and one trade at `px`. */
  const move = (px: number) => {
    quote(px);
    eng.onTrade('X', { ts: 0, px, qty: 1, side: 'buy', id: 0 } satisfies Trade);
  };
  const buy = (qty: number) =>
    eng.place({ accountId: 'A', instrumentId: 'X', side: 'buy', type: 'market', qty });
  const sell = (qty: number) =>
    eng.place({ accountId: 'A', instrumentId: 'X', side: 'sell', type: 'market', qty });
  return { eng, book, quote, move, buy, sell };
}

// Futures-style: 1 tick = $12.50 per contract. Crypto-style: linear, tick 0.5 price units.
const FUT: InstrumentEconomics = { tickSize: 0.25, tickValue: 12.5 };
const LIN: InstrumentEconomics = { tickSize: 0.5, tickValue: 0 };

describe('paper P&L end to end', () => {
  it('buy 1 @ 100, price to 105 → unrealized +5 × multiplier; sell → realized', () => {
    const { eng, quote, move, buy, sell } = setup(FUT);
    quote(99); // ask = 100
    buy(1);
    expect(eng.position('A', 'X')).toMatchObject({ qty: 1, avgPx: 100 });
    move(105);
    expect(eng.mark('X')).toBe(105);
    expect(eng.unrealized('A', 'X')).toBe(5 * 12.5);
    expect(eng.openPnl('A')).toBe(62.5);
    sell(1); // bid = 105
    expect(eng.position('A', 'X').qty).toBe(0);
    expect(eng.unrealized('A', 'X')).toBe(0);
    const s = eng.pnlSummary('A');
    expect(s.realized).toBe(62.5);
    expect(s.open).toBe(0);
    expect(eng.accounts.get('A')!.balance).toBe(10_062.5);
    expect(eng.fills.at(-1)).toMatchObject({ realized: 62.5, closedQty: 1, entryAvg: 100 });
  });

  it('linear crypto quantity: P&L = price move × quantity', () => {
    const { eng, quote, move, buy } = setup(LIN);
    quote(199); // ask 200 ticks = 100.0
    buy(0.5);
    move(220); // +20 ticks = +10.0 price units
    expect(eng.unrealized('A', 'X')).toBeCloseTo(10 * 0.5);
  });

  it('partial closes realize per closed quantity and keep the average', () => {
    const { eng, quote, move, buy, sell } = setup(FUT);
    quote(99);
    buy(2); // 2 @ 100
    quote(101);
    buy(2); // 2 @ 102 → avg 101
    expect(eng.position('A', 'X').avgPx).toBe(101);
    move(104);
    sell(1); // 1 @ 104: +3 ticks
    expect(eng.position('A', 'X')).toMatchObject({ qty: 3, avgPx: 101 });
    expect(eng.pnlSummary('A').realized).toBe(3 * 12.5);
    expect(eng.unrealized('A', 'X')).toBe(3 * 3 * 12.5);
    move(99);
    sell(3); // 3 @ 99: −2 ticks each
    expect(eng.pnlSummary('A').realized).toBe(3 * 12.5 - 6 * 12.5);
  });

  it('reversal closes the old side (realized) and opens the rest at the fill price', () => {
    const { eng, quote, move, buy, sell } = setup(FUT);
    quote(99);
    buy(1); // long 1 @ 100
    move(110);
    sell(3); // close 1 @ 110 (+10 ticks), short 2 @ 110
    expect(eng.position('A', 'X')).toMatchObject({ qty: -2, avgPx: 110 });
    expect(eng.pnlSummary('A').realized).toBe(125);
    move(106);
    expect(eng.unrealized('A', 'X')).toBe(2 * 4 * 12.5);
    eng.reverse('A', 'X'); // buy 4 @ ask 107: cover 2 (+3 ticks each), long 2 @ 107
    expect(eng.position('A', 'X')).toMatchObject({ qty: 2, avgPx: 107 });
    expect(eng.pnlSummary('A').realized).toBe(125 + 2 * 3 * 12.5);
  });

  it('short side: gains when the price falls', () => {
    const { eng, quote, move, sell, buy } = setup(FUT);
    quote(100);
    sell(2); // 2 @ bid 100
    move(95);
    expect(eng.unrealized('A', 'X')).toBe(2 * 5 * 12.5);
    quote(94); // ask 95
    buy(2);
    expect(eng.pnlSummary('A').realized).toBe(125);
  });

  it('resting limit fills only when the price crosses it, at the limit price', () => {
    const { eng, move } = setup(FUT);
    const o = eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'buy',
      type: 'limit',
      px: 95,
      qty: 1,
    });
    expect(o.status).toBe('working');
    move(96);
    move(95); // touch: queue model needs a trade through
    expect(o.status).toBe('working');
    move(94);
    expect(o.status).toBe('filled');
    expect(eng.position('A', 'X')).toMatchObject({ qty: 1, avgPx: 95 });
    expect(eng.unrealized('A', 'X')).toBe(-12.5);
  });

  it('stop orders trigger on the last trade and fill at the touch plus slippage', () => {
    const { eng, quote, move, buy } = setup(FUT);
    eng.updateAccount('A', { slippageTicks: 2 });
    quote(99);
    buy(1);
    eng.place({
      accountId: 'A',
      instrumentId: 'X',
      side: 'sell',
      type: 'stop',
      stopPx: 96,
      qty: 1,
    });
    move(97);
    expect(eng.position('A', 'X').qty).toBe(1);
    move(96); // bid 96 − 2 ticks slippage = 94
    expect(eng.position('A', 'X').qty).toBe(0);
    expect(eng.fills.at(-1)!.px).toBe(94);
    expect(eng.pnlSummary('A').realized).toBe(-6 * 12.5);
  });

  it('fees reduce the balance and the net, not the gross realized', () => {
    const { eng, quote, move, buy, sell } = setup(FUT, { commission: 2 });
    quote(99);
    buy(1);
    move(104);
    sell(1);
    const s = eng.pnlSummary('A');
    expect(s.realized).toBe(50);
    expect(s.fees).toBe(4);
    expect(s.net).toBe(46);
    expect(eng.accounts.get('A')!.balance).toBe(10_046);
  });

  it('invalid instrument economics never zero the P&L', () => {
    const { eng, quote, move, buy } = setup({ tickSize: 0, tickValue: Number.NaN });
    quote(99);
    buy(2);
    move(103);
    expect(eng.unrealized('A', 'X')).toBe(2 * 3); // linear, 1 unit per tick
  });

  it('mark falls back to the app mark source, then the book mid, before any trade', () => {
    const book = new OrderBook();
    book.applySnapshot({ ts: 0, bids: [[100, 1]], asks: [[102, 1]] });
    let ext: number | undefined = 120;
    const eng = new PaperEngine({
      book: () => book,
      economics: () => FUT,
      mark: () => ext,
    });
    expect(eng.mark('X')).toBe(120);
    ext = undefined;
    expect(eng.mark('X')).toBe(101);
  });

  it('restored state keeps fills; the journal books a restored position on close', () => {
    const { eng, quote, buy } = setup(FUT);
    quote(99);
    buy(1);
    const saved = normalizeAccountState(JSON.parse(JSON.stringify(eng.exportAccountState('A'))));
    expect(saved.fills).toHaveLength(1);

    // Restart: only the open position survives (e.g. a save without fills).
    const b = setup(FUT);
    b.eng.importAccountState('A', { ...saved, fills: [] });
    b.move(104);
    expect(b.eng.unrealized('A', 'X')).toBe(4 * 12.5);
    b.sell(1); // bid 104
    const trips = roundTrips(b.eng.fills, () => 12.5);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ side: 'long', entryPx: 100, exitPx: 104, pnl: 50 });

    // A save with fills restores the trade history.
    const c = setup(FUT);
    c.eng.importAccountState('A', saved);
    expect(c.eng.fills).toHaveLength(1);
  });
});
