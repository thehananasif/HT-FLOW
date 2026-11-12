import { prop } from './model';
import type { Anchor, Drawing, ToolId } from './types';

/**
 * Alert-on-cross geometry (P12): pure functions that decide whether the last price crossed a
 * line / channel boundary or entered / left a rectangle between two consecutive samples.
 * Everything works in (time ms, price ticks) space, independent of the screen.
 */

export type AlertTrigger = 'cross' | 'enter' | 'exit' | 'enter-exit';
export type AlertShape = 'line' | 'channel' | 'zone';

export interface AlertSample {
  t: number;
  px: number;
}

export interface AlertEvent {
  kind: 'cross-up' | 'cross-down' | 'enter' | 'exit';
  /** Price of the boundary that was crossed (ticks). */
  level: number;
}

const SHAPES: Partial<Record<ToolId, AlertShape>> = {
  'horizontal-line': 'line',
  'horizontal-ray': 'line',
  'trend-line': 'line',
  ray: 'line',
  'extended-line': 'line',
  'parallel-channel': 'channel',
  'equidistant-channel': 'channel',
  rectangle: 'zone',
};

export const ALERT_TRIGGERS: { value: AlertTrigger; label: string }[] = [
  { value: 'cross', label: 'Crossing' },
  { value: 'enter', label: 'Entering' },
  { value: 'exit', label: 'Exiting' },
  { value: 'enter-exit', label: 'Entering or exiting' },
];

export function alertShape(type: ToolId): AlertShape | null {
  return SHAPES[type] ?? null;
}

export function supportsAlert(type: ToolId): boolean {
  return alertShape(type) !== null;
}

/** Triggers that make sense for a tool (lines only cross; zones only enter / exit). */
export function triggersFor(type: ToolId): AlertTrigger[] {
  const s = alertShape(type);
  if (s === 'line') return ['cross'];
  if (s === 'zone') return ['enter', 'exit', 'enter-exit'];
  if (s === 'channel') return ['cross', 'enter', 'exit', 'enter-exit'];
  return [];
}

export function alertTrigger(d: Drawing): AlertTrigger {
  const v = prop<string>(d, 'alertOn', '');
  const ok = triggersFor(d.type);
  if (ok.includes(v as AlertTrigger)) return v as AlertTrigger;
  return ok[0] ?? 'cross';
}

/** Price of the infinite line a→b at time t. */
export function priceOnSegment(a: Anchor, b: Anchor, t: number): number {
  if (b.t === a.t) return a.px;
  return a.px + ((b.px - a.px) * (t - a.t)) / (b.t - a.t);
}

interface Boundary {
  /** Boundary price at time t, or null where the boundary does not exist. */
  at(t: number): number | null;
}

function lineBoundary(a: Anchor, b: Anchor, left: boolean, right: boolean, off = 0): Boundary {
  const lo = Math.min(a.t, b.t);
  const hi = Math.max(a.t, b.t);
  return {
    at: (t) => {
      if (a.t === b.t) return null;
      if (t < lo && !left) return null;
      if (t > hi && !right) return null;
      return priceOnSegment(a, b, t) + off;
    },
  };
}

/** Boundaries (price lines) of a line / channel drawing. */
export function boundariesOf(d: Drawing): Boundary[] {
  const a = d.anchors[0];
  const b = d.anchors[1];
  if (!a) return [];
  switch (d.type) {
    case 'horizontal-line':
      return [{ at: () => a.px }];
    case 'horizontal-ray':
      return [{ at: (t) => (t >= a.t ? a.px : null) }];
    case 'trend-line':
      return b ? [lineBoundary(a, b, d.extendLeft, d.extendRight)] : [];
    case 'ray':
      return b ? [lineBoundary(a, b, d.extendLeft, true)] : [];
    case 'extended-line':
      return b ? [lineBoundary(a, b, true, true)] : [];
    case 'parallel-channel':
    case 'equidistant-channel': {
      const c = d.anchors[2];
      if (!b) return [];
      const off = c ? c.px - priceOnSegment(a, b, c.t) : 0;
      const f = d.type === 'parallel-channel' ? [0, 1] : [-1, 0, 1];
      return f.map((k) => lineBoundary(a, b, d.extendLeft, d.extendRight, off * k));
    }
    default:
      return [];
  }
}

/** Is the sample inside the zone (rectangle, or channel between its outer lines)? */
export function insideZone(d: Drawing, s: AlertSample): boolean {
  const shape = alertShape(d.type);
  if (shape === 'zone') {
    const [a, b] = d.anchors;
    if (!a || !b) return false;
    return (
      s.t >= Math.min(a.t, b.t) &&
      s.t <= Math.max(a.t, b.t) &&
      s.px >= Math.min(a.px, b.px) &&
      s.px <= Math.max(a.px, b.px)
    );
  }
  if (shape === 'channel') {
    const vals = boundariesOf(d)
      .map((bd) => bd.at(s.t))
      .filter((v): v is number => v !== null);
    if (vals.length < 2) return false;
    return s.px >= Math.min(...vals) && s.px <= Math.max(...vals);
  }
  return false;
}

/** Event for the move prev → cur, or null. */
export function detectAlert(d: Drawing, prev: AlertSample, cur: AlertSample): AlertEvent | null {
  const shape = alertShape(d.type);
  if (!shape) return null;
  const trig = alertTrigger(d);
  if (shape === 'line' || (shape === 'channel' && trig === 'cross')) {
    for (const bd of boundariesOf(d)) {
      const l0 = bd.at(prev.t);
      const l1 = bd.at(cur.t);
      if (l0 === null || l1 === null) continue;
      if (prev.px < l0 && cur.px >= l1) return { kind: 'cross-up', level: l1 };
      if (prev.px > l0 && cur.px <= l1) return { kind: 'cross-down', level: l1 };
    }
    return null;
  }
  const was = insideZone(d, prev);
  const now = insideZone(d, cur);
  if (was === now) return null;
  const kind = now ? 'enter' : 'exit';
  if (trig === 'enter' && kind !== 'enter') return null;
  if (trig === 'exit' && kind !== 'exit') return null;
  const [a, b] = d.anchors;
  let level = cur.px;
  if (shape === 'zone' && a && b) {
    const hi = Math.max(a.px, b.px);
    const lo = Math.min(a.px, b.px);
    // The edge nearest to the sample that moved across it.
    level = Math.abs(cur.px - hi) < Math.abs(cur.px - lo) ? hi : lo;
  }
  return { kind, level };
}

export function describeAlertEvent(e: AlertEvent, label: string): string {
  switch (e.kind) {
    case 'cross-up':
      return `crossed above ${label}`;
    case 'cross-down':
      return `crossed below ${label}`;
    case 'enter':
      return `entered ${label}`;
    default:
      return `exited ${label}`;
  }
}

/** Per-drawing alert delivery channels (default all on). */
export interface AlertChannels {
  toast: boolean;
  sound: boolean;
  log: boolean;
  once: boolean;
}

export function alertChannels(d: Drawing): AlertChannels {
  return {
    toast: prop(d, 'alertToast', true),
    sound: prop(d, 'alertSound', true),
    log: prop(d, 'alertLog', true),
    once: prop(d, 'alertOnce', true),
  };
}
