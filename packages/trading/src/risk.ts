import type { PaperEngine, PostFillHook, PreTradeCheck } from './paperEngine';
import type { Fill, OrderRequest } from './types';

/* ------------------------------------------------------------------ rules */

export interface NumRule {
  enabled: boolean;
  value: number;
}

/** Per-account risk rules (P23 / P41). Money values are in the account currency. */
export interface RiskRules {
  /** Day P&L (realized + open) ≤ −value → auto-flatten + lock until the next trading day. */
  dailyLossLimit: NumRule;
  /** Equity falls `value` below its high-water mark → flatten + lock until unlocked. */
  trailingDrawdown: NumRule;
  /** Max absolute position per instrument → reject; `perInstrument` overrides by instrument id. */
  maxPositionSize: NumRule & { perInstrument: Record<string, number> };
  /** Orders accepted in the last 60 s → reject new risk-increasing orders. */
  maxOrdersPerMinute: NumRule;
  /** New positions opened today → warn at the limit, lock for the day once flat. */
  maxTradesPerDay: NumRule;
  /** New risk is blocked outside [start, end) in `timeZone` (overnight windows allowed). */
  tradingHours: { enabled: boolean; start: string; end: string };
  /** Day P&L ≥ value → flatten + stop trading for the day. */
  profitTarget: NumRule;
  /** Flatten `value` minutes before a high-impact news event (events arrive via setNewsEvents). */
  newsFlatten: NumRule;
  /** IANA zone that defines the trading day and the trading-hours window. */
  timeZone: string;
}

export type RiskRuleId = Exclude<keyof RiskRules, 'timeZone'>;

export const RISK_RULE_IDS: RiskRuleId[] = [
  'dailyLossLimit',
  'trailingDrawdown',
  'maxPositionSize',
  'maxOrdersPerMinute',
  'maxTradesPerDay',
  'tradingHours',
  'profitTarget',
  'newsFlatten',
];

export function defaultRiskRules(timeZone = 'UTC'): RiskRules {
  return {
    dailyLossLimit: { enabled: true, value: 1000 },
    trailingDrawdown: { enabled: false, value: 3000 },
    maxPositionSize: { enabled: false, value: 10, perInstrument: {} },
    maxOrdersPerMinute: { enabled: false, value: 20 },
    maxTradesPerDay: { enabled: false, value: 15 },
    tradingHours: { enabled: false, start: '09:30', end: '15:55' },
    profitTarget: { enabled: false, value: 2000 },
    newsFlatten: { enabled: false, value: 2 },
    timeZone,
  };
}

export interface RiskPreset {
  id: 'prop-100k' | 'personal-conservative';
  label: string;
  rules(timeZone: string): RiskRules;
}

export const RISK_PRESETS: RiskPreset[] = [
  {
    id: 'prop-100k',
    label: 'Prop firm 100K',
    rules: () => ({
      dailyLossLimit: { enabled: true, value: 1000 },
      trailingDrawdown: { enabled: true, value: 3000 },
      maxPositionSize: { enabled: true, value: 4, perInstrument: {} },
      maxOrdersPerMinute: { enabled: true, value: 20 },
      maxTradesPerDay: { enabled: true, value: 15 },
      tradingHours: { enabled: true, start: '09:30', end: '15:55' },
      profitTarget: { enabled: false, value: 2000 },
      newsFlatten: { enabled: true, value: 2 },
      timeZone: 'America/New_York',
    }),
  },
  {
    id: 'personal-conservative',
    label: 'Personal conservative',
    rules: (timeZone) => ({
      dailyLossLimit: { enabled: true, value: 300 },
      trailingDrawdown: { enabled: true, value: 1000 },
      maxPositionSize: { enabled: true, value: 2, perInstrument: {} },
      maxOrdersPerMinute: { enabled: true, value: 10 },
      maxTradesPerDay: { enabled: true, value: 6 },
      tradingHours: { enabled: false, start: '09:30', end: '16:00' },
      profitTarget: { enabled: true, value: 500 },
      newsFlatten: { enabled: true, value: 5 },
      timeZone,
    }),
  },
];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Human-readable problems with a rule set (empty = valid). */
export function validateRiskRules(r: RiskRules): string[] {
  const errs: string[] = [];
  const pos = (v: number, label: string) => {
    if (!Number.isFinite(v) || v <= 0) errs.push(`${label} must be greater than 0`);
  };
  pos(r.dailyLossLimit.value, 'Daily loss limit');
  pos(r.trailingDrawdown.value, 'Trailing drawdown');
  pos(r.maxPositionSize.value, 'Max position size');
  for (const [k, v] of Object.entries(r.maxPositionSize.perInstrument))
    if (!Number.isFinite(v) || v <= 0) errs.push(`Max position for ${k} must be greater than 0`);
  pos(r.maxOrdersPerMinute.value, 'Max orders per minute');
  pos(r.maxTradesPerDay.value, 'Max trades per day');
  pos(r.profitTarget.value, 'Profit target');
  pos(r.newsFlatten.value, 'Minutes before news');
  if (!HHMM.test(r.tradingHours.start) || !HHMM.test(r.tradingHours.end))
    errs.push('Trading hours must be HH:MM');
  else if (r.tradingHours.start === r.tradingHours.end)
    errs.push('Trading hours start and end must differ');
  if (!isValidTimeZone(r.timeZone)) errs.push(`Unknown time zone ${r.timeZone}`);
  return errs;
}

/** Merges persisted (possibly partial or old) rules over defaults. */
export function sanitizeRiskRules(raw: unknown, timeZone = 'UTC'): RiskRules {
  const d = defaultRiskRules(timeZone);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<Record<keyof RiskRules, unknown>>;
  const num = (k: RiskRuleId): NumRule => {
    const v = r[k] as Partial<NumRule> | undefined;
    const base = d[k] as NumRule;
    return {
      enabled: typeof v?.enabled === 'boolean' ? v.enabled : base.enabled,
      value: typeof v?.value === 'number' && Number.isFinite(v.value) ? v.value : base.value,
    };
  };
  const th = (r.tradingHours ?? {}) as Partial<RiskRules['tradingHours']>;
  const mp = (r.maxPositionSize ?? {}) as Partial<RiskRules['maxPositionSize']>;
  const per: Record<string, number> = {};
  if (mp.perInstrument && typeof mp.perInstrument === 'object')
    for (const [k, v] of Object.entries(mp.perInstrument))
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) per[k] = v;
  return {
    dailyLossLimit: num('dailyLossLimit'),
    trailingDrawdown: num('trailingDrawdown'),
    maxPositionSize: { ...num('maxPositionSize'), perInstrument: per },
    maxOrdersPerMinute: num('maxOrdersPerMinute'),
    maxTradesPerDay: num('maxTradesPerDay'),
    tradingHours: {
      enabled: typeof th.enabled === 'boolean' ? th.enabled : d.tradingHours.enabled,
      start: typeof th.start === 'string' && HHMM.test(th.start) ? th.start : d.tradingHours.start,
      end: typeof th.end === 'string' && HHMM.test(th.end) ? th.end : d.tradingHours.end,
    },
    profitTarget: num('profitTarget'),
    newsFlatten: num('newsFlatten'),
    timeZone:
      typeof r.timeZone === 'string' && isValidTimeZone(r.timeZone) ? r.timeZone : d.timeZone,
  };
}

/* ------------------------------------------------------------------ time helpers */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of `ts` in a time zone. */
export function zonedParts(ts: number, tz: string) {
  const parts: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(ts)) parts[p.type] = p.value;
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour),
    mm: Number(parts.minute),
    ss: Number(parts.second),
  };
}

/** Trading-day key `YYYY-MM-DD` of `ts` in `tz`. */
export function dayKey(ts: number, tz: string): string {
  const p = zonedParts(ts, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Epoch ms of the next local midnight after `ts` in `tz` (DST-safe). */
export function nextDayStart(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  const sinceMidnight = ((p.hh * 60 + p.mm) * 60 + p.ss) * 1000 + (ts % 1000);
  let t = ts - sinceMidnight + 86_400_000;
  // DST days are 23 or 25 hours long: nudge onto local midnight.
  for (let i = 0; i < 3; i++) {
    const q = zonedParts(t, tz);
    if (q.hh === 0 && q.mm === 0) break;
    t += q.hh >= 12 ? (24 - q.hh) * 3_600_000 : -q.hh * 3_600_000;
  }
  return t;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Whether `ts` falls inside [start, end) in `tz`; start > end means an overnight session. */
export function inTradingHours(ts: number, tz: string, start: string, end: string): boolean {
  const p = zonedParts(ts, tz);
  const now = p.hh * 60 + p.mm;
  const a = minutes(start);
  const b = minutes(end);
  return a < b ? now >= a && now < b : now >= a || now < b;
}

/* ------------------------------------------------------------------ engine */

export type RiskEventKind = 'warning' | 'lock' | 'unlock' | 'reject' | 'flatten';

export interface RiskEvent {
  ts: number;
  accountId: string;
  kind: RiskEventKind;
  rule: RiskRuleId | 'manual';
  message: string;
}

export interface RiskStatus {
  accountId: string;
  day: string;
  equity: number;
  /** Realized + open P&L since the start of the trading day. */
  dayPnl: number;
  /** Fraction of the daily loss limit used (0 when the rule is off). */
  dailyLossUsed: number;
  /** Distance below the equity high-water mark. */
  drawdown: number;
  trailingUsed: number;
  tradesToday: number;
  ordersLastMinute: number;
  /** Highest usage across enabled limits (0..1+). */
  usage: number;
  locked: boolean;
  lockReason: string | null;
  lockRule: RiskRuleId | 'manual' | null;
  /** Epoch ms when the lock lifts; null = until unlocked manually. */
  lockedUntil: number | null;
  outsideHours: boolean;
  state: 'ok' | 'warning' | 'locked';
}

/** What survives a restart: active locks. */
export interface RiskLockSnapshot {
  [accountId: string]: { until: number | 'manual'; rule: RiskRuleId | 'manual'; reason: string };
}

interface AcctState {
  day: string;
  dayStartEquity: number;
  peakEquity: number;
  orderTimes: number[];
  tradesToday: number;
  lockedUntil: number | null;
  lockRule: RiskRuleId | 'manual' | null;
  lockReason: string | null;
  warned: Set<string>;
  /** Rules overridden (with the override password) for the rest of the day. */
  suppressed: Set<RiskRuleId>;
  newsBlockUntil: number;
}

export interface RiskDeps {
  now?(): number;
  /** Last traded price (ticks) used to mark open positions. */
  mark?(instrumentId: string): number | undefined;
}

export interface NewsEvent {
  ts: number;
  title: string;
}

const money = (v: number) =>
  (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * Pre-trade and post-fill risk engine over a PaperEngine (P23 / P41). Installs a pre-trade check
 * and a post-fill hook; breaches flatten and lock the account synchronously inside the fill's
 * operation, so the lock is in place before the next order can be placed.
 */
export class RiskEngine {
  private rulesBy = new Map<string, RiskRules>();
  private states = new Map<string, AcctState>();
  private listeners = new Set<(e: RiskEvent) => void>();
  private news: NewsEvent[] = [];
  private readonly check: PreTradeCheck;
  private readonly hook: PostFillHook;
  private evaluating = false;

  constructor(
    readonly engine: PaperEngine,
    private deps: RiskDeps = {},
    public defaultRules: RiskRules = defaultRiskRules(),
  ) {
    this.check = (req) => this.preTrade(req);
    this.hook = (f) => this.onFill(f);
    engine.preTradeChecks.push(this.check);
    engine.postFillHooks.push(this.hook);
  }

  dispose(): void {
    const a = this.engine.preTradeChecks.indexOf(this.check);
    if (a >= 0) this.engine.preTradeChecks.splice(a, 1);
    const b = this.engine.postFillHooks.indexOf(this.hook);
    if (b >= 0) this.engine.postFillHooks.splice(b, 1);
  }

  now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  onEvent(fn: (e: RiskEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emitEvent(accountId: string, kind: RiskEventKind, rule: RiskEvent['rule'], msg: string) {
    const e: RiskEvent = { ts: this.now(), accountId, kind, rule, message: msg };
    for (const l of this.listeners) l(e);
  }

  rules(accountId: string): RiskRules {
    return this.rulesBy.get(accountId) ?? this.defaultRules;
  }

  setRules(accountId: string, rules: RiskRules): void {
    const prev = this.rules(accountId);
    this.rulesBy.set(accountId, rules);
    // A new time zone re-keys the trading day.
    if (prev.timeZone !== rules.timeZone) {
      const st = this.states.get(accountId);
      if (st) st.day = dayKey(this.now(), rules.timeZone);
    }
    this.evaluate(accountId);
  }

  /** Upcoming high-impact events (hook for the economic calendar). */
  setNewsEvents(events: NewsEvent[]): void {
    this.news = [...events].sort((a, b) => a.ts - b.ts);
  }

  private equity(accountId: string): number {
    const acc = this.engine.accounts.get(accountId);
    if (!acc) return 0;
    let open = 0;
    for (const p of this.engine.allPositions(accountId)) {
      const m = this.deps.mark?.(p.instrumentId);
      if (m !== undefined && Number.isFinite(m))
        open += this.engine.unrealized(accountId, p.instrumentId, m);
    }
    return acc.balance + open;
  }

  /** Account state, rolling the trading day (and lifting day locks) when it changed. */
  private acct(accountId: string): AcctState {
    const r = this.rules(accountId);
    const now = this.now();
    const day = dayKey(now, r.timeZone);
    let st = this.states.get(accountId);
    if (!st) {
      const eq = this.equity(accountId);
      st = {
        day,
        dayStartEquity: eq,
        peakEquity: Math.max(eq, this.engine.accounts.get(accountId)?.startingBalance ?? eq),
        orderTimes: [],
        tradesToday: 0,
        lockedUntil: null,
        lockRule: null,
        lockReason: null,
        warned: new Set(),
        suppressed: new Set(),
        newsBlockUntil: 0,
      };
      this.states.set(accountId, st);
    } else if (st.day !== day) {
      st.day = day;
      st.dayStartEquity = this.equity(accountId);
      st.tradesToday = 0;
      st.warned.clear();
      st.suppressed.clear();
    }
    if (st.lockedUntil !== null && Number.isFinite(st.lockedUntil) && now >= st.lockedUntil) {
      st.lockedUntil = null;
      st.lockRule = null;
      st.lockReason = null;
      this.engine.setLocked(accountId, false);
      this.emitEvent(accountId, 'unlock', 'manual', 'New trading day — account unlocked');
    }
    return st;
  }

  private preTrade(req: OrderRequest): string | null {
    const st = this.acct(req.accountId);
    const r = this.rules(req.accountId);
    const now = this.now();
    const pos = this.engine.position(req.accountId, req.instrumentId).qty;
    const signed = req.side === 'buy' ? req.qty : -req.qty;
    const reducing =
      req.reduceOnly ||
      (pos !== 0 && Math.sign(signed) === -Math.sign(pos) && Math.abs(signed) <= Math.abs(pos));
    st.orderTimes = st.orderTimes.filter((t) => now - t < 60_000);
    const reject = (rule: RiskRuleId, msg: string) => {
      this.emitEvent(req.accountId, 'reject', rule, msg);
      return msg;
    };
    if (!reducing) {
      if (st.lockedUntil !== null) return `Risk lock: ${st.lockReason ?? 'locked'}`;
      if (r.newsFlatten.enabled && now < st.newsBlockUntil)
        return reject('newsFlatten', 'Blocked: high-impact news');
      if (
        r.tradingHours.enabled &&
        !inTradingHours(now, r.timeZone, r.tradingHours.start, r.tradingHours.end)
      )
        return reject(
          'tradingHours',
          `Outside trading hours (${r.tradingHours.start}–${r.tradingHours.end} ${r.timeZone})`,
        );
      if (r.maxTradesPerDay.enabled && pos === 0 && st.tradesToday >= r.maxTradesPerDay.value)
        return reject('maxTradesPerDay', `Max trades per day reached (${r.maxTradesPerDay.value})`);
      if (r.maxPositionSize.enabled) {
        const limit = r.maxPositionSize.perInstrument[req.instrumentId] ?? r.maxPositionSize.value;
        if (Math.abs(pos + signed) > limit + 1e-9)
          return reject('maxPositionSize', `Max position size ${limit} exceeded`);
      }
      if (r.maxOrdersPerMinute.enabled && st.orderTimes.length >= r.maxOrdersPerMinute.value)
        return reject(
          'maxOrdersPerMinute',
          `Max orders per minute reached (${r.maxOrdersPerMinute.value})`,
        );
    }
    st.orderTimes.push(now);
    return null;
  }

  private onFill(f: Fill): void {
    const st = this.acct(f.accountId);
    const after = this.engine.position(f.accountId, f.instrumentId).qty;
    const before = after - (f.side === 'buy' ? f.qty : -f.qty);
    const opened =
      Math.abs(before) < 1e-12 || (after !== 0 && Math.sign(after) !== Math.sign(before));
    if (opened && Math.abs(after) > 1e-12) st.tradesToday++;
    this.evaluate(f.accountId);
  }

  /** Checks every limit for one account (or all); breaches flatten and lock. */
  evaluate(accountId?: string): void {
    if (accountId === undefined) {
      for (const id of this.engine.accounts.keys()) this.evaluate(id);
      return;
    }
    if (this.evaluating || !this.engine.accounts.has(accountId)) return;
    this.evaluating = true;
    try {
      this.evaluateOne(accountId);
    } finally {
      this.evaluating = false;
    }
  }

  private evaluateOne(id: string): void {
    const st = this.acct(id);
    const r = this.rules(id);
    const now = this.now();
    const eq = this.equity(id);
    st.peakEquity = Math.max(st.peakEquity, eq);
    if (st.lockedUntil !== null) return;
    const dayPnl = eq - st.dayStartEquity;
    const dd = st.peakEquity - eq;
    const flat = this.engine.allPositions(id).length === 0;
    const on = (k: RiskRuleId) => (r[k] as { enabled: boolean }).enabled && !st.suppressed.has(k);
    const tomorrow = () => nextDayStart(now, r.timeZone);

    if (on('dailyLossLimit') && dayPnl <= -r.dailyLossLimit.value)
      return this.breach(
        id,
        'dailyLossLimit',
        `Daily loss limit hit: ${money(dayPnl)} of ${money(-r.dailyLossLimit.value)} — flattened, locked until tomorrow`,
        tomorrow(),
      );
    if (on('trailingDrawdown') && dd >= r.trailingDrawdown.value)
      return this.breach(
        id,
        'trailingDrawdown',
        `Trailing drawdown ${money(dd)} reached the ${money(r.trailingDrawdown.value)} limit — account locked`,
        Infinity,
      );
    if (on('profitTarget') && dayPnl >= r.profitTarget.value)
      return this.breach(
        id,
        'profitTarget',
        `Profit target ${money(r.profitTarget.value)} reached — trading stopped for the day`,
        tomorrow(),
      );
    if (on('maxTradesPerDay') && st.tradesToday >= r.maxTradesPerDay.value) {
      if (flat)
        return this.breach(
          id,
          'maxTradesPerDay',
          `Max trades per day (${r.maxTradesPerDay.value}) reached — locked until tomorrow`,
          tomorrow(),
        );
      this.warnOnce(
        id,
        st,
        'trades-limit',
        'maxTradesPerDay',
        `Trade ${st.tradesToday} of ${r.maxTradesPerDay.value} today — the account locks when flat`,
      );
    }
    if (on('dailyLossLimit') && dayPnl <= -0.8 * r.dailyLossLimit.value)
      this.warnOnce(
        id,
        st,
        'daily-80',
        'dailyLossLimit',
        `Daily loss at ${Math.round((-dayPnl / r.dailyLossLimit.value) * 100)}% of ${money(r.dailyLossLimit.value)} limit`,
      );
    if (on('trailingDrawdown') && dd >= 0.8 * r.trailingDrawdown.value)
      this.warnOnce(
        id,
        st,
        'trail-80',
        'trailingDrawdown',
        `Trailing drawdown at ${Math.round((dd / r.trailingDrawdown.value) * 100)}% of ${money(r.trailingDrawdown.value)}`,
      );
    if (r.newsFlatten.enabled) {
      const lead = r.newsFlatten.value * 60_000;
      const ev = this.news.find((e) => now >= e.ts - lead && now < e.ts);
      if (ev) {
        st.newsBlockUntil = Math.max(st.newsBlockUntil, ev.ts);
        if (!flat) {
          this.engine.flattenAll(id);
          this.emitEvent(id, 'flatten', 'newsFlatten', `Flattened before news: ${ev.title}`);
        }
      }
    }
  }

  private warnOnce(id: string, st: AcctState, key: string, rule: RiskRuleId, msg: string) {
    if (st.warned.has(key)) return;
    st.warned.add(key);
    this.emitEvent(id, 'warning', rule, msg);
  }

  private breach(id: string, rule: RiskRuleId, msg: string, until: number): void {
    const st = this.acct(id);
    // Flatten first: a locked account rejects every order, including closing ones.
    this.engine.flattenAll(id);
    this.engine.setLocked(id, true);
    st.lockedUntil = until;
    st.lockRule = rule;
    st.lockReason = msg;
    this.emitEvent(id, 'lock', rule, msg);
  }

  /** Locks an account by hand (until unlocked). */
  lock(accountId: string, reason = 'Locked manually'): void {
    const st = this.acct(accountId);
    this.engine.flattenAll(accountId);
    this.engine.setLocked(accountId, true);
    st.lockedUntil = Infinity;
    st.lockRule = 'manual';
    st.lockReason = reason;
    this.emitEvent(accountId, 'lock', 'manual', reason);
  }

  /**
   * Lifts a risk lock (override). The rule that locked the account is suppressed for the rest of
   * the trading day, and the drawdown high-water mark restarts from current equity.
   */
  unlock(accountId: string): void {
    const st = this.acct(accountId);
    if (st.lockRule && st.lockRule !== 'manual') st.suppressed.add(st.lockRule);
    st.lockedUntil = null;
    st.lockRule = null;
    st.lockReason = null;
    st.peakEquity = this.equity(accountId);
    this.engine.setLocked(accountId, false);
    this.emitEvent(accountId, 'unlock', 'manual', 'Account unlocked (override)');
  }

  /** Forget day counters (paper account reset). */
  resetAccount(accountId: string): void {
    this.states.delete(accountId);
  }

  /** Periodic evaluation (mark-to-market, day roll, news). */
  tick(): void {
    this.evaluate();
  }

  status(accountId: string): RiskStatus {
    const st = this.acct(accountId);
    const r = this.rules(accountId);
    const now = this.now();
    const eq = this.equity(accountId);
    const peak = Math.max(st.peakEquity, eq);
    const dayPnl = eq - st.dayStartEquity;
    const dd = peak - eq;
    const dailyLossUsed = r.dailyLossLimit.enabled
      ? Math.max(0, -dayPnl) / r.dailyLossLimit.value
      : 0;
    const trailingUsed = r.trailingDrawdown.enabled ? dd / r.trailingDrawdown.value : 0;
    const tradesUsed = r.maxTradesPerDay.enabled ? st.tradesToday / r.maxTradesPerDay.value : 0;
    const usage = Math.max(dailyLossUsed, trailingUsed, tradesUsed);
    const locked = this.engine.accounts.get(accountId)?.locked ?? false;
    const outsideHours =
      r.tradingHours.enabled &&
      !inTradingHours(now, r.timeZone, r.tradingHours.start, r.tradingHours.end);
    return {
      accountId,
      day: st.day,
      equity: eq,
      dayPnl,
      dailyLossUsed,
      drawdown: dd,
      trailingUsed,
      tradesToday: st.tradesToday,
      ordersLastMinute: st.orderTimes.filter((t) => now - t < 60_000).length,
      usage,
      locked,
      lockReason: st.lockReason ?? (locked ? 'Locked' : null),
      lockRule: st.lockRule,
      lockedUntil:
        st.lockedUntil === null || !Number.isFinite(st.lockedUntil) ? null : st.lockedUntil,
      outsideHours,
      state: locked ? 'locked' : usage >= 0.8 || outsideHours ? 'warning' : 'ok',
    };
  }

  snapshotLocks(): RiskLockSnapshot {
    const out: RiskLockSnapshot = {};
    for (const [id, st] of this.states)
      if (st.lockedUntil !== null && st.lockRule)
        out[id] = {
          until: Number.isFinite(st.lockedUntil) ? st.lockedUntil : 'manual',
          rule: st.lockRule,
          reason: st.lockReason ?? '',
        };
    return out;
  }

  /** Re-applies persisted locks (expired day locks are dropped). */
  restoreLocks(snap: RiskLockSnapshot): void {
    const now = this.now();
    for (const [id, l] of Object.entries(snap)) {
      if (!this.engine.accounts.has(id)) continue;
      const until = l.until === 'manual' ? Infinity : l.until;
      if (until <= now) continue;
      const st = this.acct(id);
      st.lockedUntil = until;
      st.lockRule = l.rule;
      st.lockReason = l.reason;
      this.engine.setLocked(id, true);
    }
  }
}
