import type { Bar } from '@htflow/market-data';
import { pnlPerTick, type BracketSpec, type InstrumentEconomics, type TrailSpec } from './types';

/**
 * ATM templates (auto trade management, P17). A template describes the protective stop, one or
 * more profit targets, auto-breakeven and trailing steps in user-friendly units; `resolveAtm`
 * turns it into an engine BracketSpec (ticks) for one instrument at one reference price.
 */

/** Stop-loss distance unit. `trailing` = a trailing stop whose distance is in `trailUnit`. */
export type AtmSlType = 'ticks' | 'usd' | 'percent' | 'atr' | 'trailing';
/** Take-profit distance unit. */
export type AtmTpUnit = 'usd' | 'percent' | 'points' | 'ticks';

export interface AtmTarget {
  /** Distance from the entry in `tpUnit`. */
  value: number;
  /** Relative share of the position closed at this target (weights, e.g. 1 : 1 : 2). */
  qty: number;
}

export interface AtmTemplate {
  id: string;
  name: string;
  sl: {
    enabled: boolean;
    type: AtmSlType;
    /** Distance in the chosen unit ($ = per contract, % = of entry price, ATR = multiple). */
    value: number;
    /** Unit of the trailing distance when type is 'trailing'. */
    trailUnit: 'ticks' | 'percent' | 'atr';
  };
  tpUnit: AtmTpUnit;
  targets: AtmTarget[];
  breakeven: { enabled: boolean; trigger: number; offset: number };
  /** Trailing steps in ticks: at +trigger move the stop to entry + stopOffset. */
  trailSteps: { trigger: number; stopOffset: number }[];
  /** ATR period (bars) for ATR-based distances. */
  atrPeriod: number;
  /** Built-in presets cannot be deleted (they can be duplicated). */
  builtin?: boolean;
}

export const ATM_SL_TYPES: { value: AtmSlType; label: string }[] = [
  { value: 'ticks', label: 'Ticks' },
  { value: 'usd', label: '$ per contract' },
  { value: 'percent', label: '% of price' },
  { value: 'atr', label: 'ATR multiple' },
  { value: 'trailing', label: 'Trailing' },
];

export const ATM_TP_UNITS: { value: AtmTpUnit; label: string; short: string }[] = [
  { value: 'ticks', label: 'Ticks', short: 'T' },
  { value: 'points', label: 'Points', short: 'pt' },
  { value: 'usd', label: '$ per contract', short: '$' },
  { value: 'percent', label: '% of price', short: '%' },
];

export function blankAtm(id: string, name = 'New template'): AtmTemplate {
  return {
    id,
    name,
    sl: { enabled: true, type: 'ticks', value: 10, trailUnit: 'ticks' },
    tpUnit: 'ticks',
    targets: [{ value: 10, qty: 1 }],
    breakeven: { enabled: false, trigger: 8, offset: 1 },
    trailSteps: [],
    atrPeriod: 14,
  };
}

/** Built-in presets shown in the editor and the template dropdowns. */
export const ATM_PRESETS: AtmTemplate[] = [
  {
    ...blankAtm('preset-scalp', 'Scalp 1:1'),
    sl: { enabled: true, type: 'ticks', value: 8, trailUnit: 'ticks' },
    targets: [{ value: 8, qty: 1 }],
    builtin: true,
  },
  {
    ...blankAtm('preset-3t', 'Three targets + BE'),
    sl: { enabled: true, type: 'ticks', value: 12, trailUnit: 'ticks' },
    targets: [
      { value: 8, qty: 1 },
      { value: 16, qty: 1 },
      { value: 32, qty: 1 },
    ],
    breakeven: { enabled: true, trigger: 8, offset: 1 },
    builtin: true,
  },
  {
    ...blankAtm('preset-runner', 'Runner (trail steps)'),
    sl: { enabled: true, type: 'ticks', value: 16, trailUnit: 'ticks' },
    targets: [
      { value: 12, qty: 1 },
      { value: 60, qty: 1 },
    ],
    breakeven: { enabled: true, trigger: 12, offset: 2 },
    trailSteps: [
      { trigger: 20, stopOffset: 8 },
      { trigger: 30, stopOffset: 16 },
      { trigger: 40, stopOffset: 26 },
    ],
    builtin: true,
  },
  {
    ...blankAtm('preset-atr', 'ATR swing'),
    sl: { enabled: true, type: 'atr', value: 1.5, trailUnit: 'atr' },
    tpUnit: 'percent',
    targets: [
      { value: 0.5, qty: 1 },
      { value: 1, qty: 1 },
    ],
    builtin: true,
  },
  {
    ...blankAtm('preset-trail', 'Trailing stop only'),
    sl: { enabled: true, type: 'trailing', value: 10, trailUnit: 'ticks' },
    targets: [],
    builtin: true,
  },
];

/** Validation errors for a template (empty = valid). */
export function validateAtm(t: AtmTemplate): string[] {
  const e: string[] = [];
  if (!t.name.trim()) e.push('Name is required');
  if (t.sl.enabled && !(t.sl.value > 0)) e.push('Stop distance must be > 0');
  if (!(t.atrPeriod >= 2 && t.atrPeriod <= 500)) e.push('ATR period must be 2–500');
  if (t.targets.length > 8) e.push('At most 8 targets');
  t.targets.forEach((x, i) => {
    if (!(x.value > 0)) e.push(`Target ${i + 1}: distance must be > 0`);
    if (!(x.qty > 0)) e.push(`Target ${i + 1}: quantity share must be > 0`);
  });
  if (!t.sl.enabled && !t.targets.length) e.push('Enable a stop or add a target');
  if (t.breakeven.enabled && !(t.breakeven.trigger > 0)) e.push('Breakeven trigger must be > 0');
  if (t.breakeven.enabled && t.breakeven.offset >= t.breakeven.trigger)
    e.push('Breakeven offset must be below its trigger');
  t.trailSteps.forEach((s, i) => {
    if (!(s.trigger > 0)) e.push(`Step ${i + 1}: trigger must be > 0`);
    if (s.stopOffset >= s.trigger) e.push(`Step ${i + 1}: stop must be below its trigger`);
  });
  return e;
}

/** Coerces unknown persisted data into a valid template, or null. */
export function normalizeAtm(raw: unknown): AtmTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<AtmTemplate>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null;
  const base = blankAtm(r.id, r.name);
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const slType = ATM_SL_TYPES.some((x) => x.value === r.sl?.type) ? r.sl!.type : base.sl.type;
  const trailUnit = (['ticks', 'percent', 'atr'] as const).includes(r.sl?.trailUnit as 'ticks')
    ? r.sl!.trailUnit
    : 'ticks';
  const t: AtmTemplate = {
    id: r.id,
    name: r.name,
    sl: {
      enabled: r.sl?.enabled ?? true,
      type: slType,
      value: num(r.sl?.value, base.sl.value),
      trailUnit,
    },
    tpUnit: ATM_TP_UNITS.some((x) => x.value === r.tpUnit) ? r.tpUnit! : 'ticks',
    targets: Array.isArray(r.targets)
      ? r.targets
          .filter((x) => x && typeof x === 'object')
          .map((x) => ({ value: num(x.value, 10), qty: num(x.qty, 1) }))
          .slice(0, 8)
      : base.targets,
    breakeven: {
      enabled: !!r.breakeven?.enabled,
      trigger: num(r.breakeven?.trigger, base.breakeven.trigger),
      offset: num(r.breakeven?.offset, base.breakeven.offset),
    },
    trailSteps: Array.isArray(r.trailSteps)
      ? r.trailSteps
          .filter((x) => x && typeof x === 'object')
          .map((x) => ({ trigger: num(x.trigger, 10), stopOffset: num(x.stopOffset, 0) }))
      : [],
    atrPeriod: Math.round(num(r.atrPeriod, 14)),
  };
  return validateAtm(t).length ? null : t;
}

export interface AtmContext {
  econ: InstrumentEconomics;
  /** Reference (expected entry) price in ticks. */
  refPx: number;
  /** ATR in ticks (needed for ATR-based distances). */
  atrTicks?: number;
}

/** Converts a distance in `unit` to whole ticks (>= 1), or NaN when it cannot be computed. */
export function toTicks(value: number, unit: AtmTpUnit | 'atr', ctx: AtmContext): number {
  let t: number;
  switch (unit) {
    case 'ticks':
      t = value;
      break;
    case 'points':
      t = value / ctx.econ.tickSize;
      break;
    case 'usd':
      t = value / pnlPerTick(ctx.econ, 1);
      break;
    case 'percent':
      t = (Math.abs(ctx.refPx) * value) / 100;
      break;
    case 'atr':
      t = value * (ctx.atrTicks ?? Number.NaN);
      break;
  }
  if (!Number.isFinite(t) || t <= 0) return Number.NaN;
  return Math.max(1, Math.round(t));
}

/** Template → engine bracket. Throws a readable error when a distance cannot be computed. */
export function resolveAtm(t: AtmTemplate, ctx: AtmContext): BracketSpec {
  const spec: BracketSpec = { atm: t.name };
  if (t.sl.enabled) {
    if (t.sl.type === 'trailing') {
      const trail: TrailSpec =
        t.sl.trailUnit === 'atr'
          ? { kind: 'atr', amount: t.sl.value, atrTicks: ctx.atrTicks }
          : { kind: t.sl.trailUnit, amount: t.sl.value };
      const start = toTicks(t.sl.value, t.sl.trailUnit, ctx);
      if (Number.isNaN(start)) throw new Error('ATR is not available yet for this instrument');
      spec.slTrail = trail;
      spec.slTicks = start;
    } else {
      const ticks = toTicks(t.sl.value, t.sl.type, ctx);
      if (Number.isNaN(ticks))
        throw new Error(
          t.sl.type === 'atr' ? 'ATR is not available yet for this instrument' : 'Invalid stop',
        );
      spec.slTicks = ticks;
    }
  }
  if (t.targets.length) {
    spec.tpTicks = t.targets.map((x) => {
      const ticks = toTicks(x.value, t.tpUnit, ctx);
      if (Number.isNaN(ticks)) throw new Error('Invalid target distance');
      return ticks;
    });
    spec.tpQty = t.targets.map((x) => x.qty);
  }
  if (t.breakeven.enabled)
    spec.breakeven = { trigger: t.breakeven.trigger, offset: t.breakeven.offset };
  if (t.trailSteps.length) spec.trailSteps = t.trailSteps.map((s) => ({ ...s }));
  return spec;
}

/** Wilder ATR in ticks over the last `period` bars (NaN with fewer than period + 1 bars). */
export function atrTicks(bars: readonly Pick<Bar, 'h' | 'l' | 'c'>[], period = 14): number {
  if (bars.length < period + 1) return Number.NaN;
  let atr = 0;
  const start = bars.length - period - 1;
  for (let i = start + 1; i < bars.length; i++) {
    const b = bars[i]!;
    const pc = bars[i - 1]!.c;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    atr += tr;
  }
  return atr / period;
}

/** One-line summary, e.g. "SL 12T · TP 8/16/32T · BE +8→+1 · 3 steps". */
export function describeAtm(t: AtmTemplate): string {
  const parts: string[] = [];
  const unit = (u: string) =>
    u === 'ticks' ? 'T' : u === 'points' ? 'pt' : u === 'usd' ? '$' : u === 'percent' ? '%' : 'ATR';
  if (t.sl.enabled)
    parts.push(
      t.sl.type === 'trailing'
        ? `Trail ${t.sl.value}${unit(t.sl.trailUnit)}`
        : `SL ${t.sl.value}${unit(t.sl.type)}`,
    );
  if (t.targets.length)
    parts.push(`TP ${t.targets.map((x) => x.value).join('/')}${unit(t.tpUnit)}`);
  if (t.breakeven.enabled) parts.push(`BE +${t.breakeven.trigger}→+${t.breakeven.offset}`);
  if (t.trailSteps.length)
    parts.push(`${t.trailSteps.length} step${t.trailSteps.length > 1 ? 's' : ''}`);
  return parts.join(' · ');
}
