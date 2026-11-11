import type { ContractSpec, ExpiryRule } from './types';

/** Futures month codes, January … December. */
export const MONTH_CODES = 'FGHJKMNQUVXZ';

export const CYCLES = {
  monthly: 'FGHJKMNQUVXZ',
  quarterly: 'HMUZ',
  /** Even months (COMEX gold, live cattle style). */
  biMonthlyEven: 'GJMQVZ',
} as const;

const DAY = 86_400_000;

/** UTC date (midnight) helper; month is 0-based and may overflow (handled by Date.UTC). */
export function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

export function isBusinessDay(d: Date): boolean {
  const w = d.getUTCDay();
  return w !== 0 && w !== 6;
}

/** Moves back `n` business days (n = 0 returns the date unchanged). */
export function subtractBusinessDays(d: Date, n: number): Date {
  let t = d.getTime();
  let left = n;
  while (left > 0) {
    t -= DAY;
    if (isBusinessDay(new Date(t))) left--;
  }
  return new Date(t);
}

/** The date itself if it is a business day, otherwise the preceding business day. */
export function onOrBeforeBusinessDay(d: Date): Date {
  let t = d.getTime();
  while (!isBusinessDay(new Date(t))) t -= DAY;
  return new Date(t);
}

function daysInMonth(year: number, month: number): number {
  return utcDate(year, month + 1, 0).getUTCDate();
}

function nthWeekday(year: number, month: number, n: number, weekday: number): Date {
  const first = utcDate(year, month, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return utcDate(year, month, 1 + offset + (n - 1) * 7);
}

function lastWeekday(year: number, month: number, weekday: number): Date {
  const last = utcDate(year, month, daysInMonth(year, month));
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return utcDate(year, month, last.getUTCDate() - back);
}

/** Last trading day (UTC date) of the contract for `year` / `month` (0-based). */
export function expiryDate(rule: ExpiryRule, year: number, month: number): Date | null {
  const shift = (o: number | undefined) => {
    const m = month + (o ?? 0);
    return { y: year + Math.floor(m / 12), m: ((m % 12) + 12) % 12 };
  };
  switch (rule.kind) {
    case 'none':
      return null;
    case 'nthWeekday': {
      const { y, m } = shift(rule.monthOffset);
      return subtractBusinessDays(nthWeekday(y, m, rule.n, rule.weekday), rule.bdBefore ?? 0);
    }
    case 'lastWeekday': {
      const { y, m } = shift(rule.monthOffset);
      return lastWeekday(y, m, rule.weekday);
    }
    case 'dayOfMonth': {
      const { y, m } = shift(rule.monthOffset);
      const day = utcDate(y, m, Math.min(rule.day, daysInMonth(y, m)));
      const bd = rule.bdBefore ?? 0;
      if (bd === 0) return onOrBeforeBusinessDay(day);
      return subtractBusinessDays(rule.adjustFirst ? onOrBeforeBusinessDay(day) : day, bd);
    }
    case 'lastBusinessDay': {
      const { y, m } = shift(rule.monthOffset);
      const d = onOrBeforeBusinessDay(utcDate(y, m, daysInMonth(y, m)));
      return subtractBusinessDays(d, rule.bdBefore ?? 0);
    }
    case 'nthBusinessDay': {
      const { y, m } = shift(rule.monthOffset);
      let d = utcDate(y, m, 1);
      let count = isBusinessDay(d) ? 1 : 0;
      while (count < rule.n) {
        d = new Date(d.getTime() + DAY);
        if (isBusinessDay(d)) count++;
      }
      return d;
    }
    case 'vix': {
      const { y, m } = shift(1);
      const thirdFriday = nthWeekday(y, m, 3, 5);
      return new Date(thirdFriday.getTime() - 30 * DAY);
    }
  }
}

/** "CL" + 2026-12 → "CLZ6" (digits = 1) or "CLZ26" (digits = 2). */
export function contractCode(root: string, year: number, month: number, digits: 1 | 2 = 1): string {
  const y = digits === 1 ? String(year % 10) : String(year % 100).padStart(2, '0');
  return `${root}${MONTH_CODES[month]}${y}`;
}

/**
 * Parses "CLZ6" / "CLZ26" → { root: "CL", month: 11, year } choosing the decade nearest to
 * `ref` (a single-digit year is ambiguous). Returns null when the code has no month/year suffix.
 */
export function parseContractCode(
  code: string,
  ref: Date = new Date(),
): { root: string; month: number; year: number } | null {
  const m = /^(.+?)([FGHJKMNQUVXZ])(\d{1,2})$/.exec(code);
  if (!m) return null;
  const root = m[1]!;
  const month = MONTH_CODES.indexOf(m[2]!);
  const digits = m[3]!;
  const refYear = ref.getUTCFullYear();
  let year: number;
  if (digits.length === 2) {
    year = Math.floor(refYear / 100) * 100 + Number(digits);
    if (year < refYear - 50) year += 100;
  } else {
    const decade = Math.floor(refYear / 10) * 10;
    year = decade + Number(digits);
    if (year < refYear - 2) year += 10;
  }
  return { root, month, year };
}

export interface ContractMonth {
  /** e.g. "CLZ6" */
  code: string;
  year: number;
  /** 0-based */
  month: number;
  /** Last trading day (UTC midnight). */
  expiry: Date;
  /** Date the continuous contract rolls away from this month. */
  rollDate: Date;
}

function rollDaysBefore(spec: ContractSpec): number {
  return spec.roll.kind === 'date' ? spec.roll.daysBefore : spec.roll.fallbackDaysBefore;
}

/**
 * The next `count` listed contract months that have not expired at `now` (the expiry day itself
 * still counts as tradable).
 */
export function listContracts(
  root: string,
  spec: ContractSpec,
  now: Date,
  count = spec.listed,
  digits: 1 | 2 = 1,
): ContractMonth[] {
  const out: ContractMonth[] = [];
  if (spec.expiry.kind === 'none' || !spec.cycle) return out;
  const today = utcDate(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()).getTime();
  // Start a month back: some contracts (CL, NG, HO) expire in the month before their name.
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth() - 1;
  if (m < 0) {
    m += 12;
    y--;
  }
  for (let i = 0; i < 12 * 12 && out.length < count; i++) {
    if (spec.cycle.includes(MONTH_CODES[m]!)) {
      const exp = expiryDate(spec.expiry, y, m);
      if (exp && exp.getTime() >= today) {
        out.push({
          code: contractCode(root, y, m, digits),
          year: y,
          month: m,
          expiry: exp,
          rollDate: new Date(exp.getTime() - rollDaysBefore(spec) * DAY),
        });
      }
    }
    m++;
    if (m === 12) {
      m = 0;
      y++;
    }
  }
  return out;
}

/** Front month for a continuous contract: the first contract whose roll date is still ahead. */
export function frontContract(
  root: string,
  spec: ContractSpec,
  now: Date,
  digits: 1 | 2 = 1,
): ContractMonth | null {
  const list = listContracts(root, spec, now, 3, digits);
  return list.find((c) => c.rollDate.getTime() > now.getTime()) ?? list[0] ?? null;
}

/** The next automatic roll: from the current front month to the following contract. */
export function nextRoll(
  root: string,
  spec: ContractSpec,
  now: Date,
  digits: 1 | 2 = 1,
): { from: ContractMonth; to: ContractMonth; date: Date; days: number } | null {
  const list = listContracts(root, spec, now, 4, digits);
  const i = list.findIndex((c) => c.rollDate.getTime() > now.getTime());
  if (i < 0 || i + 1 >= list.length) return null;
  const from = list[i]!;
  const to = list[i + 1]!;
  return {
    from,
    to,
    date: from.rollDate,
    days: Math.max(0, Math.ceil((from.rollDate.getTime() - now.getTime()) / DAY)),
  };
}
