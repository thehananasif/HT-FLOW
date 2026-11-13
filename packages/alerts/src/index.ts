/**
 * Alerts (P23 / P41): pure conditions + engine. The UI layer feeds trades, books and feed status
 * from the market hub and performs the actions (popup, sound, desktop notification, activity log).
 */

export type AlertCondition =
  /** Last price crosses a level (ticks). */
  | { kind: 'price-cross'; instrumentId: string; px: number; direction: 'up' | 'down' | 'any' }
  /** A single print with size ≥ minQty. */
  | { kind: 'big-trade'; instrumentId: string; minQty: number; side: 'buy' | 'sell' | 'any' }
  /** Delta (buy − sell volume) of the current time bar ≥ / ≤ value. */
  | { kind: 'bar-delta'; instrumentId: string; barMs: number; op: 'gte' | 'lte'; value: number }
  /** A resting level with size ≥ minQty within N ticks of the best price. */
  | {
      kind: 'dom-size';
      instrumentId: string;
      minQty: number;
      withinTicks: number;
      side: 'bid' | 'ask' | 'any';
    }
  /** Feed disconnected or in error (instrumentId null = any connection). */
  | { kind: 'connection-lost'; instrumentId: string | null };

export type AlertKind = AlertCondition['kind'];

export interface AlertActions {
  popup: boolean;
  sound: boolean;
  desktop: boolean;
  log: boolean;
}

export interface Alert {
  id: string;
  condition: AlertCondition;
  actions: AlertActions;
  enabled: boolean;
  /** Stop after this many triggers (0 = unlimited). */
  maxTriggers: number;
  fired: number;
  lastFiredAt: number | null;
  /** Epoch ms after which the alert no longer fires (null = never expires). */
  expiresAt: number | null;
  /** Minimum time between triggers. */
  cooldownMs: number;
  createdAt: number;
}

export interface AlertFire {
  alert: Alert;
  ts: number;
  message: string;
  px?: number;
}

export interface TradeLike {
  ts: number;
  px: number;
  qty: number;
  side: string;
}

export interface BookLike {
  bids: ReadonlyMap<number, number>;
  asks: ReadonlyMap<number, number>;
  bestBid: number;
  bestAsk: number;
}

export type AlertStatus = 'disabled' | 'expired' | 'done' | 'cooldown' | 'waiting';

export function alertStatus(a: Alert, now: number): AlertStatus {
  if (!a.enabled) return 'disabled';
  if (a.expiresAt !== null && now >= a.expiresAt) return 'expired';
  if (a.maxTriggers > 0 && a.fired >= a.maxTriggers) return 'done';
  if (a.lastFiredAt !== null && now - a.lastFiredAt < a.cooldownMs) return 'cooldown';
  return 'waiting';
}

export const DEFAULT_ACTIONS: AlertActions = {
  popup: true,
  sound: true,
  desktop: false,
  log: true,
};

export function newAlert(
  condition: AlertCondition,
  patch: Partial<Alert> = {},
  now = Date.now(),
): Alert {
  return {
    id: `al-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    condition,
    actions: { ...DEFAULT_ACTIONS },
    enabled: true,
    maxTriggers: 0,
    fired: 0,
    lastFiredAt: null,
    expiresAt: null,
    cooldownMs: 30_000,
    createdAt: now,
    ...patch,
  };
}

/** Problems with a condition (empty = valid). */
export function validateCondition(c: AlertCondition): string[] {
  const e: string[] = [];
  const pos = (v: number, label: string) => {
    if (!Number.isFinite(v) || v <= 0) e.push(`${label} must be greater than 0`);
  };
  if (c.kind !== 'connection-lost' && !c.instrumentId) e.push('Choose an instrument');
  if (c.kind === 'price-cross' && !Number.isFinite(c.px)) e.push('Enter a price');
  if (c.kind === 'big-trade') pos(c.minQty, 'Size');
  if (c.kind === 'bar-delta') {
    pos(c.barMs, 'Bar period');
    if (!Number.isFinite(c.value)) e.push('Enter a delta value');
  }
  if (c.kind === 'dom-size') {
    pos(c.minQty, 'Size');
    if (!Number.isFinite(c.withinTicks) || c.withinTicks < 0) e.push('Ticks must be 0 or more');
  }
  return e;
}

export interface DescribeOptions {
  symbol?(instrumentId: string): string;
  price?(instrumentId: string, px: number): string;
}

export function describeCondition(c: AlertCondition, o: DescribeOptions = {}): string {
  const sym = (id: string) => o.symbol?.(id) ?? id;
  switch (c.kind) {
    case 'price-cross':
      return `${sym(c.instrumentId)} price crosses ${c.direction === 'any' ? '' : c.direction === 'up' ? 'above ' : 'below '}${o.price?.(c.instrumentId, c.px) ?? c.px}`;
    case 'big-trade':
      return `${sym(c.instrumentId)} big ${c.side === 'any' ? '' : c.side + ' '}trade ≥ ${c.minQty}`;
    case 'bar-delta':
      return `${sym(c.instrumentId)} ${Math.round(c.barMs / 60_000)}m bar delta ${c.op === 'gte' ? '≥' : '≤'} ${c.value}`;
    case 'dom-size':
      return `${sym(c.instrumentId)} DOM ${c.side === 'any' ? 'level' : c.side} ≥ ${c.minQty} within ${c.withinTicks} ticks`;
    default:
      return `Connection lost (${c.instrumentId ? sym(c.instrumentId) : 'any'})`;
  }
}

interface Runtime {
  lastPx?: number;
  barStart?: number;
  delta?: number;
  barFired?: boolean;
  domActive?: boolean;
  states?: Map<string, string>;
}

const BAD = new Set(['disconnected', 'error']);

/** Evaluates alerts against market events; handles enable, expiry, trigger count and cooldown. */
export class AlertEngine {
  private alerts: Alert[] = [];
  private rt = new Map<string, Runtime>();
  private fireListeners = new Set<(f: AlertFire) => void>();
  private changeListeners = new Set<() => void>();

  constructor(private now: () => number = () => Date.now()) {}

  list(): Alert[] {
    return this.alerts;
  }

  set(alerts: Alert[]): void {
    this.alerts = alerts;
    this.changed();
  }

  add(a: Alert): void {
    this.alerts = [...this.alerts, a];
    this.changed();
  }

  update(id: string, patch: Partial<Alert>): void {
    this.alerts = this.alerts.map((a) => (a.id === id ? { ...a, ...patch } : a));
    if (patch.condition) this.rt.delete(id);
    this.changed();
  }

  remove(id: string): void {
    this.alerts = this.alerts.filter((a) => a.id !== id);
    this.rt.delete(id);
    this.changed();
  }

  onFire(fn: (f: AlertFire) => void): () => void {
    this.fireListeners.add(fn);
    return () => this.fireListeners.delete(fn);
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private changed(): void {
    for (const l of this.changeListeners) l();
  }

  /** Instruments that live alerts need data for (so feeds can stay up without a window). */
  instruments(): string[] {
    const now = this.now();
    const s = new Set<string>();
    for (const a of this.alerts) {
      const st = alertStatus(a, now);
      if ((st === 'waiting' || st === 'cooldown') && a.condition.instrumentId)
        s.add(a.condition.instrumentId);
    }
    return [...s];
  }

  private runtime(id: string): Runtime {
    let r = this.rt.get(id);
    if (!r) this.rt.set(id, (r = {}));
    return r;
  }

  /** Master switch (Settings → Alerts): while paused, alerts are kept but never trigger. */
  paused = false;

  private fire(stale: Alert, message: string, px?: number): void {
    if (this.paused) return;
    const now = this.now();
    const a = this.alerts.find((x) => x.id === stale.id);
    if (!a || alertStatus(a, now) !== 'waiting') return;
    const next: Alert = { ...a, fired: a.fired + 1, lastFiredAt: now };
    this.alerts = this.alerts.map((x) => (x.id === a.id ? next : x));
    for (const l of this.fireListeners) l({ alert: next, ts: now, message, px });
    this.changed();
  }

  onTrades(instrumentId: string, trades: readonly TradeLike[]): void {
    for (const a of [...this.alerts]) {
      const c = a.condition;
      if (!a.enabled || c.kind === 'connection-lost' || c.kind === 'dom-size') continue;
      if (c.instrumentId !== instrumentId) continue;
      const r = this.runtime(a.id);
      for (const t of trades) {
        if (c.kind === 'price-cross') {
          const prev = r.lastPx;
          r.lastPx = t.px;
          if (prev === undefined) continue;
          const up = prev < c.px && t.px >= c.px;
          const down = prev > c.px && t.px <= c.px;
          if ((up && c.direction !== 'down') || (down && c.direction !== 'up'))
            this.fire(a, `Price crossed ${up ? 'above' : 'below'} the alert level`, t.px);
        } else if (c.kind === 'big-trade') {
          if (t.qty >= c.minQty && (c.side === 'any' || c.side === t.side))
            this.fire(a, `Big ${t.side} trade ${t.qty}`, t.px);
        } else {
          const start = Math.floor(t.ts / c.barMs) * c.barMs;
          if (r.barStart !== start) {
            r.barStart = start;
            r.delta = 0;
            r.barFired = false;
          }
          r.delta = (r.delta ?? 0) + (t.side === 'buy' ? t.qty : t.side === 'sell' ? -t.qty : 0);
          const hit = c.op === 'gte' ? r.delta >= c.value : r.delta <= c.value;
          if (hit && !r.barFired) {
            r.barFired = true;
            this.fire(a, `Bar delta ${r.delta}`, t.px);
          }
        }
      }
    }
  }

  onBook(instrumentId: string, book: BookLike): void {
    for (const a of [...this.alerts]) {
      const c = a.condition;
      if (!a.enabled || c.kind !== 'dom-size' || c.instrumentId !== instrumentId) continue;
      const r = this.runtime(a.id);
      let hit: { px: number; qty: number; side: string } | null = null;
      if (c.side !== 'ask' && Number.isFinite(book.bestBid))
        for (const [px, q] of book.bids)
          if (q >= c.minQty && px >= book.bestBid - c.withinTicks && (!hit || q > hit.qty))
            hit = { px, qty: q, side: 'bid' };
      if (c.side !== 'bid' && Number.isFinite(book.bestAsk))
        for (const [px, q] of book.asks)
          if (q >= c.minQty && px <= book.bestAsk + c.withinTicks && (!hit || q > hit.qty))
            hit = { px, qty: q, side: 'ask' };
      const was = r.domActive ?? false;
      r.domActive = hit !== null;
      if (hit && !was) this.fire(a, `DOM ${hit.side} level size ${hit.qty}`, hit.px);
    }
  }

  onStatus(instrumentId: string, state: string): void {
    for (const a of [...this.alerts]) {
      const c = a.condition;
      if (!a.enabled || c.kind !== 'connection-lost') continue;
      if (c.instrumentId !== null && c.instrumentId !== instrumentId) continue;
      const r = this.runtime(a.id);
      r.states ??= new Map();
      const prev = r.states.get(instrumentId);
      r.states.set(instrumentId, state);
      if (BAD.has(state) && !(prev !== undefined && BAD.has(prev)))
        this.fire(a, `Connection ${state}: ${instrumentId}`);
    }
  }
}
