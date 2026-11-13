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
  | { kind: 'connection-lost'; instrumentId: string | null }
  /**
   * Funding rate (live perpetuals) ≥ / ≤ value, or |rate| ≥ value. `value` is in percent per
   * funding interval (0.01 = 0.01 %). Fires when the rate enters the condition.
   */
  | { kind: 'funding'; instrumentId: string; op: 'gte' | 'lte' | 'abs-gte'; value: number }
  /**
   * Liquidations (live derivatives venues): one liquidation ≥ minQty (windowMs = 0), or the sum
   * of liquidations within a rolling window ≥ minQty. `side` is the liquidation order side:
   * 'sell' = longs liquidated, 'buy' = shorts liquidated.
   */
  | {
      kind: 'liquidation';
      instrumentId: string;
      side: 'buy' | 'sell' | 'any';
      minQty: number;
      windowMs: number;
    }
  /**
   * Last price crosses / enters / exits a chart drawing (P12 "alert on cross"). The geometry is
   * resolved at evaluation time through `AlertEngine.setDrawingDetector`, so moving the drawing
   * moves the alert.
   */
  | {
      kind: 'drawing';
      instrumentId: string;
      windowId: string;
      drawingId: string;
      /** Tool label shown in lists ("Trend line", "Rectangle"…). */
      label: string;
    }
  /**
   * A value series pushed by its producer (indicators, studies, strategies) through
   * `AlertEngine.onValue(instrumentId, key, value)`: crosses / is ≥ / ≤ a level.
   */
  | {
      kind: 'indicator';
      instrumentId: string;
      /** Series key chosen by the producer, e.g. "rsi(14)@chart-3". */
      key: string;
      /** Human label, e.g. "RSI (14)". */
      label: string;
      op: 'cross-up' | 'cross-down' | 'cross' | 'gte' | 'lte';
      value: number;
    };

export type AlertKind = AlertCondition['kind'];

export interface AlertActions {
  popup: boolean;
  sound: boolean;
  desktop: boolean;
  log: boolean;
  /** Flash the window / taskbar button. */
  flash?: boolean;
  /** Send to the user's Telegram bot (token + chat id in the vault). */
  telegram?: boolean;
  /** Send to the user's Discord webhook (URL in the vault). */
  discord?: boolean;
  /** Sound to play: a built-in sound id or "custom:<id>" (empty = the Alert sound event). */
  soundRef?: string;
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
  flash: false,
  telegram: false,
  discord: false,
};

export const ALERT_KINDS: AlertKind[] = [
  'price-cross',
  'big-trade',
  'bar-delta',
  'dom-size',
  'connection-lost',
  'funding',
  'liquidation',
  'drawing',
  'indicator',
];

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
  if (c.kind === 'funding') {
    if (!Number.isFinite(c.value)) e.push('Enter a funding rate');
    else if (c.op === 'abs-gte' && c.value <= 0) e.push('Funding rate must be greater than 0');
  }
  if (c.kind === 'liquidation') {
    pos(c.minQty, 'Size');
    if (!Number.isFinite(c.windowMs) || c.windowMs < 0) e.push('Window must be 0 or more');
  }
  if (c.kind === 'drawing' && (!c.windowId || !c.drawingId)) e.push('Choose a drawing');
  if (c.kind === 'indicator') {
    if (!c.key) e.push('Choose an indicator');
    if (!Number.isFinite(c.value)) e.push('Enter a value');
  }
  return e;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Validates a saved alert (profile settings, imports). Unknown kinds and broken shapes are
 * dropped (null); missing optional fields get defaults so older saves keep working.
 */
export function normalizeAlert(raw: unknown): Alert | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !isObj(raw.condition)) return null;
  const c = raw.condition as unknown as AlertCondition;
  if (!ALERT_KINDS.includes(c.kind)) return null;
  if (c.kind !== 'connection-lost' && typeof c.instrumentId !== 'string') return null;
  if (validateCondition(c).length) return null;
  const act = isObj(raw.actions) ? raw.actions : {};
  const flag = (k: keyof AlertActions, d: boolean): boolean =>
    typeof act[k] === 'boolean' ? (act[k] as boolean) : d;
  const actions: AlertActions = {
    popup: flag('popup', true),
    sound: flag('sound', true),
    desktop: flag('desktop', false),
    log: flag('log', true),
    flash: flag('flash', false),
    telegram: flag('telegram', false),
    discord: flag('discord', false),
  };
  if (typeof act.soundRef === 'string' && act.soundRef) actions.soundRef = act.soundRef;
  return {
    id: raw.id,
    condition: c,
    actions,
    enabled: raw.enabled !== false,
    maxTriggers: finite(raw.maxTriggers) && raw.maxTriggers >= 0 ? Math.floor(raw.maxTriggers) : 0,
    fired: finite(raw.fired) && raw.fired >= 0 ? Math.floor(raw.fired) : 0,
    lastFiredAt: finite(raw.lastFiredAt) ? raw.lastFiredAt : null,
    expiresAt: finite(raw.expiresAt) ? raw.expiresAt : null,
    cooldownMs: finite(raw.cooldownMs) && raw.cooldownMs >= 0 ? raw.cooldownMs : 30_000,
    createdAt: finite(raw.createdAt) ? raw.createdAt : 0,
  };
}

export function normalizeAlerts(raw: unknown): Alert[] {
  if (!Array.isArray(raw)) return [];
  const out: Alert[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const a = normalizeAlert(r);
    if (a && !seen.has(a.id)) {
      seen.add(a.id);
      out.push(a);
    }
  }
  return out;
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
    case 'funding':
      return `${sym(c.instrumentId)} funding ${c.op === 'gte' ? '≥' : c.op === 'lte' ? '≤' : '|rate| ≥'} ${c.value}%`;
    case 'liquidation': {
      const who = c.side === 'sell' ? 'long ' : c.side === 'buy' ? 'short ' : '';
      return c.windowMs > 0
        ? `${sym(c.instrumentId)} ${who}liquidations ≥ ${c.minQty} in ${fmtWindow(c.windowMs)}`
        : `${sym(c.instrumentId)} ${who}liquidation ≥ ${c.minQty}`;
    }
    case 'drawing':
      return `${sym(c.instrumentId)} ${c.label} (drawing)`;
    case 'indicator': {
      const ops = {
        'cross-up': 'crosses above',
        'cross-down': 'crosses below',
        cross: 'crosses',
        gte: '≥',
        lte: '≤',
      } as const;
      return `${sym(c.instrumentId)} ${c.label} ${ops[c.op]} ${c.value}`;
    }
    default:
      return `Connection lost (${c.instrumentId ? sym(c.instrumentId) : 'any'})`;
  }
}

function fmtWindow(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

function round(v: number, dp: number): number {
  const k = 10 ** dp;
  return Math.round(v * k) / k;
}

/** Drawing alerts: the UI resolves the drawing and its geometry (null = no event). */
export type DrawingDetector = (
  c: Extract<AlertCondition, { kind: 'drawing' }>,
  prev: { t: number; px: number },
  cur: { t: number; px: number },
) => { message: string; px?: number } | null;

export interface FundingLike {
  ts: number;
  /** Rate per funding interval as a fraction (0.0001 = 0.01 %). */
  rate: number;
}

export interface LiquidationLike {
  ts: number;
  side: 'buy' | 'sell';
  px: number;
  qty: number;
}

interface Runtime {
  lastPx?: number;
  barStart?: number;
  delta?: number;
  barFired?: boolean;
  domActive?: boolean;
  states?: Map<string, string>;
  /** Funding / liquidation-window / indicator "condition currently true" latch. */
  active?: boolean;
  liq?: { ts: number; qty: number }[];
  lastValue?: number;
  lastSample?: { t: number; px: number };
}

const BAD = new Set(['disconnected', 'error']);

/** Evaluates alerts against market events; handles enable, expiry, trigger count and cooldown. */
export class AlertEngine {
  private alerts: Alert[] = [];
  private rt = new Map<string, Runtime>();
  private fireListeners = new Set<(f: AlertFire) => void>();
  private changeListeners = new Set<() => void>();

  private drawingDetector: DrawingDetector | null = null;

  constructor(private now: () => number = () => Date.now()) {}

  /** Installs the resolver for `drawing` conditions (the UI owns the drawings). */
  setDrawingDetector(fn: DrawingDetector | null): void {
    this.drawingDetector = fn;
  }

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

  private fire(stale: Alert, message: string, px?: number): void {
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
      if (!a.enabled) continue;
      if (
        c.kind !== 'price-cross' &&
        c.kind !== 'big-trade' &&
        c.kind !== 'bar-delta' &&
        c.kind !== 'drawing'
      )
        continue;
      if (c.instrumentId !== instrumentId) continue;
      const r = this.runtime(a.id);
      for (const t of trades) {
        if (c.kind === 'drawing') {
          const prev = r.lastSample;
          const cur = { t: t.ts, px: t.px };
          r.lastSample = cur;
          if (!prev || prev.px === cur.px || !this.drawingDetector) continue;
          const hit = this.drawingDetector(c, prev, cur);
          if (hit) this.fire(a, hit.message, hit.px ?? t.px);
        } else if (c.kind === 'price-cross') {
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

  /** Funding rate updates (live perpetuals). */
  onFunding(instrumentId: string, f: FundingLike): void {
    if (!Number.isFinite(f.rate)) return;
    const pct = f.rate * 100;
    for (const a of [...this.alerts]) {
      const c = a.condition;
      if (!a.enabled || c.kind !== 'funding' || c.instrumentId !== instrumentId) continue;
      const r = this.runtime(a.id);
      const hit =
        c.op === 'gte'
          ? pct >= c.value
          : c.op === 'lte'
            ? pct <= c.value
            : Math.abs(pct) >= c.value;
      const was = r.active ?? false;
      r.active = hit;
      if (hit && !was) this.fire(a, `Funding rate ${round(pct, 4)}%`);
    }
  }

  /** Liquidations as they arrive (live derivatives venues). */
  onLiquidations(instrumentId: string, list: readonly LiquidationLike[]): void {
    for (const a of [...this.alerts]) {
      const c = a.condition;
      if (!a.enabled || c.kind !== 'liquidation' || c.instrumentId !== instrumentId) continue;
      const r = this.runtime(a.id);
      for (const l of list) {
        if (c.side !== 'any' && l.side !== c.side) continue;
        const who = l.side === 'sell' ? 'Long' : 'Short';
        if (c.windowMs <= 0) {
          if (l.qty >= c.minQty) this.fire(a, `${who} liquidation ${round(l.qty, 6)}`, l.px);
          continue;
        }
        r.liq = [...(r.liq ?? []), { ts: l.ts, qty: l.qty }].filter(
          (x) => l.ts - x.ts < c.windowMs,
        );
        const sum = r.liq.reduce((s, x) => s + x.qty, 0);
        const hit = sum >= c.minQty;
        const was = r.active ?? false;
        r.active = hit;
        if (hit && !was)
          this.fire(a, `${round(sum, 6)} liquidated in ${fmtWindow(c.windowMs)}`, l.px);
      }
    }
  }

  /**
   * Pushes one value of a series (indicator line, study output) for `indicator` alerts. `px` is
   * the price shown with the alert (optional).
   */
  onValue(instrumentId: string, key: string, value: number, px?: number): void {
    if (!Number.isFinite(value)) return;
    for (const a of [...this.alerts]) {
      const c = a.condition;
      if (!a.enabled || c.kind !== 'indicator') continue;
      if (c.instrumentId !== instrumentId || c.key !== key) continue;
      const r = this.runtime(a.id);
      const prev = r.lastValue;
      r.lastValue = value;
      if (c.op === 'gte' || c.op === 'lte') {
        const hit = c.op === 'gte' ? value >= c.value : value <= c.value;
        const was = r.active ?? false;
        r.active = hit;
        if (hit && !was) this.fire(a, `${c.label} ${round(value, 6)}`, px);
        continue;
      }
      if (prev === undefined) continue;
      const up = prev < c.value && value >= c.value;
      const down = prev > c.value && value <= c.value;
      if ((up && c.op !== 'cross-down') || (down && c.op !== 'cross-up'))
        this.fire(a, `${c.label} crossed ${up ? 'above' : 'below'} ${c.value}`, px);
    }
  }
}

export * from './delivery';
