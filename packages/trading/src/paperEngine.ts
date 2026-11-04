import type { OrderBook, Side, Trade } from '@htflow/market-data';
import {
  pnlPerTick,
  type Account,
  type Fill,
  type InstrumentEconomics,
  type Order,
  type OrderRequest,
  type Position,
} from './types';

export interface PaperEngineDeps {
  book(instrumentId: string): OrderBook | undefined;
  economics(instrumentId: string): InstrumentEconomics;
  now?(): number;
}

type Listener = () => void;

let seq = 0;
const nextId = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

/**
 * Paper trading engine (P17). Market orders walk the live book; resting limits fill when the tape
 * trades through them; stops trigger on last trade. Brackets attach SL + N take-profit targets (OCO).
 */
export class PaperEngine {
  readonly accounts = new Map<string, Account>();
  readonly orders = new Map<string, Order>();
  readonly fills: Fill[] = [];
  private positions = new Map<string, Position>();
  private brackets = new Map<
    string,
    { accountId: string; instrumentId: string; spec: NonNullable<OrderRequest['bracket']> }
  >();
  private listeners = new Set<Listener>();
  version = 0;

  constructor(private deps: PaperEngineDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  createAccount(a: Partial<Account> & { id: string; name: string }): Account {
    const acc: Account = {
      kind: 'paper',
      currency: 'USD',
      startingBalance: 50_000,
      balance: a.startingBalance ?? 50_000,
      commissionPerUnit: 0,
      takerFee: 0,
      locked: false,
      ...a,
    };
    this.accounts.set(acc.id, acc);
    this.emit();
    return acc;
  }

  resetAccount(id: string): void {
    const a = this.accounts.get(id);
    if (!a) return;
    a.balance = a.startingBalance;
    a.locked = false;
    for (const [k, o] of this.orders) if (o.accountId === id) this.orders.delete(k);
    for (const k of [...this.positions.keys()])
      if (k.startsWith(id + '|')) this.positions.delete(k);
    this.emit();
  }

  setLocked(id: string, locked: boolean): void {
    const a = this.accounts.get(id);
    if (a) {
      a.locked = locked;
      this.emit();
    }
  }

  position(accountId: string, instrumentId: string): Position {
    const k = `${accountId}|${instrumentId}`;
    let p = this.positions.get(k);
    if (!p) {
      p = { instrumentId, qty: 0, avgPx: 0, realized: 0 };
      this.positions.set(k, p);
    }
    return p;
  }

  allPositions(accountId?: string): (Position & { accountId: string })[] {
    const out: (Position & { accountId: string })[] = [];
    for (const [k, p] of this.positions) {
      const acc = k.split('|')[0]!;
      if (p.qty !== 0 && (!accountId || acc === accountId)) out.push({ ...p, accountId: acc });
    }
    return out;
  }

  workingOrders(accountId?: string, instrumentId?: string): Order[] {
    return [...this.orders.values()].filter(
      (o) =>
        (o.status === 'working' || o.status === 'partial') &&
        (!accountId || o.accountId === accountId) &&
        (!instrumentId || o.instrumentId === instrumentId),
    );
  }

  /** Unrealized PnL in account currency at the given mark (ticks). */
  unrealized(accountId: string, instrumentId: string, markPx: number): number {
    const p = this.position(accountId, instrumentId);
    if (!p.qty) return 0;
    return (markPx - p.avgPx) * pnlPerTick(this.deps.economics(instrumentId), p.qty);
  }

  place(req: OrderRequest): Order {
    const acc = this.accounts.get(req.accountId);
    const t = this.now();
    const order: Order = {
      id: nextId('o'),
      accountId: req.accountId,
      instrumentId: req.instrumentId,
      side: req.side,
      type: req.type,
      qty: req.qty,
      filled: 0,
      px: req.px,
      stopPx: req.stopPx,
      tif: req.tif ?? 'GTC',
      reduceOnly: req.reduceOnly ?? false,
      status: 'working',
      avgFillPx: 0,
      createdAt: t,
      updatedAt: t,
      role: req.bracket ? 'entry' : undefined,
    };
    const reject = (reason: string) => {
      order.status = 'rejected';
      order.reason = reason;
      this.orders.set(order.id, order);
      this.emit();
      return order;
    };
    if (!acc) return reject('Unknown account');
    if (acc.locked) return reject('Trading locked');
    if (!(req.qty > 0)) return reject('Quantity must be > 0');
    if ((req.type === 'limit' || req.type === 'stop-limit') && req.px === undefined)
      return reject('Limit price required');
    if ((req.type === 'stop' || req.type === 'stop-limit') && req.stopPx === undefined)
      return reject('Stop price required');
    if (order.reduceOnly) {
      const pos = this.position(req.accountId, req.instrumentId);
      const reduces = (pos.qty > 0 && req.side === 'sell') || (pos.qty < 0 && req.side === 'buy');
      if (!reduces) return reject('Reduce-only order would increase position');
      order.qty = Math.min(order.qty, Math.abs(pos.qty));
    }
    this.orders.set(order.id, order);
    if (req.bracket && (req.bracket.slTicks || req.bracket.tpTicks?.length)) {
      this.brackets.set(order.id, {
        accountId: req.accountId,
        instrumentId: req.instrumentId,
        spec: req.bracket,
      });
    }
    if (order.type === 'market') this.fillAgainstBook(order, Infinity);
    else if (order.type === 'limit') {
      this.fillAgainstBook(order, order.px!);
      if (order.status === 'working' || order.status === 'partial') {
        if (order.tif === 'IOC' || order.tif === 'FOK') this.cancel(order.id, true);
      }
    }
    this.emit();
    return order;
  }

  cancel(orderId: string, silent = false): boolean {
    const o = this.orders.get(orderId);
    if (!o || (o.status !== 'working' && o.status !== 'partial')) return false;
    o.status = 'cancelled';
    o.updatedAt = this.now();
    if (!silent) this.emit();
    return true;
  }

  cancelAll(accountId: string, instrumentId?: string, side?: Side): number {
    let n = 0;
    for (const o of this.workingOrders(accountId, instrumentId)) {
      if (side && o.side !== side) continue;
      if (this.cancel(o.id, true)) n++;
    }
    this.emit();
    return n;
  }

  /** Moves a working order (drag on DOM/chart). */
  modify(orderId: string, changes: { px?: number; stopPx?: number; qty?: number }): boolean {
    const o = this.orders.get(orderId);
    if (!o || (o.status !== 'working' && o.status !== 'partial')) return false;
    Object.assign(o, changes);
    o.updatedAt = this.now();
    if (o.type === 'limit') this.fillAgainstBook(o, o.px!);
    this.emit();
    return true;
  }

  flatten(accountId: string, instrumentId: string): void {
    this.cancelAll(accountId, instrumentId);
    const p = this.position(accountId, instrumentId);
    if (p.qty !== 0) {
      this.place({
        accountId,
        instrumentId,
        side: p.qty > 0 ? 'sell' : 'buy',
        type: 'market',
        qty: Math.abs(p.qty),
      });
    }
  }

  flattenAll(accountId: string): void {
    for (const p of this.allPositions(accountId)) this.flatten(accountId, p.instrumentId);
    this.cancelAll(accountId);
  }

  reverse(accountId: string, instrumentId: string): void {
    const p = this.position(accountId, instrumentId);
    if (p.qty === 0) return;
    this.cancelAll(accountId, instrumentId);
    this.place({
      accountId,
      instrumentId,
      side: p.qty > 0 ? 'sell' : 'buy',
      type: 'market',
      qty: Math.abs(p.qty) * 2,
    });
  }

  /** Breakeven (H): moves protective stops to the average entry, or creates one. */
  breakeven(accountId: string, instrumentId: string): void {
    const p = this.position(accountId, instrumentId);
    if (p.qty === 0) return;
    const be = p.qty > 0 ? Math.ceil(p.avgPx) : Math.floor(p.avgPx);
    const stops = this.workingOrders(accountId, instrumentId).filter((o) => o.type === 'stop');
    if (stops.length) for (const s of stops) s.stopPx = be;
    else
      this.place({
        accountId,
        instrumentId,
        side: p.qty > 0 ? 'sell' : 'buy',
        type: 'stop',
        stopPx: be,
        qty: Math.abs(p.qty),
        reduceOnly: true,
      });
    this.emit();
  }

  /** Feed every live/replay trade through here (Live Pipeline stage 11). */
  onTrade(instrumentId: string, t: Trade): void {
    let changed = false;
    for (const o of this.orders.values()) {
      if (o.instrumentId !== instrumentId || (o.status !== 'working' && o.status !== 'partial'))
        continue;
      if (o.type === 'stop' || o.type === 'stop-limit') {
        const hit = o.side === 'buy' ? t.px >= o.stopPx! : t.px <= o.stopPx!;
        if (!hit) continue;
        if (o.type === 'stop') {
          o.type = 'market';
          this.fillAgainstBook(o, Infinity, t.px);
        } else {
          o.type = 'limit';
          this.fillAgainstBook(o, o.px!);
        }
        changed = true;
      } else if (o.type === 'limit') {
        // Conservative queue model: fill only when the tape trades through the limit.
        const through = o.side === 'buy' ? t.px < o.px! : t.px > o.px!;
        if (through) {
          this.execute(o, o.qty - o.filled, o.px!, 'maker');
          changed = true;
        }
      }
    }
    if (changed) this.emit();
  }

  private fillAgainstBook(o: Order, limit: number, fallbackPx?: number): void {
    const book = this.deps.book(o.instrumentId);
    let rem = o.qty - o.filled;
    if (book && !Number.isNaN(o.side === 'buy' ? book.bestAsk : book.bestBid)) {
      const levels =
        o.side === 'buy'
          ? [...book.asks.entries()].sort((a, b) => a[0] - b[0])
          : [...book.bids.entries()].sort((a, b) => b[0] - a[0]);
      for (const [px, size] of levels) {
        if (rem <= 0) break;
        const ok = o.side === 'buy' ? px <= limit : limit === Infinity || px >= limit;
        if (!ok) break;
        const q = Math.min(rem, size);
        this.execute(o, q, px, 'taker');
        rem -= q;
      }
    }
    if (rem > 0 && o.type === 'market') {
      const px =
        fallbackPx ?? (book ? (o.side === 'buy' ? book.bestAsk : book.bestBid) : Number.NaN);
      if (Number.isNaN(px)) {
        o.status = 'rejected';
        o.reason = 'No market data';
        return;
      }
      this.execute(o, rem, px, 'taker');
    }
  }

  private execute(o: Order, qty: number, px: number, liquidity: 'maker' | 'taker'): void {
    if (qty <= 0) return;
    const acc = this.accounts.get(o.accountId)!;
    const econ = this.deps.economics(o.instrumentId);
    const pos = this.position(o.accountId, o.instrumentId);
    const signed = o.side === 'buy' ? qty : -qty;
    let realized = 0;
    if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signed)) {
      const newQty = pos.qty + signed;
      pos.avgPx = (pos.avgPx * Math.abs(pos.qty) + px * qty) / Math.abs(newQty);
      pos.qty = newQty;
    } else {
      const closing = Math.min(Math.abs(pos.qty), qty);
      realized = (px - pos.avgPx) * Math.sign(pos.qty) * pnlPerTick(econ, closing);
      const newQty = pos.qty + signed;
      if (Math.sign(newQty) !== Math.sign(pos.qty) && newQty !== 0) pos.avgPx = px;
      if (newQty === 0) pos.avgPx = 0;
      pos.qty = newQty;
      pos.realized += realized;
    }
    const notional = econ.tickValue > 0 ? 0 : px * econ.tickSize * qty;
    const commission =
      acc.commissionPerUnit * qty + acc.takerFee * notional * (liquidity === 'taker' ? 1 : 0.5);
    acc.balance += realized - commission;
    o.avgFillPx = (o.avgFillPx * o.filled + px * qty) / (o.filled + qty);
    o.filled += qty;
    o.status = o.filled >= o.qty - 1e-12 ? 'filled' : 'partial';
    o.updatedAt = this.now();
    this.fills.push({
      id: nextId('f'),
      orderId: o.id,
      accountId: o.accountId,
      instrumentId: o.instrumentId,
      side: o.side,
      qty,
      px,
      ts: this.now(),
      commission,
      liquidity,
      realized,
    });
    if (o.status === 'filled') {
      if (o.oco)
        for (const x of this.orders.values())
          if (x.oco === o.oco && x.id !== o.id) this.reduceOco(x, o);
      const br = this.brackets.get(o.id);
      if (br) {
        this.brackets.delete(o.id);
        this.attachBracket(o, br.spec);
      }
    }
  }

  /**
   * Bracket OCO rules: a filled target shrinks the stop by its quantity (other targets stay);
   * a filled stop cancels every target; any other OCO pair cancels the sibling.
   */
  private reduceOco(sibling: Order, filled: Order): void {
    if (sibling.status !== 'working' && sibling.status !== 'partial') return;
    if (filled.role === 'tp') {
      if (sibling.role === 'sl') {
        sibling.qty -= filled.qty;
        if (sibling.qty <= 1e-12) sibling.status = 'cancelled';
      }
      return;
    }
    sibling.status = 'cancelled';
    sibling.updatedAt = this.now();
  }

  private attachBracket(entry: Order, spec: NonNullable<OrderRequest['bracket']>): void {
    const dir = entry.side === 'buy' ? 1 : -1;
    const exitSide: Side = entry.side === 'buy' ? 'sell' : 'buy';
    const avg = entry.avgFillPx;
    const group = `oco-${entry.id}`;
    const base = {
      accountId: entry.accountId,
      instrumentId: entry.instrumentId,
      side: exitSide,
      tif: 'GTC' as const,
    };
    const t = this.now();
    const mk = (o: Partial<Order>): Order => ({
      id: nextId('o'),
      ...base,
      type: 'limit',
      qty: 0,
      filled: 0,
      reduceOnly: true,
      status: 'working',
      avgFillPx: 0,
      createdAt: t,
      updatedAt: t,
      oco: group,
      parentId: entry.id,
      ...o,
    });
    if (spec.slTicks) {
      const sl = mk({
        type: 'stop',
        stopPx: Math.round(avg - dir * spec.slTicks),
        qty: entry.qty,
        role: 'sl',
      });
      this.orders.set(sl.id, sl);
    }
    const tps = spec.tpTicks ?? [];
    if (tps.length) {
      const per = entry.qty / tps.length;
      tps.forEach((ticks, i) => {
        const q = i === tps.length - 1 ? entry.qty - per * (tps.length - 1) : per;
        const tp = mk({ type: 'limit', px: Math.round(avg + dir * ticks), qty: q, role: 'tp' });
        this.orders.set(tp.id, tp);
      });
    }
  }
}
