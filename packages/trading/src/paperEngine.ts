import type { OrderBook, Side, Trade } from '@htflow/market-data';
import {
  pnlPerTick,
  visibleQty,
  type Account,
  type BracketSpec,
  type Fill,
  type InstrumentEconomics,
  type OptionFill,
  type OptionPosition,
  type OptionTradeRequest,
  type Order,
  type OrderRequest,
  type Position,
  type TrailSpec,
} from './types';

export interface PaperEngineDeps {
  book(instrumentId: string): OrderBook | undefined;
  economics(instrumentId: string): InstrumentEconomics;
  now?(): number;
  /** Live ATR in ticks for ATR-based trailing stops (falls back to the order's captured value). */
  atr?(instrumentId: string): number | undefined;
  /** Last traded price in ticks (reference for trailing stops placed without a stop price). */
  last?(instrumentId: string): number | undefined;
  /**
   * Mark price in ticks used for unrealized P&L before the engine has seen a trade of the
   * instrument (e.g. a position restored at start-up while the feed is still loading history).
   */
  mark?(instrumentId: string): number | undefined;
}

/** Account P&L at the current marks (account currency). */
export interface PnlSummary {
  /** Unrealized P&L of open positions (and options) at the current marks. */
  open: number;
  /** Gross realized P&L of the fills since `since` (before commissions). */
  realized: number;
  /** Commissions / fees of the fills since `since`. */
  fees: number;
  /** realized − fees + open. */
  net: number;
  balance: number;
  /** balance + open. */
  equity: number;
}

/** Fields of an account the user may edit (name, currency, starting balance, fees). */
export type AccountPatch = Partial<
  Pick<
    Account,
    | 'name'
    | 'currency'
    | 'startingBalance'
    | 'commissionPerUnit'
    | 'takerFee'
    | 'makerFee'
    | 'slippageTicks'
  >
>;

/** Mark-to-model hook for options: premium per unit, or undefined to keep the last mark. */
export type OptionMarkModel = (pos: OptionPosition) => number | undefined;

/** Live ATM management attached to an entry order once it fills (breakeven, trailing steps). */
interface ManagedBracket {
  entryId: string;
  accountId: string;
  instrumentId: string;
  dir: 1 | -1;
  avg: number;
  breakeven?: { trigger: number; offset: number };
  steps: { trigger: number; stopOffset: number }[];
  beDone: boolean;
}

const isWorking = (o: Order) => o.status === 'working' || o.status === 'partial';

type Listener = () => void;

/**
 * Routes an (account, instrument) pair to the account that really trades it, e.g. every order on a
 * `replay:` instrument goes to the replay account with the journal tag 'replay'.
 */
export type AccountRouter = (
  accountId: string,
  instrumentId: string,
) => { accountId: string; tag?: string } | undefined;

/** Pre-trade check (risk rules): return a reason to reject the order, or nothing to allow it. */
export type PreTradeCheck = (
  req: OrderRequest,
  engine: PaperEngine,
) => string | null | undefined | void;

/**
 * Called once per fill, after the operation that produced it has finished, so a hook may safely
 * place, cancel or flatten (risk monitoring, activity log).
 */
export type PostFillHook = (fill: Fill, engine: PaperEngine) => void;

let seq = 0;
const nextId = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

/** A fresh one-cancels-other group id for `OrderRequest.oco`. */
export const ocoGroupId = (): string => nextId('oco-u');

/** A user OCO group (not a bracket's SL / TP group): any fill or cancel cancels the rest. */
const userOco = (o: Order) => !!o.oco && !o.parentId;

/**
 * Open state of one account that survives a restart (P17): positions, working orders, pending
 * brackets of working entries, live ATM management and options positions.
 */
export interface AccountState {
  v: 1;
  positions: Position[];
  orders: Order[];
  brackets: { entryId: string; spec: BracketSpec }[];
  managed: {
    entryId: string;
    instrumentId: string;
    dir: 1 | -1;
    avg: number;
    breakeven?: { trigger: number; offset: number };
    steps: { trigger: number; stopOffset: number }[];
    beDone: boolean;
  }[];
  options: OptionPosition[];
  /** Most recent fills (optional; saves before round 7 have none). */
  fills?: Fill[];
}

/** Fills saved per account with its open state. */
export const MAX_SAVED_FILLS = 1000;

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
  private managed = new Map<string, ManagedBracket>();
  private options = new Map<string, OptionPosition>();
  readonly optionFills: OptionFill[] = [];
  private optionModel: OptionMarkModel | null = null;
  /** Last traded price (ticks) seen per instrument: the mark for unrealized P&L. */
  private marks = new Map<string, number>();
  /** Stop / MIT / trailing orders that became market orders (slippage applies to their fills). */
  private triggered = new Set<string>();
  private listeners = new Set<Listener>();
  /** Run in order before every new order is accepted; the first reason returned rejects it. */
  readonly preTradeChecks: PreTradeCheck[] = [];
  readonly postFillHooks: PostFillHook[] = [];
  private pendingFills: Fill[] = [];
  private draining = false;
  version = 0;
  private router: AccountRouter | null = null;

  constructor(private deps: PaperEngineDeps) {}

  setAccountRouter(r: AccountRouter | null): void {
    this.router = r;
  }

  /** The account that trades `instrumentId` when `accountId` is requested. */
  route(accountId: string, instrumentId: string): string {
    return this.router?.(accountId, instrumentId)?.accountId ?? accountId;
  }

  private now(): number {
    const t = this.clockInst === undefined ? undefined : this.clock?.(this.clockInst);
    return t ?? this.deps.now?.() ?? Date.now();
  }

  /**
   * Per-instrument clock (replay): returns the time to stamp orders / fills of that instrument
   * with, or undefined to use the normal clock. Orders on other instruments keep wall-clock time.
   */
  setClock(fn: ((instrumentId: string) => number | undefined) | null): void {
    this.clock = fn;
  }

  private clock: ((instrumentId: string) => number | undefined) | null = null;
  private clockInst: string | undefined;

  private inClock<T>(instrumentId: string, fn: () => T): T {
    const prev = this.clockInst;
    this.clockInst = instrumentId;
    try {
      return fn();
    } finally {
      this.clockInst = prev;
    }
  }

  place(req: OrderRequest): Order {
    return this.inClock(req.instrumentId, () => this.placeInner(req));
  }

  onTrade(instrumentId: string, t: Trade): void {
    this.inClock(instrumentId, () => this.onTradeInner(instrumentId, t));
  }

  cancel(orderId: string, silent = false): boolean {
    const o = this.orders.get(orderId);
    return this.inClock(o?.instrumentId ?? '', () => this.cancelInner(orderId, silent));
  }

  modify(
    orderId: string,
    changes: { px?: number; stopPx?: number; qty?: number; displayQty?: number },
  ): boolean {
    const o = this.orders.get(orderId);
    return this.inClock(o?.instrumentId ?? '', () => this.modifyInner(orderId, changes));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.flushFillHooks();
    this.version++;
    for (const l of this.listeners) l();
  }

  private flushFillHooks(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pendingFills.length) {
        const f = this.pendingFills.shift()!;
        for (const h of this.postFillHooks) h(f, this);
      }
    } finally {
      this.draining = false;
    }
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

  /** Renames / re-configures an account. A new starting balance applies on the next reset. */
  updateAccount(id: string, patch: AccountPatch): boolean {
    const a = this.accounts.get(id);
    if (!a) return false;
    if (patch.name !== undefined && !patch.name.trim()) return false;
    if (patch.startingBalance !== undefined && !(patch.startingBalance >= 0)) return false;
    Object.assign(a, patch);
    if (patch.name !== undefined) a.name = patch.name.trim();
    this.emit();
    return true;
  }

  renameAccount(id: string, name: string): boolean {
    return this.updateAccount(id, { name });
  }

  /** Sets the starting balance (and currency) and resets the account to it. */
  setStartingBalance(id: string, balance: number, currency?: string): boolean {
    if (
      !this.updateAccount(
        id,
        currency ? { startingBalance: balance, currency } : { startingBalance: balance },
      )
    )
      return false;
    this.resetAccount(id);
    return true;
  }

  /** Deletes an account with its orders, positions and options (fills stay in the history). */
  deleteAccount(id: string): boolean {
    if (!this.accounts.has(id)) return false;
    this.clearAccountState(id);
    this.accounts.delete(id);
    this.emit();
    return true;
  }

  private clearAccountState(id: string): void {
    for (const [k, o] of this.orders) if (o.accountId === id) this.orders.delete(k);
    for (const k of [...this.positions.keys()])
      if (k.startsWith(id + '|')) this.positions.delete(k);
    for (const [k, b] of this.brackets) if (b.accountId === id) this.brackets.delete(k);
    for (const [k, m] of this.managed) if (m.accountId === id) this.managed.delete(k);
    for (const [k, p] of this.options) if (p.accountId === id) this.options.delete(k);
  }

  resetAccount(id: string): void {
    const a = this.accounts.get(id);
    if (!a) return;
    a.balance = a.startingBalance;
    a.locked = false;
    this.clearAccountState(id);
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
    accountId = this.route(accountId, instrumentId);
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
    if (accountId && instrumentId) accountId = this.route(accountId, instrumentId);
    return [...this.orders.values()].filter(
      (o) =>
        (o.status === 'working' || o.status === 'partial') &&
        (!accountId || o.accountId === accountId) &&
        (!instrumentId || o.instrumentId === instrumentId),
    );
  }

  /**
   * Instrument economics with a guard: a missing / zero / non-finite tick size or tick value
   * would silently zero every P&L, so bad values fall back to linear 1-tick units.
   */
  economics(instrumentId: string): InstrumentEconomics {
    const e = this.deps.economics(instrumentId);
    const tickSize = Number.isFinite(e?.tickSize) && e.tickSize > 0 ? e.tickSize : 1;
    const tickValue = Number.isFinite(e?.tickValue) && e.tickValue > 0 ? e.tickValue : 0;
    return { tickSize, tickValue };
  }

  /** Currency P&L of one tick move on one unit of the instrument. */
  pnlPerTick(instrumentId: string): number {
    return pnlPerTick(this.economics(instrumentId), 1);
  }

  /** Records a mark price (ticks) without a trade, e.g. from a quote. */
  setMark(instrumentId: string, px: number): void {
    if (Number.isFinite(px)) this.marks.set(instrumentId, px);
  }

  /**
   * Current mark price (ticks): the last trade the engine saw, else the app's mark source, else
   * the book mid. NaN when nothing is known.
   */
  mark(instrumentId: string): number {
    const m = this.marks.get(instrumentId);
    if (m !== undefined) return m;
    const d = this.deps.mark?.(instrumentId);
    if (d !== undefined && Number.isFinite(d)) return d;
    const b = this.deps.book(instrumentId);
    return b && Number.isFinite(b.mid) ? b.mid : Number.NaN;
  }

  /** Unrealized PnL in account currency at the given mark (ticks), default the current mark. */
  unrealized(accountId: string, instrumentId: string, markPx?: number): number {
    const p = this.position(accountId, instrumentId);
    if (!p.qty) return 0;
    const m = markPx ?? this.mark(instrumentId);
    if (!Number.isFinite(m)) return 0;
    return (m - p.avgPx) * pnlPerTick(this.economics(instrumentId), p.qty);
  }

  /** Unrealized P&L of every open position (and option) of an account at the current marks. */
  openPnl(accountId: string): number {
    let open = this.optionUnrealized(accountId);
    for (const p of this.allPositions(accountId))
      open += this.unrealized(accountId, p.instrumentId);
    return open;
  }

  /** Realized / fees of the account's fills since `since` (epoch ms), open P&L and equity. */
  pnlSummary(accountId: string, since = 0, instrumentId?: string): PnlSummary {
    let realized = 0;
    let fees = 0;
    for (const f of this.fills) {
      if (f.accountId !== accountId || f.ts < since) continue;
      if (instrumentId && f.instrumentId !== instrumentId) continue;
      realized += f.realized;
      fees += f.commission;
    }
    const open = instrumentId ? this.unrealized(accountId, instrumentId) : this.openPnl(accountId);
    const balance = this.accounts.get(accountId)?.balance ?? 0;
    return {
      open,
      realized,
      fees,
      net: realized - fees + open,
      balance,
      equity: balance + (instrumentId ? this.openPnl(accountId) : open),
    };
  }

  private placeInner(req: OrderRequest): Order {
    const r = this.router?.(req.accountId, req.instrumentId);
    if (r) req = { ...req, accountId: r.accountId, tag: req.tag ?? r.tag };
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
      tag: req.tag,
      atm: req.bracket?.atm,
    };
    if (req.displayQty !== undefined) order.displayQty = req.displayQty;
    if (req.trail) order.trail = { ...req.trail };
    if (req.oco) order.oco = req.oco;
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
    if (
      (req.type === 'stop' || req.type === 'stop-limit' || req.type === 'mit') &&
      req.stopPx === undefined
    )
      return reject(req.type === 'mit' ? 'Trigger price required' : 'Stop price required');
    if (req.displayQty !== undefined) {
      if (req.type !== 'limit') return reject('Iceberg needs a limit order');
      if (!(req.displayQty > 0)) return reject('Display quantity must be > 0');
      if (req.displayQty >= req.qty) order.displayQty = undefined; // nothing hidden
    }
    if (req.type === 'trailing-stop') {
      if (!req.trail || !(req.trail.amount > 0)) return reject('Trailing distance required');
      const dist = this.trailDistance(order, req.stopPx ?? this.refPx(req.instrumentId, req.side));
      if (!(dist > 0)) return reject('Trailing distance unavailable (no ATR)');
      if (req.stopPx === undefined) {
        const ref = this.refPx(req.instrumentId, req.side);
        if (Number.isNaN(ref)) return reject('No market data');
        order.trailRef = ref;
        order.stopPx = req.side === 'sell' ? ref - dist : ref + dist;
      } else order.trailRef = req.side === 'sell' ? req.stopPx + dist : req.stopPx - dist;
    }
    if (order.reduceOnly) {
      const pos = this.position(req.accountId, req.instrumentId);
      const reduces = (pos.qty > 0 && req.side === 'sell') || (pos.qty < 0 && req.side === 'buy');
      if (!reduces) return reject('Reduce-only order would increase position');
      order.qty = Math.min(order.qty, Math.abs(pos.qty));
    }
    if (req.oco) {
      for (const x of this.orders.values()) {
        if (x.oco !== req.oco) continue;
        if (x.parentId) return reject('OCO group belongs to a bracket');
        if (x.filled > 0) return reject('OCO group already filled');
        if (x.status === 'cancelled') return reject('OCO group already cancelled');
      }
    }
    for (const check of this.preTradeChecks) {
      const reason = check(req, this);
      if (reason) return reject(reason);
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

  private cancelInner(orderId: string, silent = false): boolean {
    const o = this.orders.get(orderId);
    if (!o || (o.status !== 'working' && o.status !== 'partial')) return false;
    o.status = 'cancelled';
    o.updatedAt = this.now();
    // One-cancels-other: cancelling one order of a user OCO group cancels the rest.
    if (userOco(o))
      for (const x of this.orders.values())
        if (x.oco === o.oco && x.id !== o.id && isWorking(x)) {
          x.status = 'cancelled';
          x.reason = 'OCO sibling cancelled';
          x.updatedAt = o.updatedAt;
        }
    if (!silent) this.emit();
    return true;
  }

  /**
   * Links working orders of one account into a new user OCO group (the first fill or cancel
   * cancels the others). Returns the group id, or null when fewer than two orders qualify.
   */
  linkOco(orderIds: string[]): string | null {
    const os = orderIds
      .map((id) => this.orders.get(id))
      .filter((o): o is Order => !!o && isWorking(o) && !o.parentId && o.filled === 0);
    if (os.length < 2 || os.some((o) => o.accountId !== os[0]!.accountId)) return null;
    const group = ocoGroupId();
    for (const o of os) {
      o.oco = group;
      o.updatedAt = this.now();
    }
    this.emit();
    return group;
  }

  /** Removes an order from its user OCO group (it then works on its own). */
  unlinkOco(orderId: string): boolean {
    const o = this.orders.get(orderId);
    if (!o || !userOco(o) || !isWorking(o)) return false;
    const group = o.oco;
    o.oco = undefined;
    const rest = [...this.orders.values()].filter((x) => x.oco === group && isWorking(x));
    // A group of one is no group.
    if (rest.length === 1) rest[0]!.oco = undefined;
    this.emit();
    return true;
  }

  cancelAll(accountId: string, instrumentId?: string, side?: Side): number {
    if (instrumentId) accountId = this.route(accountId, instrumentId);
    let n = 0;
    for (const o of this.workingOrders(accountId, instrumentId)) {
      if (side && o.side !== side) continue;
      if (this.cancel(o.id, true)) n++;
    }
    this.emit();
    return n;
  }

  /** Moves a working order (drag on DOM/chart). */
  private modifyInner(
    orderId: string,
    changes: { px?: number; stopPx?: number; qty?: number; displayQty?: number },
  ): boolean {
    const o = this.orders.get(orderId);
    if (!o || (o.status !== 'working' && o.status !== 'partial')) return false;
    if (changes.qty !== undefined && !(changes.qty > o.filled)) return false;
    const { stopPx, ...rest } = changes;
    Object.assign(o, rest);
    if (stopPx !== undefined) this.setStop(o, stopPx);
    o.updatedAt = this.now();
    if (o.type === 'limit') this.fillAgainstBook(o, o.px!);
    this.emit();
    return true;
  }

  /** Moves a stop trigger; a trailing stop keeps trailing from the new level. */
  private setStop(o: Order, stopPx: number): void {
    if (o.type === 'trailing-stop' && o.trail && o.trailRef !== undefined) {
      // Dragging a trailing stop changes its distance to the new gap from the best price.
      const gap = (o.side === 'sell' ? 1 : -1) * (o.trailRef - stopPx);
      if (gap > 0) {
        const t = o.trail;
        if (t.kind === 'ticks') t.amount = gap;
        else if (t.kind === 'percent' && o.trailRef) t.amount = (gap / Math.abs(o.trailRef)) * 100;
        else if (t.kind === 'atr') {
          const atr = this.deps.atr?.(o.instrumentId) ?? t.atrTicks;
          if (atr && atr > 0) t.amount = gap / atr;
        }
      } else o.trailRef = stopPx; // dragged past the best price: trail from the stop itself
    }
    o.stopPx = stopPx;
    o.updatedAt = this.now();
  }

  /** Reference price for a new order: last trade, else the touch on the order's side. */
  private refPx(instrumentId: string, side: Side): number {
    const last = this.deps.last?.(instrumentId);
    if (last !== undefined && !Number.isNaN(last)) return last;
    const b = this.deps.book(instrumentId);
    if (!b) return Number.NaN;
    const px = side === 'buy' ? b.bestAsk : b.bestBid;
    return Number.isNaN(px) ? b.mid : px;
  }

  /** Trailing distance in whole ticks (>= 1), or NaN when it cannot be computed. */
  private trailDistance(o: Pick<Order, 'instrumentId' | 'trail'>, refPx: number): number {
    const t: TrailSpec | undefined = o.trail;
    if (!t) return Number.NaN;
    let d: number;
    if (t.kind === 'ticks') d = t.amount;
    else if (t.kind === 'percent') d = (Math.abs(refPx) * t.amount) / 100;
    else d = t.amount * (this.deps.atr?.(o.instrumentId) ?? t.atrTicks ?? Number.NaN);
    if (!Number.isFinite(d) || d <= 0) return Number.NaN;
    return Math.max(1, Math.round(d));
  }

  flatten(accountId: string, instrumentId: string): void {
    accountId = this.route(accountId, instrumentId);
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
    accountId = this.route(accountId, instrumentId);
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
    accountId = this.route(accountId, instrumentId);
    const p = this.position(accountId, instrumentId);
    if (p.qty === 0) return;
    const be = p.qty > 0 ? Math.ceil(p.avgPx) : Math.floor(p.avgPx);
    const stops = this.workingOrders(accountId, instrumentId).filter(
      (o) => o.type === 'stop' || o.type === 'trailing-stop',
    );
    if (stops.length) for (const s of stops) this.setStop(s, be);
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
  private onTradeInner(instrumentId: string, t: Trade): void {
    if (Number.isFinite(t.px)) this.marks.set(instrumentId, t.px);
    let changed = false;
    for (const o of this.orders.values()) {
      if (o.instrumentId !== instrumentId || !isWorking(o)) continue;
      if (o.type === 'trailing-stop') {
        // Follow the best price, never loosen, then trigger like a stop.
        const dist = this.trailDistance(o, t.px);
        const ref = o.trailRef ?? t.px;
        const better = o.side === 'sell' ? t.px > ref : t.px < ref;
        if (better) o.trailRef = t.px;
        if (Number.isFinite(dist) && o.trailRef !== undefined) {
          const want = o.side === 'sell' ? o.trailRef - dist : o.trailRef + dist;
          const tighter = o.side === 'sell' ? want > o.stopPx! : want < o.stopPx!;
          if (tighter) {
            o.stopPx = want;
            o.updatedAt = this.now();
            changed = true;
          }
        }
      }
      if (o.type === 'stop' || o.type === 'stop-limit' || o.type === 'trailing-stop') {
        const hit = o.side === 'buy' ? t.px >= o.stopPx! : t.px <= o.stopPx!;
        if (!hit) continue;
        if (o.type === 'stop-limit') {
          o.type = 'limit';
          this.fillAgainstBook(o, o.px!);
        } else {
          o.type = 'market';
          this.triggered.add(o.id);
          this.fillAgainstBook(o, Infinity, t.px);
        }
        changed = true;
      } else if (o.type === 'mit') {
        // Market-if-touched: a buy triggers at or below the trigger, a sell at or above.
        const hit = o.side === 'buy' ? t.px <= o.stopPx! : t.px >= o.stopPx!;
        if (!hit) continue;
        o.type = 'market';
        this.triggered.add(o.id);
        this.fillAgainstBook(o, Infinity, t.px);
        changed = true;
      } else if (o.type === 'limit') {
        // Conservative queue model: fill only when the tape trades through the limit.
        const through = o.side === 'buy' ? t.px < o.px! : t.px > o.px!;
        if (through) {
          // An iceberg fills one display slice per trade-through, then refills at the back of
          // the queue (the next slice needs another trade through the price).
          const q = visibleQty(o);
          this.execute(o, q, o.px!, 'maker');
          if (isWorking(o) && o.displayQty) o.refills = (o.refills ?? 0) + 1;
          changed = true;
        }
      }
    }
    if (this.manageBrackets(instrumentId, t.px)) changed = true;
    if (changed) this.emit();
  }

  /** ATM auto-breakeven and trailing steps: tighten bracket stops as profit grows. */
  private manageBrackets(instrumentId: string, px: number): boolean {
    let changed = false;
    for (const [id, m] of this.managed) {
      if (m.instrumentId !== instrumentId) continue;
      const children = [...this.orders.values()].filter((o) => o.parentId === id && isWorking(o));
      if (!children.length) {
        this.managed.delete(id);
        continue;
      }
      const profit = (px - m.avg) * m.dir;
      let target: number | null = null;
      const consider = (offset: number) => {
        const p = m.avg + m.dir * offset;
        const rounded = m.dir > 0 ? Math.ceil(p - 1e-9) : Math.floor(p + 1e-9);
        if (target === null || (m.dir > 0 ? rounded > target : rounded < target)) target = rounded;
      };
      if (m.breakeven && profit >= m.breakeven.trigger) {
        consider(m.breakeven.offset);
        m.beDone = true;
      }
      for (const s of m.steps) if (profit >= s.trigger) consider(s.stopOffset);
      if (target === null) continue;
      for (const sl of children) {
        if (sl.role !== 'sl' || sl.stopPx === undefined) continue;
        const tighter = m.dir > 0 ? target > sl.stopPx : target < sl.stopPx;
        if (tighter) {
          this.setStop(sl, target);
          changed = true;
        }
      }
    }
    return changed;
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
    const econ = this.economics(o.instrumentId);
    // Slippage model: triggered stop / MIT / trailing fills give up `slippageTicks`.
    if (liquidity === 'taker' && acc.slippageTicks && this.triggered.has(o.id))
      px += (o.side === 'buy' ? 1 : -1) * acc.slippageTicks;
    const pos = this.position(o.accountId, o.instrumentId);
    const signed = o.side === 'buy' ? qty : -qty;
    let realized = 0;
    let closedQty = 0;
    const entryAvg = pos.avgPx;
    if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signed)) {
      const newQty = pos.qty + signed;
      pos.avgPx = (pos.avgPx * Math.abs(pos.qty) + px * qty) / Math.abs(newQty);
      pos.qty = newQty;
    } else {
      const closing = Math.min(Math.abs(pos.qty), qty);
      closedQty = closing;
      realized = (px - pos.avgPx) * Math.sign(pos.qty) * pnlPerTick(econ, closing);
      const newQty = pos.qty + signed;
      if (Math.sign(newQty) !== Math.sign(pos.qty) && newQty !== 0) pos.avgPx = px;
      if (newQty === 0) pos.avgPx = 0;
      pos.qty = newQty;
      pos.realized += realized;
    }
    const notional = econ.tickValue > 0 ? 0 : px * econ.tickSize * qty;
    const feeRate = liquidity === 'taker' ? acc.takerFee : (acc.makerFee ?? acc.takerFee);
    const commission = acc.commissionPerUnit * qty + feeRate * notional;
    acc.balance += realized - commission;
    o.avgFillPx = (o.avgFillPx * o.filled + px * qty) / (o.filled + qty);
    o.filled += qty;
    o.status = o.filled >= o.qty - 1e-12 ? 'filled' : 'partial';
    o.updatedAt = this.now();
    const fill: Fill = {
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
      tag: o.tag,
    };
    if (closedQty > 0) {
      fill.closedQty = closedQty;
      fill.entryAvg = entryAvg;
    }
    if (!this.marks.has(o.instrumentId)) this.marks.set(o.instrumentId, px);
    this.fills.push(fill);
    if (this.postFillHooks.length) this.pendingFills.push(fill);
    // User OCO groups: the first fill (even partial) cancels the other orders of the group.
    if (userOco(o))
      for (const x of this.orders.values())
        if (x.oco === o.oco && x.id !== o.id && isWorking(x)) {
          x.status = 'cancelled';
          x.reason = 'OCO sibling filled';
          x.updatedAt = this.now();
        }
    if (o.status === 'filled') {
      this.triggered.delete(o.id);
      if (o.oco && !userOco(o))
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

  private attachBracket(entry: Order, spec: BracketSpec): void {
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
      tag: entry.tag,
      atm: entry.atm,
      ...o,
    });
    if (spec.slTicks || spec.slTrail) {
      let sl: Order;
      if (spec.slTrail) {
        const trail = { ...spec.slTrail };
        const dist = this.trailDistance({ instrumentId: entry.instrumentId, trail }, avg);
        const start = spec.slTicks ?? (Number.isFinite(dist) ? dist : 0);
        const stopPx = Math.round(avg - dir * start);
        sl = mk({
          type: 'trailing-stop',
          stopPx,
          trail,
          trailRef: Number.isFinite(dist) ? stopPx + dir * dist : avg,
          qty: entry.qty,
          role: 'sl',
        });
      } else
        sl = mk({
          type: 'stop',
          stopPx: Math.round(avg - dir * spec.slTicks!),
          qty: entry.qty,
          role: 'sl',
        });
      this.orders.set(sl.id, sl);
    }
    const tps = spec.tpTicks ?? [];
    if (tps.length) {
      const qtys = splitQty(
        entry.qty,
        spec.tpQty?.length === tps.length ? spec.tpQty : undefined,
        tps.length,
      );
      tps.forEach((ticks, i) => {
        if (!(qtys[i]! > 0)) return;
        const tp = mk({
          type: 'limit',
          px: Math.round(avg + dir * ticks),
          qty: qtys[i]!,
          role: 'tp',
        });
        this.orders.set(tp.id, tp);
      });
    }
    if (spec.breakeven || spec.trailSteps?.length) {
      this.managed.set(entry.id, {
        entryId: entry.id,
        accountId: entry.accountId,
        instrumentId: entry.instrumentId,
        dir,
        avg,
        breakeven: spec.breakeven,
        steps: [...(spec.trailSteps ?? [])].sort((a, b) => a.trigger - b.trigger),
        beDone: false,
      });
    }
  }

  /** ATM state of a bracket (for UI badges): whether auto-breakeven has fired. */
  bracketState(entryId: string): { breakevenDone: boolean } | undefined {
    const m = this.managed.get(entryId);
    return m ? { breakevenDone: m.beDone } : undefined;
  }

  // ------------------------------------------------------------------ options (P18)

  /** Sets the mark-to-model hook used by optionUnrealized / markOptions. */
  setOptionMarkModel(fn: OptionMarkModel | null): void {
    this.optionModel = fn;
  }

  optionPositions(accountId?: string): OptionPosition[] {
    return [...this.options.values()].filter(
      (p) => p.qty !== 0 && (!accountId || p.accountId === accountId),
    );
  }

  optionPosition(id: string): OptionPosition | undefined {
    for (const p of this.options.values()) if (p.id === id) return p;
    return undefined;
  }

  /** Current premium per unit of an option: model mark, else the last mark. */
  optionMark(p: OptionPosition): number | undefined {
    const m = this.optionModel?.(p);
    return m !== undefined && Number.isFinite(m) ? m : p.mark;
  }

  /**
   * Buys or sells option contracts at a premium. The premium paid (debit) or received (credit) is
   * recorded on the fill (`premiumFlow`) and carried by the position (`premiumFlow()`); the cash
   * balance books realized P&L when contracts close, like a futures position, so
   * balance = start + realized − commissions and equity = balance + mark-to-model P&L.
   */
  tradeOption(req: OptionTradeRequest, reason?: OptionFill['reason']): OptionPosition | string {
    const acc = this.accounts.get(req.accountId);
    if (!acc) return 'Unknown account';
    if (acc.locked) return 'Trading locked';
    if (!(req.qty > 0)) return 'Quantity must be > 0';
    if (!(req.premium >= 0)) return 'Premium must be >= 0';
    if (!(req.strike > 0)) return 'Strike must be > 0';
    if (reason !== 'expiry' && req.expiryTs !== undefined && req.expiryTs <= this.now())
      return 'Option has expired';
    const mult = req.multiplier ?? 1;
    const key = `${req.accountId}|${req.underlyingId}|${req.right}|${req.strike}|${req.expiry}`;
    let p = this.options.get(key);
    if (!p) {
      p = {
        id: nextId('op'),
        accountId: req.accountId,
        underlyingId: req.underlyingId,
        right: req.right,
        strike: req.strike,
        expiry: req.expiry,
        qty: 0,
        avgPremium: 0,
        multiplier: mult,
        realized: 0,
      };
      this.options.set(key, p);
    }
    // Model inputs follow the latest trade (a new IV / rate re-marks the whole position).
    for (const k of ['name', 'expiryTs', 'iv', 'model', 'r', 'q', 'basis'] as const)
      if (req[k] !== undefined) (p as unknown as Record<string, unknown>)[k] = req[k];
    const signed = req.side === 'buy' ? req.qty : -req.qty;
    let realized = 0;
    if (p.qty === 0 || Math.sign(p.qty) === Math.sign(signed)) {
      const n = p.qty + signed;
      p.avgPremium = (p.avgPremium * Math.abs(p.qty) + req.premium * req.qty) / Math.abs(n);
      p.qty = n;
    } else {
      const closing = Math.min(Math.abs(p.qty), req.qty);
      realized = (req.premium - p.avgPremium) * Math.sign(p.qty) * closing * p.multiplier;
      const n = p.qty + signed;
      if (n !== 0 && Math.sign(n) !== Math.sign(p.qty)) p.avgPremium = req.premium;
      if (n === 0) p.avgPremium = 0;
      p.qty = n;
      p.realized += realized;
    }
    const commission = reason === 'expiry' ? 0 : acc.commissionPerUnit * req.qty;
    acc.balance += realized - commission;
    p.mark = req.premium;
    this.optionFills.push({
      ...req,
      id: nextId('of'),
      multiplier: mult,
      ts: this.now(),
      commission,
      realized,
      premiumFlow: -signed * req.premium * mult,
      ...(reason ? { reason } : {}),
    });
    this.emit();
    return p;
  }

  /** Closes an option position at `premium` (default: the current model / last mark). */
  closeOption(id: string, premium?: number): OptionPosition | string {
    const p = this.optionPosition(id);
    if (!p || !p.qty) return 'No open position';
    const px = premium ?? this.optionMark(p);
    if (px === undefined) return 'No mark for this option';
    return this.tradeOption(
      {
        accountId: p.accountId,
        underlyingId: p.underlyingId,
        right: p.right,
        strike: p.strike,
        expiry: p.expiry,
        side: p.qty > 0 ? 'sell' : 'buy',
        qty: Math.abs(p.qty),
        premium: Math.max(0, px),
        multiplier: p.multiplier,
      },
      'close',
    );
  }

  /** Net premium paid (> 0) or received (< 0) for the open contracts of a position. */
  premiumFlow(p: OptionPosition): number {
    return p.qty * p.avgPremium * p.multiplier;
  }

  /** Re-marks every open option through the model hook (mark-to-model). */
  markOptions(): void {
    if (!this.optionModel) return;
    for (const p of this.options.values()) {
      if (!p.qty) continue;
      const m = this.optionModel(p);
      if (m !== undefined && Number.isFinite(m)) p.mark = m;
    }
    this.emit();
  }

  /** Mark-to-model P&L of one option position (0 without a mark). */
  optionPnl(p: OptionPosition): number {
    const m = this.optionMark(p);
    return m === undefined ? 0 : (m - p.avgPremium) * p.qty * p.multiplier;
  }

  optionUnrealized(accountId: string): number {
    let u = 0;
    for (const p of this.optionPositions(accountId)) u += this.optionPnl(p);
    return u;
  }

  /** Settles an expiring option at intrinsic value against the underlying price (price units). */
  expireOption(id: string, underlyingPx: number): boolean {
    const p = this.optionPosition(id);
    if (!p || !p.qty || !Number.isFinite(underlyingPx)) return false;
    const intrinsic =
      p.right === 'call'
        ? Math.max(0, underlyingPx - p.strike)
        : Math.max(0, p.strike - underlyingPx);
    // Settlement is not a trade: it goes through even on a locked account.
    const acc = this.accounts.get(p.accountId);
    const wasLocked = acc?.locked ?? false;
    if (acc) acc.locked = false;
    try {
      const r = this.tradeOption(
        {
          accountId: p.accountId,
          underlyingId: p.underlyingId,
          right: p.right,
          strike: p.strike,
          expiry: p.expiry,
          side: p.qty > 0 ? 'sell' : 'buy',
          qty: Math.abs(p.qty),
          premium: intrinsic,
          multiplier: p.multiplier,
        },
        'expiry',
      );
      return typeof r !== 'string';
    } finally {
      if (acc) acc.locked = wasLocked;
    }
  }

  /** Expiry instant of an option (explicit, else 08:00 UTC on the expiry date). */
  static optionExpiryTs(p: Pick<OptionPosition, 'expiry' | 'expiryTs'>): number {
    return p.expiryTs ?? Date.parse(`${p.expiry}T08:00:00Z`);
  }

  /**
   * Settles every open option whose expiry has passed at intrinsic value against the underlying
   * price from `spotOf` (price units; options without a price wait). Returns how many settled.
   */
  settleExpiredOptions(spotOf: (underlyingId: string) => number | undefined, now = this.now()) {
    let n = 0;
    for (const p of this.optionPositions()) {
      if (PaperEngine.optionExpiryTs(p) > now) continue;
      const s = spotOf(p.underlyingId);
      if (s !== undefined && Number.isFinite(s) && this.expireOption(p.id, s)) n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ persistence (P17)

  /** Open state of an account for saving (copies; fills and history are not included). */
  exportAccountState(accountId: string): AccountState {
    const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
    const orders = [...this.orders.values()].filter(
      (o) => o.accountId === accountId && isWorking(o),
    );
    return {
      v: 1,
      positions: this.allPositions(accountId).map(({ instrumentId, qty, avgPx, realized }) => ({
        instrumentId,
        qty,
        avgPx,
        realized,
      })),
      orders: clone(orders),
      brackets: [...this.brackets]
        .filter(([id, b]) => b.accountId === accountId && this.orders.has(id))
        .map(([entryId, b]) => ({ entryId, spec: clone(b.spec) })),
      managed: [...this.managed.values()]
        .filter((m) => m.accountId === accountId)
        .map(({ accountId: _a, ...m }) => clone(m)),
      options: clone(this.optionPositions(accountId)),
      // Recent fills keep trade history, today's realized P&L and the journal across restarts.
      fills: clone(this.fills.filter((f) => f.accountId === accountId).slice(-MAX_SAVED_FILLS)),
    };
  }

  /**
   * Replaces an account's open state with a saved one (restart): positions, working orders,
   * brackets and options. The cash balance is restored separately (it already includes the
   * realized P&L). Orders keep their ids, so OCO groups and bracket links survive.
   */
  importAccountState(accountId: string, s: AccountState): boolean {
    if (!this.accounts.has(accountId)) return false;
    this.clearAccountState(accountId);
    for (const p of s.positions)
      if (p.qty !== 0)
        this.positions.set(`${accountId}|${p.instrumentId}`, {
          ...p,
          instrumentId: p.instrumentId,
        });
    for (const o of s.orders) if (isWorking(o)) this.orders.set(o.id, { ...o, accountId });
    for (const b of s.brackets)
      if (this.orders.has(b.entryId)) {
        const e = this.orders.get(b.entryId)!;
        this.brackets.set(b.entryId, { accountId, instrumentId: e.instrumentId, spec: b.spec });
      }
    for (const m of s.managed) this.managed.set(m.entryId, { ...m, accountId });
    if (s.fills?.length) {
      const known = new Set(this.fills.map((f) => f.id));
      const add = s.fills.filter((f) => !known.has(f.id)).map((f) => ({ ...f, accountId }));
      this.fills.unshift(...add);
      this.fills.sort((a, b) => a.ts - b.ts);
    }
    for (const p of s.options)
      if (p.qty !== 0) {
        const op = { ...p, accountId };
        this.options.set(
          `${accountId}|${op.underlyingId}|${op.right}|${op.strike}|${op.expiry}`,
          op,
        );
      }
    this.emit();
    return true;
  }
}

/**
 * Splits `total` across `n` targets by weights (even when omitted). Whole-lot totals stay whole
 * (largest remainder); fractional totals split proportionally. The sum always equals `total`.
 */
export function splitQty(total: number, weights: number[] | undefined, n: number): number[] {
  if (n <= 0) return [];
  const w =
    weights && weights.length === n && weights.every((x) => x >= 0) && weights.some((x) => x > 0)
      ? weights
      : Array.from({ length: n }, () => 1);
  const sum = w.reduce((a, b) => a + b, 0);
  if (!weights) {
    // Legacy even split (fractional allowed), remainder on the last target.
    const per = total / n;
    return w.map((_, i) => (i === n - 1 ? total - per * (n - 1) : per));
  }
  if (Number.isInteger(total)) {
    const raw = w.map((x) => (total * x) / sum);
    const out = raw.map(Math.floor);
    let left = total - out.reduce((a, b) => a + b, 0);
    const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
    for (const [, i] of order) {
      if (left <= 0) break;
      out[i]! += 1;
      left--;
    }
    return out;
  }
  const out = w.map((x) => (total * x) / sum);
  out[n - 1] = total - out.slice(0, n - 1).reduce((a, b) => a + b, 0);
  return out;
}
