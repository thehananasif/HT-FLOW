/**
 * Hard limits for AI agent orders. Installed as a pre-trade check on the paper engine (the same
 * hook the risk engine uses), applied to every order tagged {@link AGENT_TAG}. The account-level
 * risk rules (Risk window, Settings → Risk) still run for these orders too.
 */
import type { PreTradeCheck } from '@htflow/trading';

export const AGENT_TAG = 'ai-agent';

export interface AgentLimits {
  /** Largest quantity of one order / position change. */
  maxQty: number;
  maxOrdersPerHour: number;
  /** Day P&L (account currency) at or below −value stops new risk from the agent. */
  dailyLossStop: number;
  /** Instrument ids or symbols (case-insensitive); empty = any instrument. */
  allowedSymbols: string[];
  /** Ask the user before each order the agent places. */
  confirmEachTrade: boolean;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxQty: 1,
  maxOrdersPerHour: 10,
  dailyLossStop: 200,
  allowedSymbols: [],
  confirmEachTrade: true,
};

export function sanitizeLimits(raw: unknown): AgentLimits {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AgentLimits>;
  const num = (v: unknown, d: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
  return {
    maxQty: num(r.maxQty, DEFAULT_LIMITS.maxQty, 0.000001, 1e6),
    maxOrdersPerHour: Math.round(num(r.maxOrdersPerHour, DEFAULT_LIMITS.maxOrdersPerHour, 1, 1000)),
    dailyLossStop: num(r.dailyLossStop, DEFAULT_LIMITS.dailyLossStop, 1, 1e9),
    allowedSymbols: Array.isArray(r.allowedSymbols)
      ? r.allowedSymbols
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim())
          .slice(0, 100)
      : [],
    confirmEachTrade: r.confirmEachTrade !== false,
  };
}

export function parseSymbols(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function symbolAllowed(instrumentId: string, allowed: readonly string[]): boolean {
  if (!allowed.length) return true;
  const id = instrumentId.toLowerCase();
  const sym = id.includes(':') ? id.slice(id.lastIndexOf(':') + 1) : id;
  return allowed.some((a) => {
    const x = a.toLowerCase();
    return x === id || x === sym;
  });
}

export interface GuardOrder {
  accountId: string;
  instrumentId: string;
  qty: number;
  reduceOnly?: boolean;
}

export interface GuardContext {
  accountKind: 'paper' | 'replay' | 'broker';
  /** Realized + open P&L of the account today. */
  dayPnl: number;
  now: number;
}

const HOUR = 3_600_000;

export class AgentGuard {
  limits: AgentLimits = { ...DEFAULT_LIMITS };
  private armedLive = false;
  private killed = false;
  private orderTimes: number[] = [];
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify() {
    for (const l of this.listeners) l();
  }

  get isKilled(): boolean {
    return this.killed;
  }
  get isLiveArmed(): boolean {
    return this.armedLive;
  }

  setLimits(l: AgentLimits): void {
    this.limits = sanitizeLimits(l);
    this.notify();
  }

  /** Live (non-paper) accounts, for this app session only (never persisted). */
  armLive(on: boolean): void {
    this.armedLive = on && !this.killed;
    this.notify();
  }

  /** Kill switch: blocks every agent order and disarms live trading until reset. */
  kill(): void {
    this.killed = true;
    this.armedLive = false;
    this.notify();
  }

  resetKill(): void {
    this.killed = false;
    this.notify();
  }

  ordersInLastHour(now: number): number {
    this.orderTimes = this.orderTimes.filter((t) => now - t < HOUR);
    return this.orderTimes.length;
  }

  /** Reason to reject, or null when the order is within the limits. */
  check(o: GuardOrder, ctx: GuardContext): string | null {
    const l = this.limits;
    if (this.killed) return 'AI kill switch is on';
    if (ctx.accountKind !== 'paper' && !this.armedLive)
      return 'AI agent may trade live accounts only after you arm live trading for this session';
    if (!(o.qty > 0)) return 'Quantity must be greater than 0';
    if (o.qty > l.maxQty) return `AI limit: quantity ${o.qty} is above the maximum ${l.maxQty}`;
    if (!symbolAllowed(o.instrumentId, l.allowedSymbols))
      return `AI limit: ${o.instrumentId} is not in the allowed symbols`;
    if (this.ordersInLastHour(ctx.now) >= l.maxOrdersPerHour)
      return `AI limit: ${l.maxOrdersPerHour} orders per hour reached`;
    if (!o.reduceOnly && ctx.dayPnl <= -l.dailyLossStop)
      return `AI limit: daily loss stop (${l.dailyLossStop}) reached`;
    return null;
  }

  /** Counts an accepted order toward the hourly limit. */
  record(now: number): void {
    this.orderTimes.push(now);
  }
}

/** Minimal engine surface (the paper engine) the guard installs itself on. */
export interface GuardHost {
  preTradeChecks: PreTradeCheck[];
  accounts: Map<string, { kind: 'paper' | 'replay' | 'broker' }>;
}

/**
 * Enforces the limits inside the engine for every order tagged {@link AGENT_TAG}: an order that
 * gets past the tool layer is still rejected here. Returns an uninstaller.
 */
export function installAgentGuard(
  host: GuardHost,
  guard: AgentGuard,
  dayPnl: (accountId: string) => number,
  now: () => number = Date.now,
): () => void {
  const check: PreTradeCheck = (req) => {
    if (req.tag !== AGENT_TAG) return null;
    const t = now();
    const reason = guard.check(req, {
      accountKind: host.accounts.get(req.accountId)?.kind ?? 'broker',
      dayPnl: dayPnl(req.accountId),
      now: t,
    });
    if (!reason) guard.record(t);
    return reason;
  };
  host.preTradeChecks.push(check);
  return () => {
    const i = host.preTradeChecks.indexOf(check);
    if (i >= 0) host.preTradeChecks.splice(i, 1);
  };
}
