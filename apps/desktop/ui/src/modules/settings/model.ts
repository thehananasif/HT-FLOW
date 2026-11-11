/** Pure helpers of the Settings window: trading hours, commission rules, hotkey presets. */
import type { HotkeyOverrides } from '../../shell/commands';
import type { CommissionRule } from '../../state/settings';

// ------------------------------------------------------------------ trading hours

export interface ExchangeHours {
  id: string;
  name: string;
  tz: string;
  /** Weekly open intervals in exchange-local minutes of week (0 = Sunday 00:00). */
  open: [number, number][];
  note: string;
}

const D = 1440;
const hm = (h: number, m = 0) => h * 60 + m;
/** Sun–Thu evening opens, closing the next day (CME Globex style). */
const overnight = (openH: number, openM: number, closeH: number, closeM = 0) =>
  [0, 1, 2, 3, 4].map((d) => [d * D + hm(openH, openM), (d + 1) * D + hm(closeH, closeM)]) as [
    number,
    number,
  ][];
const weekdays = (a: number, b: number) =>
  [1, 2, 3, 4, 5].map((d) => [d * D + a, d * D + b]) as [number, number][];

/** Simplified regular trading hours (no holidays). */
export const EXCHANGES: ExchangeHours[] = [
  {
    id: 'cme',
    name: 'CME Globex',
    tz: 'America/Chicago',
    open: overnight(17, 0, 16),
    note: 'Sun–Fri 17:00–16:00 CT, daily halt 16:00–17:00',
  },
  {
    id: 'nymex',
    name: 'NYMEX',
    tz: 'America/New_York',
    open: overnight(18, 0, 17),
    note: 'Sun–Fri 18:00–17:00 ET',
  },
  {
    id: 'comex',
    name: 'COMEX',
    tz: 'America/New_York',
    open: overnight(18, 0, 17),
    note: 'Sun–Fri 18:00–17:00 ET',
  },
  {
    id: 'eurex',
    name: 'EUREX',
    tz: 'Europe/Berlin',
    open: weekdays(hm(1, 15), hm(22)),
    note: 'Mon–Fri 01:15–22:00 CET (index futures)',
  },
  {
    id: 'ice-us',
    name: 'ICE US',
    tz: 'America/New_York',
    open: overnight(20, 0, 18),
    note: 'Sun–Fri 20:00–18:00 ET',
  },
  {
    id: 'nyse',
    name: 'NYSE / NASDAQ',
    tz: 'America/New_York',
    open: weekdays(hm(9, 30), hm(16)),
    note: 'Mon–Fri 09:30–16:00 ET (regular session)',
  },
  { id: 'crypto', name: 'Crypto', tz: 'UTC', open: [[0, 7 * D]], note: '24/7' },
];

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Exchange-local minute of week. */
export function minuteOfWeek(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return (WD[get('weekday')] ?? 0) * D + Number(get('hour')) * 60 + Number(get('minute'));
}

export function exchangeStatus(ex: ExchangeHours, at: Date): { open: boolean; minutesToChange: number } {
  const m = minuteOfWeek(ex.tz, at);
  const inside = ex.open.find(([a, b]) => m >= a && m < b);
  if (inside) return { open: true, minutesToChange: inside[1] >= 7 * D && inside[0] === 0 ? Infinity : inside[1] - m };
  let best = Infinity;
  for (const [a] of ex.open) best = Math.min(best, a > m ? a - m : a + 7 * D - m);
  return { open: false, minutesToChange: best };
}

export function formatDuration(min: number): string {
  if (!Number.isFinite(min)) return '—';
  const d = Math.floor(min / D);
  const h = Math.floor((min % D) / 60);
  const m = min % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

// ------------------------------------------------------------------ commission

export interface CommissionDefaults {
  makerPct: number;
  takerPct: number;
  perContractRT: number;
}

export interface ResolvedCommission extends CommissionDefaults {
  ruleId: string | null;
}

/** Most specific rule wins: account+instrument > instrument > account > defaults; later wins ties. */
export function resolveCommission(
  rules: CommissionRule[],
  defaults: CommissionDefaults,
  accountId: string,
  instrumentId: string,
): ResolvedCommission {
  let best: CommissionRule | null = null;
  let bestScore = -1;
  for (const r of rules) {
    const acc = r.accountId === '*' ? 0 : r.accountId === accountId ? 1 : -1;
    const ins = r.instrumentId === '*' ? 0 : r.instrumentId === instrumentId ? 2 : -1;
    if (acc < 0 || ins < 0) continue;
    const score = acc + ins;
    if (score >= bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best
    ? {
        makerPct: best.makerPct,
        takerPct: best.takerPct,
        perContractRT: best.perContractRT,
        ruleId: best.id,
      }
    : { ...defaults, ruleId: null };
}

/** Paper-engine account fields for an instrument (futures: per-unit per side; crypto: taker fraction). */
export function engineFields(c: CommissionDefaults, futures: boolean) {
  return futures
    ? { commissionPerUnit: c.perContractRT / 2, takerFee: 0 }
    : { commissionPerUnit: 0, takerFee: c.takerPct / 100 };
}

// ------------------------------------------------------------------ hotkey presets

export const HOTKEY_PRESETS: Record<'htflow' | 'scalper' | 'classic', HotkeyOverrides> = {
  // Appendix C defaults = the commands' own shortcuts.
  htflow: {},
  scalper: {
    'flatten-all': { shortcut: 'Ctrl+Shift+F', scope: 'global' },
    breakeven: { shortcut: 'B', scope: 'trading' },
    'trading-panel': { shortcut: 'T', scope: 'global' },
    'layout.single': { shortcut: 'Alt+1' },
    'layout.dom-chart-panel': { shortcut: 'Alt+2' },
  },
  classic: {
    palette: { shortcut: 'Ctrl+Shift+P' },
    'trading-panel': { shortcut: 'F10' },
    breakeven: { shortcut: 'Ctrl+B' },
    'flatten-all': { shortcut: 'Ctrl+Shift+X' },
    lock: { shortcut: 'Ctrl+Shift+L' },
    'fp.volume': { shortcut: 'Alt+1', scope: 'chart' },
    'fp.trades': { shortcut: 'Alt+2', scope: 'chart' },
    'fp.bidask': { shortcut: 'Alt+3', scope: 'chart' },
    'fp.delta': { shortcut: 'Alt+4', scope: 'chart' },
  },
};
