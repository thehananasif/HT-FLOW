/**
 * Indicator alerts (P13 Alerts tab): "output crosses a level / another output". Pure logic; the
 * app evaluates them after each indicator update and routes fires to the Alerts module.
 */

export type IndicatorAlertCond = 'crossAbove' | 'crossBelow' | 'cross' | 'above' | 'below';

export const ALERT_CONDS: { value: IndicatorAlertCond; label: string }[] = [
  { value: 'crossAbove', label: 'Crosses above' },
  { value: 'crossBelow', label: 'Crosses below' },
  { value: 'cross', label: 'Crosses (either way)' },
  { value: 'above', label: 'Is above' },
  { value: 'below', label: 'Is below' },
];

export interface IndicatorAlert {
  id: string;
  enabled: boolean;
  /** Output id whose value is tested. */
  output: string;
  cond: IndicatorAlertCond;
  /** Compare with a fixed level or with another output of the same indicator. */
  target: 'value' | 'output';
  /** Level in display units (real price for price outputs). */
  value: number;
  /** Other output id when target = 'output'. */
  other: string;
  /** 'close' = evaluate closed bars only; 'tick' = every update of the forming bar. */
  when: 'close' | 'tick';
  /** Fire once, then disable. */
  once: boolean;
  toast: boolean;
  sound: boolean;
  log: boolean;
}

export function newIndicatorAlert(
  output: string,
  id = `a${Date.now().toString(36)}`,
): IndicatorAlert {
  return {
    id,
    enabled: true,
    output,
    cond: 'crossAbove',
    target: 'value',
    value: 0,
    other: output,
    when: 'tick',
    once: false,
    toast: true,
    sound: true,
    log: true,
  };
}

const CONDS = ALERT_CONDS.map((c) => c.value);

/** Validates saved alerts against the indicator's series outputs (bad entries are dropped). */
export function normalizeAlerts(raw: unknown, outputs: string[]): IndicatorAlert[] {
  if (!Array.isArray(raw) || !outputs.length) return [];
  const out: IndicatorAlert[] = [];
  for (const r of raw.slice(0, 20) as Partial<IndicatorAlert>[]) {
    if (!r || typeof r !== 'object' || typeof r.output !== 'string') continue;
    if (!outputs.includes(r.output)) continue;
    const d = newIndicatorAlert(r.output, typeof r.id === 'string' ? r.id : undefined);
    out.push({
      ...d,
      enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
      cond: CONDS.includes(r.cond as IndicatorAlertCond) ? (r.cond as IndicatorAlertCond) : d.cond,
      target: r.target === 'output' ? 'output' : 'value',
      value: typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : 0,
      other: typeof r.other === 'string' && outputs.includes(r.other) ? r.other : r.output,
      when: r.when === 'close' ? 'close' : 'tick',
      once: r.once === true,
      toast: r.toast !== false,
      sound: r.sound !== false,
      log: r.log !== false,
    });
  }
  return out;
}

/** One sample: the tested value and the reference (level or other output). */
export type AlertSample = { x: number; y: number };

/**
 * True when the condition holds between two consecutive samples. Cross conditions need both
 * samples; level conditions fire on the transition into the state (not on every update).
 */
export function alertTriggered(
  cond: IndicatorAlertCond,
  prev: AlertSample | null,
  cur: AlertSample,
): boolean {
  if (Number.isNaN(cur.x) || Number.isNaN(cur.y)) return false;
  const p = prev && !Number.isNaN(prev.x) && !Number.isNaN(prev.y) ? prev : null;
  switch (cond) {
    case 'crossAbove':
      return !!p && p.x <= p.y && cur.x > cur.y;
    case 'crossBelow':
      return !!p && p.x >= p.y && cur.x < cur.y;
    case 'cross':
      return !!p && ((p.x <= p.y && cur.x > cur.y) || (p.x >= p.y && cur.x < cur.y));
    case 'above':
      return cur.x > cur.y && (!p || p.x <= p.y);
    case 'below':
      return cur.x < cur.y && (!p || p.x >= p.y);
  }
}

export function describeIndicatorAlert(
  a: IndicatorAlert,
  label: (output: string) => string,
  fmtValue: (v: number) => string = String,
): string {
  const c = ALERT_CONDS.find((x) => x.value === a.cond)?.label.toLowerCase() ?? a.cond;
  return `${label(a.output)} ${c} ${a.target === 'output' ? label(a.other) : fmtValue(a.value)}`;
}
