import type { VolumeProfile } from '@htflow/market-data';
import { cvdCorrelation, zigzag } from './swing';
import { angleDeg, dist, extendSegment, rectPts } from './geometry';
import {
  DEFAULT_STYLE,
  FIB_ARC_LEVELS,
  FIB_EXTENSION_LEVELS,
  FIB_FAN_LEVELS,
  FIB_RETRACEMENT_LEVELS,
  FIB_TIME_LEVELS,
  GANN_BOX_LEVELS,
  GANN_FAN_LEVELS,
  prop,
  type DrawingDefaults,
} from './model';
import type { Proj } from './proj';
import type { MarkerKind, PathShape, Shape, TextShape } from './shapes';
import {
  anchoredVwap,
  barRange,
  cached,
  dynamicPoc,
  positionStats,
  rangeProfile,
  rangeStats,
  regression,
  tpoProfile,
} from './stats';
import type { Anchor, Drawing, FibLevel, ToolGroup, ToolId } from './types';

export interface Handle {
  x: number;
  y: number;
  key: number;
}

/**
 * How a tool is created:
 * click — one click places it · two — click-click or drag · multi — n clicks ·
 * poly — clicks until double-click / Enter · free — press and drag (brush).
 */
export type CreateMode = 'click' | 'two' | 'multi' | 'poly' | 'free';

export interface ToolDef {
  id: ToolId;
  label: string;
  group: ToolGroup;
  shortcut?: string;
  mode: CreateMode;
  /** Anchors placed by the user (multi / two). */
  n: number;
  /** false = listed but not built yet. */
  ready: boolean;
  note?: string;
  /** Anchors are plot fractions (screen-fixed), not time/price. */
  screen?: boolean;
  /** Not a drawing: activating it runs an action (magnifier, remove indicators). */
  command?: boolean;
  defaults?: DrawingDefaults;
  /** Completes anchors after placement (e.g. positions add target/stop). */
  init?(d: Drawing, P: Proj): void;
  build(d: Drawing, P: Proj): Shape[];
  handles?(d: Drawing, P: Proj): Handle[];
  moveHandle?(d: Drawing, key: number, a: Anchor, P: Proj): void;
  /** Prices / times shown on the axes when "show labels" is on. */
  labels?(d: Drawing): { px: number[]; t: number[] };
}

// ---------------------------------------------------------------- helpers

const stroke = (d: Drawing): Pick<PathShape, 'stroke' | 'width' | 'dash' | 'alpha'> => ({
  stroke: d.style.color,
  width: d.style.width,
  dash: d.style.dash,
  alpha: d.style.opacity,
});

const fillOf = (d: Drawing): Pick<PathShape, 'fill' | 'fillAlpha'> =>
  d.style.fill ? { fill: d.style.fill, fillAlpha: d.style.fillOpacity } : {};

const xy = (P: Proj, a: Anchor | undefined): [number, number] =>
  a ? [P.x(a.t), P.y(a.px)] : [Number.NaN, Number.NaN];

const path = (d: Drawing, pts: number[], extra: Partial<PathShape> = {}): PathShape => ({
  k: 'path',
  pts,
  ...stroke(d),
  ...extra,
});

function text(
  x: number,
  y: number,
  t: string,
  color: string,
  extra: Partial<TextShape> = {},
): TextShape {
  return { k: 'text', x, y, text: t, size: 11, color, align: 'left', base: 'middle', ...extra };
}

/** Optional user text centred above a segment. */
function caption(d: Drawing, x: number, y: number): Shape[] {
  if (!d.style.text) return [];
  return [
    text(x, y - 6, d.style.text, d.style.color, {
      align: 'center',
      base: 'bottom',
      size: d.style.fontSize,
    }),
  ];
}

function lineThrough(d: Drawing, P: Proj, a: Anchor, b: Anchor, left: boolean, right: boolean) {
  const [x0, y0] = xy(P, a);
  const [x1, y1] = xy(P, b);
  const seg = extendSegment(x0, y0, x1, y1, P.plot, left, right);
  return seg ? [path(d, [...seg])] : [];
}

const fullWidth = (P: Proj) => [P.plot.x, P.plot.x + P.plot.w] as const;
const enabled = (levels: FibLevel[] | undefined) => (levels ?? []).filter((l) => l.enabled);
const levelColor = (d: Drawing, l: FibLevel) => l.color || d.style.color;
const fmtLevel = (v: number) => (Math.abs(v - Math.round(v)) < 1e-9 ? String(v) : v.toFixed(3));

/** Price on the line a→b at time t (interpolated in slot space). */
function priceOnLine(P: Proj, a: Anchor, b: Anchor, t: number): number {
  const sa = P.axis.slotOf(a.t);
  const sb = P.axis.slotOf(b.t);
  if (Math.abs(sb - sa) < 1e-9) return a.px;
  return a.px + ((b.px - a.px) * (P.axis.slotOf(t) - sa)) / (sb - sa);
}

function fmtDuration(ms: number): string {
  const a = Math.abs(ms);
  const s = Math.round(a / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h && (sec || !parts.length)) parts.push(`${sec}s`);
  return (ms < 0 ? '−' : '') + parts.join(' ');
}

const signed = (v: number, digits = 0) =>
  (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(digits);
const money = (v: number) =>
  (v < 0 ? '−' : '') +
  '$' +
  Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = (v: number) =>
  Math.abs(v) >= 1e6
    ? (v / 1e6).toFixed(2) + 'M'
    : Math.abs(v) >= 1e4
      ? (v / 1e3).toFixed(1) + 'K'
      : Number.isInteger(v)
        ? String(v)
        : v.toFixed(2);

/** Arc through three screen points sampled as a polyline. */
function arcThrough(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number[] {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-6) return [ax, ay, cx, cy];
  const ux =
    ((ax * ax + ay * ay) * (by - cy) +
      (bx * bx + by * by) * (cy - ay) +
      (cx * cx + cy * cy) * (ay - by)) /
    d;
  const uy =
    ((ax * ax + ay * ay) * (cx - bx) +
      (bx * bx + by * by) * (ax - cx) +
      (cx * cx + cy * cy) * (bx - ax)) /
    d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux);
  const a1 = Math.atan2(by - uy, bx - ux);
  const a2 = Math.atan2(cy - uy, cx - ux);
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // go from a0 to a2 in the direction that passes a1
  const ccwSpan = norm(a2 - a0);
  const ccwMid = norm(a1 - a0);
  const span = ccwMid <= ccwSpan ? ccwSpan : ccwSpan - 2 * Math.PI;
  const pts: number[] = [];
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (span * i) / steps;
    pts.push(ux + r * Math.cos(a), uy + r * Math.sin(a));
  }
  return pts;
}

function circlePts(cx: number, cy: number, r: number, from = 0, to = 2 * Math.PI, steps = 64) {
  const pts: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return pts;
}

// ---------------------------------------------------------------- volume profile rendering

function profileShapes(
  d: Drawing,
  P: Proj,
  prof: VolumeProfile,
  xLeft: number,
  maxW: number,
  label: boolean,
): Shape[] {
  const out: Shape[] = [];
  if (!(prof.total > 0)) return out;
  const rowTicks = Math.max(1, Math.ceil(2 / Math.max(1e-6, P.tickPx)));
  const buckets = new Map<number, number>();
  for (const [px, l] of prof.levels) {
    const b = Math.floor(px / rowTicks) * rowTicks;
    buckets.set(b, (buckets.get(b) ?? 0) + l.vol);
  }
  let max = 0;
  for (const v of buckets.values()) if (v > max) max = v;
  const pocB = Math.floor(prof.poc / rowTicks) * rowTicks;
  const col = d.style.color;
  for (const [b, v] of buckets) {
    const yTop = P.y(b + rowTicks - 0.5);
    const yBot = P.y(b - 0.5);
    const h = Math.max(1, yBot - yTop - (rowTicks * P.tickPx > 3 ? 1 : 0));
    const w = (v / max) * maxW;
    const inVa = b + rowTicks - 1 >= prof.val && b <= prof.vah;
    out.push({
      k: 'path',
      pts: rectPts(xLeft, yTop, xLeft + w, yTop + h),
      closed: true,
      fill: b === pocB ? '#FFFFFF' : col,
      fillAlpha: b === pocB ? 0.85 : inVa ? 0.45 : 0.18,
      hit: 'none',
    });
  }
  const right = xLeft + maxW;
  for (const [px, name, c] of [
    [prof.poc, 'POC', '#FFFFFF'],
    [prof.vah, 'VAH', col],
    [prof.val, 'VAL', col],
  ] as const) {
    const y = P.y(px);
    const x2 = d.extendRight ? P.plot.x + P.plot.w : right;
    out.push({
      k: 'path',
      pts: [xLeft, y, x2, y],
      stroke: c,
      width: name === 'POC' ? 1.5 : 1,
      dash: name === 'POC' ? 'solid' : 'dashed',
      alpha: 0.9,
      hit: 'none',
    });
    if (label)
      out.push(
        text(x2 + 4, y, `${name} ${P.fmtPrice(px)}`, c, { size: 10, alpha: 0.9, hit: false }),
      );
  }
  return out;
}

function profileOf(
  d: Drawing,
  P: Proj,
  i0: number,
  i1: number,
  lo?: number,
  hi?: number,
  cacheId = d.id,
) {
  const bars = P.bars!;
  const mode = prop<string>(d, 'mode', 'volume');
  const va = prop(d, 'va', 70) / 100;
  const key = `${i0}|${i1}|${lo}|${hi}|${mode}|${va}|${bars.length}`;
  return cached(cacheId, key, P.barsVersion, () =>
    mode === 'tpo'
      ? tpoProfile(bars, i0, i1, prop(d, 'tpoMin', 30) * 60_000, va, lo, hi)
      : rangeProfile(bars, i0, i1, va, lo, hi),
  );
}

const noData = (P: Proj, x: number, y: number): Shape =>
  text(x, y, 'No bar data on this chart', P.colors.textSecondary, { size: 10 });

// ---------------------------------------------------------------- tool builders

function fibRetracement(d: Drawing, P: Proj): Shape[] {
  const [a, b] = d.anchors as [Anchor, Anchor];
  const [x0, y0] = xy(P, a);
  const [x1, y1] = xy(P, b);
  const out: Shape[] = [path(d, [x0, y0, x1, y1], { dash: 'dashed', alpha: 0.5 })];
  const [L, R] = fullWidth(P);
  const xa = d.extendLeft ? L : Math.min(x0, x1);
  const xb = d.extendRight ? R : Math.max(x0, x1);
  const lv = enabled(d.levels);
  const prices = lv.map((l) => b.px - (b.px - a.px) * l.value);
  if (d.style.fill)
    for (let i = 0; i + 1 < lv.length; i++) {
      const ya = P.y(prices[i]!);
      const yb = P.y(prices[i + 1]!);
      out.push({
        k: 'path',
        pts: rectPts(xa, ya, xb, yb),
        closed: true,
        fill: levelColor(d, lv[i + 1]!),
        fillAlpha: d.style.fillOpacity,
        hit: 'none',
      });
    }
  lv.forEach((l, i) => {
    const y = P.y(prices[i]!);
    const c = levelColor(d, l);
    out.push({ ...path(d, [xa, y, xb, y]), stroke: c });
    out.push(
      text(xa + 4, y - 2, `${fmtLevel(l.value)} (${P.fmtPrice(prices[i]!)})`, c, {
        base: 'bottom',
        size: 10,
        hit: false,
      }),
    );
  });
  return out;
}

function fibExtension(d: Drawing, P: Proj): Shape[] {
  const [a, b, c] = d.anchors as [Anchor, Anchor, Anchor];
  const pa = xy(P, a);
  const pb = xy(P, b);
  const pc = xy(P, c ?? b);
  const out: Shape[] = [path(d, [...pa, ...pb, ...pc], { dash: 'dashed', alpha: 0.5 })];
  if (!c) return out;
  const [L, R] = fullWidth(P);
  const xa = d.extendLeft ? L : Math.min(pc[0], pb[0]);
  const xb = d.extendRight ? R : Math.max(pc[0] + Math.abs(pb[0] - pa[0]), pc[0] + 40);
  for (const l of enabled(d.levels)) {
    const px = c.px + (b.px - a.px) * l.value;
    const y = P.y(px);
    const col = levelColor(d, l);
    out.push({ ...path(d, [xa, y, xb, y]), stroke: col });
    out.push(
      text(xa + 4, y - 2, `${fmtLevel(l.value)} (${P.fmtPrice(px)})`, col, {
        base: 'bottom',
        size: 10,
        hit: false,
      }),
    );
  }
  return out;
}

function fibFan(d: Drawing, P: Proj): Shape[] {
  const [a, b] = d.anchors as [Anchor, Anchor];
  const [x0, y0] = xy(P, a);
  const [x1, y1] = xy(P, b);
  const out: Shape[] = [path(d, [x0, y0, x1, y1], { dash: 'dashed', alpha: 0.4, hit: 'none' })];
  for (const l of [{ value: 0, color: '', enabled: true }, ...enabled(d.levels)]) {
    const ty = y1 + (y0 - y1) * l.value;
    const seg = extendSegment(x0, y0, x1, ty, P.plot, false, true);
    const col = levelColor(d, l);
    if (seg) out.push({ ...path(d, [...seg]), stroke: col });
    if (l.value) out.push(text(x1 + 4, ty, fmtLevel(l.value), col, { size: 10, hit: false }));
  }
  return out;
}

function fibTimeZones(d: Drawing, P: Proj): Shape[] {
  const [a, b] = d.anchors as [Anchor, Anchor];
  const s0 = P.axis.slotOf(a.t);
  const s1 = P.axis.slotOf(b.t);
  const step = s1 - s0;
  const out: Shape[] = [];
  const top = P.plot.y;
  const bot = P.plot.y + P.plot.h;
  for (const l of enabled(d.levels)) {
    const x = P.xOfSlot(s0 + step * l.value);
    if (x < P.plot.x - 1 || x > P.plot.x + P.plot.w + 1) continue;
    const col = levelColor(d, l);
    out.push({ ...path(d, [x, top, x, bot]), stroke: col });
    out.push(text(x + 3, bot - 8, fmtLevel(l.value), col, { size: 10, hit: false }));
  }
  return out;
}

function fibArcs(d: Drawing, P: Proj, circles: boolean): Shape[] {
  const [a, b] = d.anchors as [Anchor, Anchor];
  const [x0, y0] = xy(P, a);
  const [x1, y1] = xy(P, b);
  const r = dist(x0, y0, x1, y1);
  const out: Shape[] = [path(d, [x0, y0, x1, y1], { dash: 'dashed', alpha: 0.5 })];
  for (const l of enabled(d.levels)) {
    const col = levelColor(d, l);
    if (circles) {
      out.push({
        k: 'ellipse',
        cx: x0,
        cy: y0,
        rx: r * l.value,
        ry: r * l.value,
        ...stroke(d),
        stroke: col,
      });
    } else {
      // half circles centred on the second point, opening towards the first
      const up = y0 < y1;
      const pts = circlePts(x1, y1, r * l.value, up ? Math.PI : 0, up ? 2 * Math.PI : Math.PI, 48);
      out.push({ ...path(d, pts), stroke: col });
    }
    out.push(text(x1 + r * l.value + 3, y1, fmtLevel(l.value), col, { size: 10, hit: false }));
  }
  return out;
}

function parallelLines(d: Drawing, P: Proj, factors: number[], mid: boolean): Shape[] {
  const [a, b, c] = d.anchors as [Anchor, Anchor, Anchor?];
  const off = c ? c.px - priceOnLine(P, a, b, c.t) : 0;
  const out: Shape[] = [];
  const segs: number[][] = [];
  for (const f of factors) {
    const seg = extendSegment(
      P.x(a.t),
      P.y(a.px + off * f),
      P.x(b.t),
      P.y(b.px + off * f),
      P.plot,
      d.extendLeft,
      d.extendRight,
    );
    if (seg) {
      segs.push(seg);
      out.push(path(d, [...seg]));
    }
  }
  if (d.style.fill && segs.length >= 2) {
    const s0 = segs[0]!;
    const s1 = segs[segs.length - 1]!;
    out.unshift({
      k: 'path',
      pts: [s0[0]!, s0[1]!, s0[2]!, s0[3]!, s1[2]!, s1[3]!, s1[0]!, s1[1]!],
      closed: true,
      fill: d.style.fill,
      fillAlpha: d.style.fillOpacity,
      hit: 'fill',
    });
  }
  if (mid) {
    const lo = Math.min(...factors);
    const hi = Math.max(...factors);
    const m = (lo + hi) / 2;
    if (!factors.includes(m)) {
      const seg = extendSegment(
        P.x(a.t),
        P.y(a.px + off * m),
        P.x(b.t),
        P.y(b.px + off * m),
        P.plot,
        d.extendLeft,
        d.extendRight,
      );
      if (seg) out.push(path(d, [...seg], { dash: 'dashed', alpha: d.style.opacity * 0.6 }));
    }
  }
  return out;
}

function pitchfork(d: Drawing, P: Proj, variant: 'std' | 'schiff' | 'mod'): Shape[] {
  const [a, b, c] = d.anchors as [Anchor, Anchor, Anchor?];
  let [x0, y0] = xy(P, a);
  const [x1, y1] = xy(P, b);
  if (!c) return [path(d, [x0, y0, x1, y1])];
  const [x2, y2] = xy(P, c);
  const out: Shape[] = [];
  if (variant === 'schiff') y0 = (y0 + y1) / 2;
  if (variant === 'mod') {
    x0 = (x0 + x1) / 2;
    y0 = (y0 + y1) / 2;
  }
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = mx - x0;
  const dy = my - y0;
  const handle = path(d, [...xy(P, a), x0, y0, x1, y1, x2, y2], {
    alpha: d.style.opacity * 0.5,
    dash: 'dashed',
  });
  out.push(handle);
  for (const [px, py, main] of [
    [x0, y0, true],
    [x1, y1, false],
    [x2, y2, false],
  ] as const) {
    const seg = extendSegment(px, py, px + dx, py + dy, P.plot, false, true);
    if (seg) out.push(path(d, [...seg], main ? {} : { alpha: d.style.opacity }));
  }
  return out;
}

const WAVE_LABELS: Partial<Record<ToolId, string[]>> = {
  'elliott-impulse': ['(0)', '(1)', '(2)', '(3)', '(4)', '(5)'],
  'elliott-correction': ['(0)', '(A)', '(B)', '(C)'],
  'elliott-triangle': ['(0)', '(A)', '(B)', '(C)', '(D)', '(E)'],
  'elliott-double': ['(0)', '(W)', '(X)', '(Y)'],
  'elliott-triple': ['(0)', '(W)', '(X)', '(Y)', '(X)', '(Z)'],
  abcd: ['A', 'B', 'C', 'D'],
  xabcd: ['X', 'A', 'B', 'C', 'D'],
  'triangle-pattern': ['A', 'B', 'C', 'D'],
  'head-shoulders': ['', 'LS', '', 'H', '', 'RS', ''],
};

function wave(d: Drawing, P: Proj): Shape[] {
  const labels = WAVE_LABELS[d.type] ?? [];
  const pts = d.anchors.flatMap((a) => xy(P, a));
  const out: Shape[] = [];
  const ratio = (i: number, j: number, k: number, l: number) => {
    const A = d.anchors;
    const den = Math.abs(A[j]!.px - A[i]!.px);
    return den ? Math.abs(A[l]!.px - A[k]!.px) / den : 0;
  };
  const dashed = (i: number, j: number, label?: string) => {
    if (i >= d.anchors.length || j >= d.anchors.length) return;
    const [ax, ay] = xy(P, d.anchors[i]);
    const [bx, by] = xy(P, d.anchors[j]);
    out.push(path(d, [ax, ay, bx, by], { dash: 'dashed', alpha: 0.5, hit: 'none' }));
    if (label)
      out.push(
        text((ax + bx) / 2, (ay + by) / 2, label, d.style.color, {
          align: 'center',
          size: 10,
          bg: '#000000',
          bgAlpha: 0.6,
          pad: 2,
          hit: false,
        }),
      );
  };
  if (d.type === 'xabcd' && d.anchors.length >= 3 && d.style.fill) {
    out.push({ k: 'path', pts: pts.slice(0, 6), closed: true, ...fillOf(d), hit: 'none' });
    if (d.anchors.length >= 5)
      out.push({ k: 'path', pts: pts.slice(4, 10), closed: true, ...fillOf(d), hit: 'none' });
  }
  if (d.type === 'head-shoulders' && d.anchors.length >= 5) {
    const [nx0, ny0] = xy(P, d.anchors[2]);
    const [nx1, ny1] = xy(P, d.anchors[4]);
    const seg = extendSegment(nx0, ny0, nx1, ny1, P.plot, true, true);
    if (seg) out.push(path(d, [...seg], { dash: 'dashed', alpha: 0.7, hit: 'none' }));
    if (d.style.fill)
      out.push({ k: 'path', pts: pts.slice(2, 10), closed: true, ...fillOf(d), hit: 'none' });
  }
  out.push(path(d, pts));
  if (d.type === 'abcd' && d.anchors.length >= 4) {
    dashed(0, 2, ratio(0, 1, 1, 2).toFixed(3));
    dashed(1, 3, ratio(1, 2, 2, 3).toFixed(3));
  }
  if (d.type === 'xabcd' && d.anchors.length >= 5) {
    dashed(0, 2, ratio(0, 1, 1, 2).toFixed(3));
    dashed(1, 3, ratio(1, 2, 2, 3).toFixed(3));
    dashed(2, 4, ratio(2, 3, 3, 4).toFixed(3));
    dashed(0, 4, ratio(0, 1, 1, 4).toFixed(3));
  }
  if (d.type === 'triangle-pattern' && d.anchors.length >= 4) {
    for (const [i, j] of [
      [0, 2],
      [1, 3],
    ] as const) {
      const [ax, ay] = xy(P, d.anchors[i]);
      const [bx, by] = xy(P, d.anchors[j]);
      const seg = extendSegment(ax, ay, bx, by, P.plot, false, true);
      if (seg) out.push(path(d, [...seg], { dash: 'dashed', alpha: 0.6, hit: 'none' }));
    }
  }
  d.anchors.forEach((a, i) => {
    const l = labels[i];
    if (!l) return;
    const prev = d.anchors[i - 1] ?? d.anchors[i + 1];
    const next = d.anchors[i + 1] ?? d.anchors[i - 1];
    const high = a.px >= (prev?.px ?? a.px) && a.px >= (next?.px ?? a.px);
    const [x, y] = xy(P, a);
    out.push(
      text(x, high ? y - 6 : y + 6, l, d.style.color, {
        align: 'center',
        base: high ? 'bottom' : 'top',
        size: Math.max(10, d.style.fontSize - 1),
        weight: 600,
        hit: false,
      }),
    );
  });
  return out;
}

function rangeBox(d: Drawing, P: Proj, kind: 'ruler' | 'measure' | 'date' | 'price'): Shape[] {
  const [a, b] = d.anchors as [Anchor, Anchor];
  const [x0, y0] = xy(P, a);
  const [x1, y1] = xy(P, b);
  const st = cached(
    d.id + ':stats',
    `${a.t}|${a.px}|${b.t}|${b.px}|${P.bars?.length ?? 0}`,
    P.barsVersion,
    () =>
      rangeStats(
        P.inst,
        { ...a, slot: P.axis.slotOf(a.t) },
        { ...b, slot: P.axis.slotOf(b.t) },
        P.bars,
      ),
  );
  const up = st.ticks >= 0;
  const col = kind === 'ruler' ? (up ? P.colors.up : P.colors.down) : d.style.color;
  const out: Shape[] = [];
  const xl = Math.min(x0, x1);
  const xr = Math.max(x0, x1);
  const yt = Math.min(y0, y1);
  const yb = Math.max(y0, y1);
  if (kind === 'date') {
    out.push({
      k: 'path',
      pts: rectPts(xl, yt, xr, yb),
      closed: true,
      fill: col,
      fillAlpha: 0.12,
      hit: 'fill',
    });
    out.push(path(d, [xl, yt, xl, yb]), path(d, [xr, yt, xr, yb]));
    const ym = (yt + yb) / 2;
    out.push(path(d, [x0, ym, x1, ym], { arrow: 1 }));
  } else if (kind === 'price') {
    out.push({
      k: 'path',
      pts: rectPts(xl, yt, xr, yb),
      closed: true,
      fill: col,
      fillAlpha: 0.12,
      hit: 'fill',
    });
    out.push(path(d, [xl, yt, xr, yt]), path(d, [xl, yb, xr, yb]));
    const xm = (xl + xr) / 2;
    out.push(path(d, [xm, y0, xm, y1], { arrow: 1 }));
  } else {
    out.push({
      k: 'path',
      pts: rectPts(xl, yt, xr, yb),
      closed: true,
      fill: col,
      fillAlpha: 0.14,
      hit: 'fill',
      stroke: col,
      width: 1,
      alpha: 0.6,
    });
    const xm = (xl + xr) / 2;
    const ym = (yt + yb) / 2;
    out.push({ k: 'path', pts: [xm, y0, xm, y1], stroke: col, width: 1, arrow: 1 });
    out.push({ k: 'path', pts: [x0, ym, x1, ym], stroke: col, width: 1, arrow: 1 });
  }
  const pv = (st.points >= 0 ? '+' : '−') + Math.abs(st.points).toFixed(P.inst.pricePrecision);
  const priceLine = `${signed(st.ticks)} ticks (${pv}) ${signed(st.pct, 2)}%`;
  const valueLine = `${money(st.value)} / contract`;
  const timeLine = `${st.bars} bars · ${fmtDuration(st.ms)}`;
  const volLine = `Vol ${compact(st.volume)} · Δ ${signed(st.delta, Number.isInteger(st.delta) ? 0 : 2)}`;
  const lines =
    kind === 'date'
      ? [timeLine, volLine]
      : kind === 'price'
        ? [priceLine, valueLine]
        : kind === 'measure'
          ? [priceLine, timeLine]
          : [priceLine, valueLine, timeLine, volLine];
  const below = !up || kind === 'date';
  out.push(
    text((xl + xr) / 2, below ? yb + 8 : yt - 8, lines.join('\n'), '#FFFFFF', {
      align: 'center',
      base: below ? 'top' : 'bottom',
      size: 11,
      bg: kind === 'ruler' ? col : '#1A1A1A',
      bgAlpha: kind === 'ruler' ? 0.85 : 0.92,
      pad: 6,
      hit: true,
    }),
  );
  return out;
}

const MARKER_OF: Partial<Record<ToolId, MarkerKind>> = {
  dot: 'dot',
  diamond: 'diamond',
  square: 'square',
  'arrow-up': 'arrow-up',
  'arrow-down': 'arrow-down',
  checkmark: 'checkmark',
  cross: 'cross',
  star: 'star',
  flag: 'flag',
  emoji: 'emoji',
};

function marker(d: Drawing, P: Proj): Shape[] {
  const [x, y] = xy(P, d.anchors[0]);
  const m = MARKER_OF[d.type]!;
  const size = prop(d, 'size', 14);
  const out: Shape[] = [
    {
      k: 'marker',
      m,
      x,
      y,
      size,
      color: d.style.color,
      alpha: d.style.opacity,
      text: m === 'emoji' ? prop(d, 'glyph', '⭐') : undefined,
    },
  ];
  if (d.style.text)
    out.push(
      text(
        x,
        d.type === 'arrow-down' ? y - size / 2 - 4 : y + size / 2 + 4,
        d.style.text,
        d.style.color,
        {
          align: 'center',
          base: d.type === 'arrow-down' ? 'bottom' : 'top',
          size: d.style.fontSize,
        },
      ),
    );
  return out;
}

function priceLabel(d: Drawing, P: Proj, side: 'left' | 'right'): Shape[] {
  const a = d.anchors[0]!;
  const [x, y] = xy(P, a);
  const t = (d.style.text ? d.style.text + '  ' : '') + P.fmtPrice(a.px);
  const w = P.measure(t, 11, 600) + 12;
  const h = 20;
  const tip = 8;
  const dir = side === 'right' ? 1 : -1;
  const xb = x + dir * tip;
  const xe = xb + dir * w;
  const pts = [x, y, xb, y - h / 2, xe, y - h / 2, xe, y + h / 2, xb, y + h / 2];
  return [
    {
      k: 'path',
      pts,
      closed: true,
      fill: d.style.color,
      fillAlpha: d.style.opacity,
      stroke: d.style.color,
      width: 1,
      hit: 'fill',
    },
    text((xb + xe) / 2, y, t, '#000000', { align: 'center', weight: 600, hit: false }),
  ];
}

function positionShapes(d: Drawing, P: Proj, side: 'long' | 'short'): Shape[] {
  const [e, tp, sl] = d.anchors as [Anchor, Anchor, Anchor];
  if (!tp || !sl) return [];
  const xe = P.x(e.t);
  const xr = P.x(tp.t);
  const ye = P.y(e.px);
  const yt = P.y(tp.px);
  const ys = P.y(sl.px);
  const st = positionStats(P.inst, side, e.px, tp.px, sl.px, prop(d, 'qty', 1), prop(d, 'risk', 0));
  const up = P.colors.up;
  const down = P.colors.down;
  const xl = Math.min(xe, xr);
  const xh = Math.max(xe, xr);
  const out: Shape[] = [
    {
      k: 'path',
      pts: rectPts(xl, ye, xh, yt),
      closed: true,
      fill: up,
      fillAlpha: 0.18,
      hit: 'fill',
    },
    {
      k: 'path',
      pts: rectPts(xl, ye, xh, ys),
      closed: true,
      fill: down,
      fillAlpha: 0.18,
      hit: 'fill',
    },
    { k: 'path', pts: [xl, ye, xh, ye], stroke: '#BDBDBD', width: 1 },
    { k: 'path', pts: [xl, yt, xh, yt], stroke: up, width: 1, alpha: 0.8, hit: 'none' },
    { k: 'path', pts: [xl, ys, xh, ys], stroke: down, width: 1, alpha: 0.8, hit: 'none' },
  ];
  const tv = (n: number) => (n * P.inst.tickSize).toFixed(P.inst.pricePrecision);
  const cx = (xl + xh) / 2;
  const tpAbove = yt < ys;
  out.push(
    text(
      cx,
      tpAbove ? yt - 4 : yt + 4,
      `Target: ${st.tpTicks} ticks (${tv(st.tpTicks)}) · ${money(st.profit)}`,
      '#FFFFFF',
      {
        align: 'center',
        base: tpAbove ? 'bottom' : 'top',
        size: 10,
        bg: up,
        bgAlpha: 0.85,
        pad: 3,
        hit: false,
      },
    ),
    text(
      cx,
      tpAbove ? ys + 4 : ys - 4,
      `Stop: ${st.slTicks} ticks (${tv(st.slTicks)}) · ${money(-st.loss)}`,
      '#FFFFFF',
      {
        align: 'center',
        base: tpAbove ? 'top' : 'bottom',
        size: 10,
        bg: down,
        bgAlpha: 0.85,
        pad: 3,
        hit: false,
      },
    ),
    text(
      cx,
      ye,
      `${side === 'long' ? 'Long' : 'Short'} ${st.qty} · R:R ${st.rr.toFixed(2)}`,
      '#FFFFFF',
      {
        align: 'center',
        size: 10,
        bg: '#1A1A1A',
        bgAlpha: 0.9,
        pad: 3,
        hit: false,
      },
    ),
  );
  return out;
}

function positionInit(side: 'long' | 'short') {
  return (d: Drawing, P: Proj) => {
    const e = d.anchors[0]!;
    const span = Math.max(8, Math.round((P.plot.h / Math.max(1e-6, P.tickPx)) * 0.06));
    const dir = side === 'long' ? 1 : -1;
    const t1 = P.axis.timeOf(P.axis.slotOf(e.t) + 24);
    d.anchors = [
      { t: e.t, px: e.px },
      { t: t1, px: e.px + dir * span * 2 },
      { t: t1, px: e.px - dir * span },
    ];
  };
}

// ---------------------------------------------------------------- registry

const rect2 = (d: Drawing, P: Proj): Shape[] => {
  const [x0, y0] = xy(P, d.anchors[0]);
  const [x1, y1] = xy(P, d.anchors[1]);
  const [L, R] = fullWidth(P);
  const xl = d.extendLeft ? L : Math.min(x0, x1);
  const xr = d.extendRight ? R : Math.max(x0, x1);
  return [
    {
      ...path(d, rectPts(xl, y0, xr, y1)),
      closed: true,
      ...fillOf(d),
      hit: d.style.fill ? 'fill' : 'stroke',
    },
    ...(d.style.text
      ? [
          text(Math.min(x0, x1) + 6, Math.min(y0, y1) + 6, d.style.text, d.style.color, {
            base: 'top',
            size: d.style.fontSize,
            hit: false,
          }),
        ]
      : []),
  ];
};

const pricesAndTimes = (d: Drawing) => ({
  px: d.anchors.map((a) => a.px),
  t: d.anchors.map((a) => a.t),
});
const pricesOnly = (d: Drawing) => ({ px: d.anchors.map((a) => a.px), t: [] });
const timesOnly = (d: Drawing) => ({ px: [], t: d.anchors.map((a) => a.t) });

const markerTool = (id: ToolId, label: string, shortcut?: string, color = '#4FA3F7'): ToolDef => ({
  id,
  label,
  group: 'markers',
  shortcut,
  mode: 'click',
  n: 1,
  ready: true,
  defaults: { style: { color }, props: { size: 14 } },
  build: marker,
  labels: pricesOnly,
});

const waveTool = (id: ToolId, label: string, n: number, group: ToolGroup = 'elliott'): ToolDef => ({
  id,
  label,
  group,
  mode: 'multi',
  n,
  ready: true,
  defaults: {
    style: id === 'xabcd' || id === 'head-shoulders' ? { fill: '#4FA3F7', fillOpacity: 0.1 } : {},
  },
  build: wave,
});

export const TOOLS: ToolDef[] = [
  // ---------------------------------------------------------- lines
  {
    id: 'trend-line',
    label: 'Trend Line',
    group: 'lines',
    shortcut: 'F2',
    mode: 'two',
    n: 2,
    ready: true,
    build: (d, P) => {
      const [a, b] = d.anchors as [Anchor, Anchor];
      const [x0, y0] = xy(P, a);
      const [x1, y1] = xy(P, b);
      return [
        ...lineThrough(d, P, a, b, d.extendLeft, d.extendRight),
        ...caption(d, (x0 + x1) / 2, (y0 + y1) / 2),
      ];
    },
  },
  {
    id: 'trend-angle',
    label: 'Trend Angle',
    group: 'lines',
    mode: 'two',
    n: 2,
    ready: true,
    build: (d, P) => {
      const [a, b] = d.anchors as [Anchor, Anchor];
      const [x0, y0] = xy(P, a);
      const [x1, y1] = xy(P, b);
      const ang = angleDeg(x0, y0, x1, y1);
      const r = Math.max(30, Math.min(80, dist(x0, y0, x1, y1) / 2));
      const dir = x1 >= x0 ? 1 : -1;
      const a0 = dir > 0 ? 0 : Math.PI;
      const a1 = Math.atan2(y1 - y0, x1 - x0);
      const arc: number[] = [];
      for (let i = 0; i <= 24; i++) {
        let delta = a1 - a0;
        if (delta > Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        const t = a0 + (delta * i) / 24;
        arc.push(x0 + r * Math.cos(t), y0 + r * Math.sin(t));
      }
      return [
        ...lineThrough(d, P, a, b, d.extendLeft, d.extendRight),
        path(d, [x0, y0, x0 + dir * (r + 20), y0], { dash: 'dotted', alpha: 0.6, hit: 'none' }),
        path(d, arc, { alpha: 0.7, hit: 'none', dash: 'solid', width: 1 }),
        text(x0 + dir * (r + 24), y0 + (y1 < y0 ? -8 : 8), `${ang.toFixed(1)}°`, d.style.color, {
          align: dir > 0 ? 'left' : 'right',
          size: 11,
          weight: 600,
          hit: false,
        }),
      ];
    },
  },
  {
    id: 'vertical-line',
    label: 'Vertical Line',
    group: 'lines',
    shortcut: 'F7',
    mode: 'click',
    n: 1,
    ready: true,
    defaults: { showLabels: true },
    build: (d, P) => {
      const x = P.x(d.anchors[0]!.t);
      return [
        path(d, [x, P.plot.y, x, P.plot.y + P.plot.h]),
        ...(d.style.text
          ? [text(x + 4, P.plot.y + 16, d.style.text, d.style.color, { size: d.style.fontSize })]
          : []),
      ];
    },
    handles: (d, P) => [{ x: P.x(d.anchors[0]!.t), y: P.plot.y + P.plot.h / 2, key: 0 }],
    labels: timesOnly,
  },
  {
    id: 'horizontal-line',
    label: 'Horizontal Line',
    group: 'lines',
    shortcut: 'F6',
    mode: 'click',
    n: 1,
    ready: true,
    defaults: { showLabels: true },
    build: (d, P) => {
      const y = P.y(d.anchors[0]!.px);
      const [L, R] = fullWidth(P);
      return [
        path(d, [L, y, R, y]),
        ...(d.style.text
          ? [
              text(L + 8, y - 4, d.style.text, d.style.color, {
                base: 'bottom',
                size: d.style.fontSize,
              }),
            ]
          : []),
      ];
    },
    handles: (d, P) => [
      {
        x: Math.min(P.plot.x + P.plot.w - 24, Math.max(P.plot.x + 24, P.x(d.anchors[0]!.t))),
        y: P.y(d.anchors[0]!.px),
        key: 0,
      },
    ],
    labels: pricesOnly,
  },
  {
    id: 'horizontal-ray',
    label: 'Horizontal Ray',
    group: 'lines',
    mode: 'click',
    n: 1,
    ready: true,
    defaults: { showLabels: true },
    build: (d, P) => {
      const [x, y] = xy(P, d.anchors[0]);
      return [
        path(d, [Math.max(P.plot.x, x), y, P.plot.x + P.plot.w, y]),
        ...caption(d, x + 60, y),
      ];
    },
    labels: pricesOnly,
  },
  {
    id: 'ray',
    label: 'Ray',
    group: 'lines',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { extendRight: true },
    build: (d, P) => lineThrough(d, P, d.anchors[0]!, d.anchors[1]!, d.extendLeft, true),
  },
  {
    id: 'extended-line',
    label: 'Extended Line',
    group: 'lines',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { extendLeft: true, extendRight: true },
    build: (d, P) => lineThrough(d, P, d.anchors[0]!, d.anchors[1]!, true, true),
  },
  {
    id: 'cross-line',
    label: 'Cross Line',
    group: 'lines',
    mode: 'click',
    n: 1,
    ready: true,
    defaults: { showLabels: true },
    build: (d, P) => {
      const [x, y] = xy(P, d.anchors[0]);
      const [L, R] = fullWidth(P);
      return [path(d, [L, y, R, y]), path(d, [x, P.plot.y, x, P.plot.y + P.plot.h])];
    },
    labels: pricesAndTimes,
  },
  {
    id: 'brush',
    label: 'Brush',
    group: 'lines',
    mode: 'free',
    n: 0,
    ready: true,
    defaults: { style: { width: 2 } },
    build: (d, P) => [
      path(
        d,
        d.anchors.flatMap((a) => xy(P, a)),
      ),
    ],
    handles: () => [],
  },
  {
    id: 'arrow',
    label: 'Arrow',
    group: 'lines',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { style: { width: 2 } },
    build: (d, P) => [path(d, [...xy(P, d.anchors[0]), ...xy(P, d.anchors[1])], { arrow: 1 })],
  },
  {
    id: 'polyline',
    label: 'Polyline',
    group: 'lines',
    mode: 'poly',
    n: 0,
    ready: true,
    note: 'Click points; double-click or Enter to finish',
    build: (d, P) => [
      {
        ...path(
          d,
          d.anchors.flatMap((a) => xy(P, a)),
        ),
        closed: prop(d, 'closed', false),
        ...(prop(d, 'closed', false) ? fillOf(d) : {}),
      },
    ],
  },
  // ---------------------------------------------------------- shapes
  {
    id: 'rectangle',
    label: 'Rectangle',
    group: 'shapes',
    shortcut: 'F12',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { style: { fill: '#4FA3F7', fillOpacity: 0.15 } },
    build: rect2,
    handles: (d, P) => {
      const [x0, y0] = xy(P, d.anchors[0]);
      const [x1, y1] = xy(P, d.anchors[1]);
      return [
        { x: x0, y: y0, key: 0 },
        { x: x1, y: y1, key: 1 },
        { x: x1, y: y0, key: 2 },
        { x: x0, y: y1, key: 3 },
      ];
    },
    moveHandle: (d, key, a) => {
      const [p0, p1] = d.anchors as [Anchor, Anchor];
      if (key === 0) d.anchors = [a, p1];
      else if (key === 1) d.anchors = [p0, a];
      else if (key === 2)
        d.anchors = [
          { t: p0.t, px: a.px },
          { t: a.t, px: p1.px },
        ];
      else
        d.anchors = [
          { t: a.t, px: p0.px },
          { t: p1.t, px: a.px },
        ];
    },
  },
  {
    id: 'triangle',
    label: 'Triangle',
    group: 'shapes',
    shortcut: 'F11',
    mode: 'multi',
    n: 3,
    ready: true,
    defaults: { style: { fill: '#4FA3F7', fillOpacity: 0.15 } },
    build: (d, P) => [
      {
        ...path(
          d,
          d.anchors.flatMap((a) => xy(P, a)),
        ),
        closed: true,
        ...fillOf(d),
        hit: d.style.fill ? 'fill' : 'stroke',
      },
    ],
  },
  {
    id: 'ellipse',
    label: 'Ellipse',
    group: 'shapes',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { style: { fill: '#4FA3F7', fillOpacity: 0.15 } },
    build: (d, P) => {
      const [x0, y0] = xy(P, d.anchors[0]);
      const [x1, y1] = xy(P, d.anchors[1]);
      return [
        {
          k: 'ellipse',
          cx: (x0 + x1) / 2,
          cy: (y0 + y1) / 2,
          rx: Math.abs(x1 - x0) / 2,
          ry: Math.abs(y1 - y0) / 2,
          ...stroke(d),
          ...fillOf(d),
          hit: d.style.fill ? 'fill' : 'stroke',
        },
      ];
    },
  },
  {
    id: 'circle',
    label: 'Circle',
    group: 'shapes',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { style: { fill: '#4FA3F7', fillOpacity: 0.15 } },
    build: (d, P) => {
      const [x0, y0] = xy(P, d.anchors[0]);
      const [x1, y1] = xy(P, d.anchors[1]);
      const r = dist(x0, y0, x1, y1);
      return [
        {
          k: 'ellipse',
          cx: x0,
          cy: y0,
          rx: r,
          ry: r,
          ...stroke(d),
          ...fillOf(d),
          hit: d.style.fill ? 'fill' : 'stroke',
        },
      ];
    },
  },
  {
    id: 'arc',
    label: 'Arc',
    group: 'shapes',
    mode: 'multi',
    n: 3,
    ready: true,
    build: (d, P) => {
      const [ax, ay] = xy(P, d.anchors[0]);
      const [bx, by] = xy(P, d.anchors[1]);
      const c = d.anchors[2];
      if (!c) return [path(d, [ax, ay, bx, by])];
      const [cx, cy] = xy(P, c);
      // the user clicks start, end, then a point the arc passes through
      return [path(d, arcThrough(ax, ay, cx, cy, bx, by))];
    },
  },
  {
    id: 'highlight-y',
    label: 'Highlight Y (price band)',
    group: 'shapes',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { style: { fill: '#4FA3F7', fillOpacity: 0.12, opacity: 0.6 }, showLabels: true },
    build: (d, P) => {
      const y0 = P.y(d.anchors[0]!.px);
      const y1 = P.y(d.anchors[1]!.px);
      const [L, R] = fullWidth(P);
      return [
        {
          k: 'path',
          pts: rectPts(L, y0, R, y1),
          closed: true,
          fill: d.style.fill || d.style.color,
          fillAlpha: d.style.fillOpacity,
          hit: 'fill',
        },
        path(d, [L, y0, R, y0], { hit: 'none' }),
        path(d, [L, y1, R, y1], { hit: 'none' }),
      ];
    },
    handles: (d, P) =>
      d.anchors.map((a, key) => ({ x: P.plot.x + P.plot.w / 2, y: P.y(a.px), key })),
    labels: pricesOnly,
  },
  {
    id: 'highlight-x',
    label: 'Highlight X (time band)',
    group: 'shapes',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { style: { fill: '#4FA3F7', fillOpacity: 0.12, opacity: 0.6 }, showLabels: true },
    build: (d, P) => {
      const x0 = P.x(d.anchors[0]!.t);
      const x1 = P.x(d.anchors[1]!.t);
      const T = P.plot.y;
      const B = P.plot.y + P.plot.h;
      return [
        {
          k: 'path',
          pts: rectPts(x0, T, x1, B),
          closed: true,
          fill: d.style.fill || d.style.color,
          fillAlpha: d.style.fillOpacity,
          hit: 'fill',
        },
        path(d, [x0, T, x0, B], { hit: 'none' }),
        path(d, [x1, T, x1, B], { hit: 'none' }),
      ];
    },
    handles: (d, P) =>
      d.anchors.map((a, key) => ({ x: P.x(a.t), y: P.plot.y + P.plot.h / 2, key })),
    labels: timesOnly,
  },
  // ---------------------------------------------------------- channels & regression
  {
    id: 'parallel-channel',
    label: 'Parallel Channel',
    group: 'channels',
    mode: 'multi',
    n: 3,
    ready: true,
    note: 'Two clicks for the base line, a third for the width',
    defaults: { style: { fill: '#4FA3F7', fillOpacity: 0.1 } },
    build: (d, P) => parallelLines(d, P, [0, 1], true),
  },
  {
    id: 'regression-channel',
    label: 'Linear Regression Channel',
    group: 'channels',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { style: { fill: '#4FA3F7', fillOpacity: 0.08 }, props: { sigma: 2 } },
    build: (d, P) => {
      const [a, b] = d.anchors as [Anchor, Anchor];
      if (!P.bars)
        return [...lineThrough(d, P, a, b, false, false), noData(P, P.x(a.t), P.y(a.px))];
      const { i0, i1 } = barRange(P.bars, a.t, b.t);
      const r = regression(P.bars, i0, i1);
      if (!r) return lineThrough(d, P, a, b, false, false);
      const k = prop(d, 'sigma', 2);
      const xs = P.xOfSlot(i0);
      const xe = P.xOfSlot(i1);
      const n = i1 - i0;
      const out: Shape[] = [];
      const lines: number[][] = [];
      const k2 = prop(d, 'sigma2', 0);
      const inner = k2 > 0 && k2 < k ? [k2, -k2] : [];
      const fs = [k, ...inner.slice(0, 1), 0, ...inner.slice(1), -k];
      for (const f of fs) {
        const seg = extendSegment(
          xs,
          P.y(r.a + f * r.sd),
          xe,
          P.y(r.a + r.b * n + f * r.sd),
          P.plot,
          d.extendLeft,
          d.extendRight,
        );
        if (!seg) continue;
        lines.push(seg);
        out.push(
          path(
            d,
            [...seg],
            f === 0
              ? { dash: 'dashed' }
              : Math.abs(f) < k
                ? { dash: 'dotted', alpha: d.style.opacity * 0.7 }
                : {},
          ),
        );
      }
      if (d.style.fill && lines.length === fs.length) {
        const u = lines[0]!;
        const l = lines[lines.length - 1]!;
        out.unshift({
          k: 'path',
          pts: [u[0]!, u[1]!, u[2]!, u[3]!, l[2]!, l[3]!, l[0]!, l[1]!],
          closed: true,
          ...fillOf(d),
          hit: 'fill',
        });
      }
      return out;
    },
  },
  {
    id: 'equidistant-channel',
    label: 'Equidistant Channel',
    group: 'channels',
    mode: 'multi',
    n: 3,
    ready: true,
    note: 'Base line in the middle, third click sets the distance',
    defaults: { style: { fill: '#4FA3F7', fillOpacity: 0.08 } },
    build: (d, P) => parallelLines(d, P, [-1, 0, 1], false),
  },
  // ---------------------------------------------------------- volume analysis
  {
    id: 'volume-profile',
    label: 'Volume Profile & TPO',
    group: 'volume',
    shortcut: 'F3',
    mode: 'two',
    n: 2,
    ready: true,
    note: 'Profile of the time × price box you draw',
    defaults: { style: { color: '#8C8C8C' }, props: { va: 70, mode: 'volume', width: 70 } },
    build: (d, P) => {
      const [a, b] = d.anchors as [Anchor, Anchor];
      const [x0, y0] = xy(P, a);
      const [x1, y1] = xy(P, b);
      const xl = Math.min(x0, x1);
      const out: Shape[] = [
        {
          k: 'path',
          pts: rectPts(xl, y0, Math.max(x0, x1), y1),
          closed: true,
          stroke: d.style.color,
          width: 1,
          dash: 'dashed',
          alpha: 0.5,
          hit: 'stroke',
        },
      ];
      if (!P.bars) return [...out, noData(P, xl + 4, Math.min(y0, y1) + 10)];
      const { i0, i1 } = barRange(P.bars, a.t, b.t);
      const lo = Math.round(Math.min(a.px, b.px));
      const hi = Math.round(Math.max(a.px, b.px));
      const prof = profileOf(d, P, i0, i1, lo, hi);
      out.push(
        ...profileShapes(
          d,
          P,
          prof,
          xl,
          (Math.abs(x1 - x0) * prop(d, 'width', 70)) / 100,
          d.showLabels,
        ),
      );
      out.push({
        k: 'path',
        pts: rectPts(xl, y0, Math.max(x0, x1), y1),
        closed: true,
        hit: 'fill',
        fill: '#000000',
        fillAlpha: 0,
      });
      return out;
    },
  },
  {
    id: 'fixed-vp',
    label: 'Fixed Volume Profile & TPO',
    group: 'volume',
    shortcut: 'Ctrl+F3',
    mode: 'two',
    n: 2,
    ready: true,
    note: 'Profile of every price traded between two times',
    defaults: {
      style: { color: '#8C8C8C' },
      showLabels: true,
      props: { va: 70, mode: 'volume', width: 70 },
    },
    build: (d, P) => {
      const [a, b] = d.anchors as [Anchor, Anchor];
      const x0 = P.x(Math.min(a.t, b.t));
      const x1 = P.x(Math.max(a.t, b.t));
      const out: Shape[] = [];
      if (!P.bars) return [noData(P, x0 + 4, P.y(a.px))];
      const { i0, i1 } = barRange(P.bars, a.t, b.t);
      const prof = profileOf(d, P, i0, i1);
      if (!(prof.total > 0)) return [path(d, [x0, P.y(a.px), x1, P.y(a.px)], { dash: 'dashed' })];
      const yt = P.y(prof.high + 0.5);
      const yb = P.y(prof.low - 0.5);
      out.push({
        k: 'path',
        pts: rectPts(x0, yt, x1, yb),
        closed: true,
        stroke: d.style.color,
        width: 1,
        dash: 'dotted',
        alpha: 0.4,
        fill: '#000000',
        fillAlpha: 0,
        hit: 'fill',
      });
      out.push(
        ...profileShapes(d, P, prof, x0, ((x1 - x0) * prop(d, 'width', 70)) / 100, d.showLabels),
      );
      return out;
    },
    labels: () => ({ px: [], t: [] }),
  },
  {
    id: 'anchored-vp',
    label: 'Anchored Volume Profile & TPO',
    group: 'volume',
    mode: 'click',
    n: 1,
    ready: true,
    note: 'From the anchor bar to the latest bar',
    defaults: {
      style: { color: '#8C8C8C' },
      showLabels: true,
      props: { va: 70, mode: 'volume', width: 70 },
    },
    build: (d, P) => {
      const a = d.anchors[0]!;
      const x0 = P.x(a.t);
      if (!P.bars) return [noData(P, x0 + 4, P.y(a.px))];
      const i0 = Math.max(0, P.axis.indexAt(a.t));
      const i1 = P.bars.length - 1;
      const prof = profileOf(d, P, i0, i1);
      const x1 = Math.max(x0 + 40, P.xOfSlot(i1 + 0.5));
      const out: Shape[] = [
        path(d, [x0, P.plot.y, x0, P.plot.y + P.plot.h], {
          dash: 'dotted',
          alpha: 0.5,
          hit: 'stroke',
        }),
      ];
      if (prof.total > 0) {
        out.push({
          k: 'path',
          pts: rectPts(x0, P.y(prof.high + 0.5), x1, P.y(prof.low - 0.5)),
          closed: true,
          fill: '#000000',
          fillAlpha: 0,
          hit: 'fill',
        });
        out.push(
          ...profileShapes(d, P, prof, x0, ((x1 - x0) * prop(d, 'width', 70)) / 100, d.showLabels),
        );
      }
      return out;
    },
    handles: (d, P) => [{ x: P.x(d.anchors[0]!.t), y: P.y(d.anchors[0]!.px), key: 0 }],
    labels: timesOnly,
  },
  {
    id: 'zigzag-vp',
    label: 'ZigZag Volume Profile & TPO',
    group: 'volume',
    mode: 'two',
    n: 2,
    ready: true,
    note: 'ZigZag swings between two times, with a volume profile for every leg',
    defaults: {
      style: { color: '#8C8C8C' },
      props: {
        va: 70,
        mode: 'volume',
        width: 80,
        reversal: 20,
        showZigzag: true,
        legLabels: false,
      },
    },
    build: (d, P) => {
      const [a, b] = d.anchors as [Anchor, Anchor];
      const x0 = P.x(Math.min(a.t, b.t));
      if (!P.bars) return [noData(P, x0 + 4, P.y(a.px))];
      const bars = P.bars;
      const { i0, i1 } = barRange(bars, a.t, b.t);
      const rev = Math.max(1, prop(d, 'reversal', 20));
      const swings = cached(d.id + ':zz', `${i0}|${i1}|${rev}|${bars.length}`, P.barsVersion, () =>
        zigzag(bars, i0, i1, rev),
      );
      const out: Shape[] = [];
      if (swings.length < 2) {
        out.push(
          path(d, [x0, P.y(a.px), P.x(Math.max(a.t, b.t)), P.y(a.px)], { dash: 'dashed' }),
          text(x0 + 4, P.y(a.px) - 8, 'No swings: lower the reversal', P.colors.textSecondary, {
            size: 10,
            hit: false,
          }),
        );
        return out;
      }
      if (prop(d, 'showZigzag', true))
        out.push(
          path(
            d,
            swings.flatMap((s) => [P.xOfSlot(s.i), P.y(s.px)]),
            { width: Math.max(1, d.style.width), alpha: d.style.opacity },
          ),
        );
      for (let k = 0; k + 1 < swings.length; k++) {
        const s0 = swings[k]!;
        const s1 = swings[k + 1]!;
        const lo = Math.min(s0.px, s1.px);
        const hi = Math.max(s0.px, s1.px);
        const prof = profileOf(d, P, s0.i, s1.i, lo, hi, `${d.id}:${k}`);
        if (!(prof.total > 0)) continue;
        const xa = P.xOfSlot(s0.i);
        const xb = P.xOfSlot(s1.i);
        out.push(...profileShapes(d, P, prof, xa, ((xb - xa) * prop(d, 'width', 80)) / 100, false));
        if (prop(d, 'legLabels', false))
          out.push(
            text(
              xb,
              P.y(s1.px) + (s1.dir === 1 ? -8 : 8),
              `${Math.round(Math.abs(s1.px - s0.px))}t`,
              d.style.color,
              {
                size: 10,
                align: 'center',
                hit: false,
              },
            ),
          );
      }
      return out;
    },
    labels: () => ({ px: [], t: [] }),
  },
  {
    id: 'anchored-vwap',
    label: 'Anchored VWAP',
    group: 'volume',
    shortcut: 'F4',
    mode: 'click',
    n: 1,
    ready: true,
    defaults: { style: { color: '#E8B04B', width: 2 }, props: { band1: 1, band2: 2 } },
    build: (d, P) => {
      const a = d.anchors[0]!;
      if (!P.bars) return [noData(P, P.x(a.t) + 4, P.y(a.px))];
      const bars = P.bars;
      const i0 = Math.max(0, P.axis.indexAt(a.t));
      const pts = cached(d.id, `${i0}|${bars.length}`, P.barsVersion, () => anchoredVwap(bars, i0));
      const out: Shape[] = [];
      for (const k of [prop(d, 'band2', 2), prop(d, 'band1', 1)]) {
        if (!(k > 0)) continue;
        for (const s of [1, -1]) {
          out.push(
            path(
              d,
              pts.flatMap((p) => [P.xOfSlot(p.i), P.y(p.vwap + s * k * p.sd)]),
              {
                width: 1,
                dash: 'dashed',
                alpha: d.style.opacity * 0.6,
                hit: 'none',
              },
            ),
          );
        }
      }
      out.push(
        path(
          d,
          pts.flatMap((p) => [P.xOfSlot(p.i), P.y(p.vwap)]),
        ),
      );
      const last = pts[pts.length - 1];
      if (last)
        out.push(
          text(P.xOfSlot(last.i) + 6, P.y(last.vwap), 'AVWAP', d.style.color, {
            size: 10,
            hit: false,
          }),
        );
      return out;
    },
    handles: (d, P) => {
      const a = d.anchors[0]!;
      return [{ x: P.x(a.t), y: P.y(a.px), key: 0 }];
    },
    labels: () => ({ px: [], t: [] }),
  },
  {
    id: 'dynamic-poc',
    label: 'Dynamic POC',
    group: 'volume',
    mode: 'click',
    n: 1,
    ready: true,
    note: 'Developing POC from the anchor bar',
    defaults: { style: { color: '#FFFFFF', width: 2 } },
    build: (d, P) => {
      const a = d.anchors[0]!;
      if (!P.bars) return [noData(P, P.x(a.t) + 4, P.y(a.px))];
      const bars = P.bars;
      const i0 = Math.max(0, P.axis.indexAt(a.t));
      const pts = cached(d.id, `${i0}|${bars.length}`, P.barsVersion, () => dynamicPoc(bars, i0));
      const line: number[] = [];
      for (const p of pts) {
        const y = P.y(p.poc);
        line.push(P.xOfSlot(p.i - 0.5), y, P.xOfSlot(p.i + 0.5), y);
      }
      return [path(d, line)];
    },
    handles: (d, P) => [{ x: P.x(d.anchors[0]!.t), y: P.y(d.anchors[0]!.px), key: 0 }],
    labels: () => ({ px: [], t: [] }),
  },
  {
    id: 'cvd-correlation',
    label: 'CVD correlation',
    group: 'volume',
    mode: 'two',
    n: 2,
    ready: true,
    note: 'Correlation of price and cumulative delta over the range; flags divergence',
    defaults: {
      style: { color: '#B07CF0', fill: '#B07CF0', fillOpacity: 0.06 },
      showLabels: false,
      props: { showCvd: true, divergenceAlert: true, corrWarn: 0.3 },
    },
    build: (d, P) => {
      const [a, b] = d.anchors as [Anchor, Anchor];
      const x0 = P.x(Math.min(a.t, b.t));
      const x1 = P.x(Math.max(a.t, b.t));
      if (!P.bars) return [noData(P, x0 + 4, P.y(a.px))];
      const bars = P.bars;
      const { i0, i1 } = barRange(bars, a.t, b.t);
      const r = cached(d.id, `${i0}|${i1}|${bars.length}`, P.barsVersion, () =>
        cvdCorrelation(bars, i0, i1),
      );
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = Math.max(0, i0); i <= Math.min(bars.length - 1, i1); i++) {
        hi = Math.max(hi, bars[i]!.h);
        lo = Math.min(lo, bars[i]!.l);
      }
      if (!(hi > lo)) return [path(d, [x0, P.y(a.px), x1, P.y(a.px)], { dash: 'dashed' })];
      const yt = P.y(hi);
      const yb = P.y(lo);
      const out: Shape[] = [
        {
          k: 'path',
          pts: rectPts(x0, yt, x1, yb),
          closed: true,
          ...stroke(d),
          dash: 'dotted',
          ...fillOf(d),
          hit: 'fill',
        },
      ];
      if (prop(d, 'showCvd', true) && r.cvd.length > 1) {
        const mn = Math.min(...r.cvd);
        const mx = Math.max(...r.cvd);
        const span = mx - mn || 1;
        const lo0 = Math.max(0, Math.min(i0, i1));
        out.push(
          path(
            d,
            r.cvd.flatMap((v, k) => [P.xOfSlot(lo0 + k), yb - ((v - mn) / span) * (yb - yt)]),
            { width: Math.max(1.5, d.style.width), hit: 'none' },
          ),
        );
      }
      const warn = prop(d, 'corrWarn', 0.3);
      const div = r.divergence !== 'none' || (r.corr !== null && r.corr < warn);
      const tag =
        r.divergence === 'bullish'
          ? 'bullish divergence'
          : r.divergence === 'bearish'
            ? 'bearish divergence'
            : r.corr !== null && r.corr < warn
              ? 'weak correlation'
              : 'in sync';
      out.push(
        text(
          x0 + 6,
          yt + 10,
          `CVD corr ${r.corr === null ? 'n/a' : r.corr.toFixed(2)} · price ${r.priceChange >= 0 ? '+' : ''}${Math.round(r.priceChange)}t · CVD ${r.cvdChange >= 0 ? '+' : ''}${Math.round(r.cvdChange)} · ${tag}`,
          div
            ? r.divergence === 'bullish'
              ? P.colors.up
              : r.divergence === 'bearish'
                ? P.colors.down
                : P.colors.warning
            : d.style.color,
          { size: Math.max(9, d.style.fontSize - 2), hit: false },
        ),
      );
      return out;
    },
    labels: () => ({ px: [], t: [] }),
  },
  // ---------------------------------------------------------- fibonacci
  {
    id: 'fib-retracement',
    label: 'Fibonacci Retracements',
    group: 'fib',
    shortcut: 'F8',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { levels: FIB_RETRACEMENT_LEVELS, style: { fillOpacity: 0.06 } },
    build: fibRetracement,
  },
  {
    id: 'fib-extension',
    label: 'Fibonacci Extensions',
    group: 'fib',
    mode: 'multi',
    n: 3,
    ready: true,
    note: 'Three points: A, B and the projection start C',
    defaults: { levels: FIB_EXTENSION_LEVELS },
    build: fibExtension,
  },
  {
    id: 'fib-fan',
    label: 'Fibo Fan',
    group: 'fib',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { levels: FIB_FAN_LEVELS },
    build: fibFan,
  },
  {
    id: 'fib-time-zones',
    label: 'Fibo Time Zones',
    group: 'fib',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { levels: FIB_TIME_LEVELS },
    build: fibTimeZones,
    labels: timesOnly,
  },
  {
    id: 'fib-arcs',
    label: 'Fibo Arcs',
    group: 'fib',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { levels: FIB_ARC_LEVELS },
    build: (d, P) => fibArcs(d, P, false),
  },
  {
    id: 'fib-circles',
    label: 'Fibo Circles',
    group: 'fib',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { levels: FIB_ARC_LEVELS },
    build: (d, P) => fibArcs(d, P, true),
  },
  {
    id: 'fib-channel',
    label: 'Fibo Channel',
    group: 'fib',
    mode: 'multi',
    n: 3,
    ready: true,
    defaults: { levels: FIB_RETRACEMENT_LEVELS.filter((l) => l.enabled) },
    build: (d, P) => {
      const out = parallelLines(
        d,
        P,
        enabled(d.levels).map((l) => l.value),
        false,
      );
      const [a, b, c] = d.anchors as [Anchor, Anchor, Anchor?];
      if (c) {
        const off = c.px - priceOnLine(P, a, b, c.t);
        for (const l of enabled(d.levels))
          out.push(
            text(P.x(b.t) + 4, P.y(b.px + off * l.value), fmtLevel(l.value), levelColor(d, l), {
              size: 10,
              hit: false,
            }),
          );
      }
      return out;
    },
  },
  // ---------------------------------------------------------- gann & geometry
  {
    id: 'gann-fan',
    label: 'Gann Fan',
    group: 'gann',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { levels: GANN_FAN_LEVELS },
    build: (d, P) => {
      const [x0, y0] = xy(P, d.anchors[0]);
      const [x1, y1] = xy(P, d.anchors[1]);
      const dx = x1 - x0;
      const dy = y1 - y0;
      const out: Shape[] = [];
      for (const l of enabled(d.levels)) {
        const r = l.value;
        const tx = r >= 1 ? x0 + dx / r : x1;
        const ty = r >= 1 ? y1 : y0 + dy * r;
        const seg = extendSegment(x0, y0, tx, ty, P.plot, false, true);
        const col = levelColor(d, l);
        if (seg)
          out.push({
            ...path(d, [...seg]),
            stroke: col,
            alpha: r === 1 ? d.style.opacity : d.style.opacity * 0.7,
          });
        const name = r >= 1 ? `${r}x1` : `1x${Math.round(1 / r)}`;
        out.push(text(tx + 3, ty, name, col, { size: 10, hit: false }));
      }
      return out;
    },
  },
  {
    id: 'gann-box',
    label: 'Gann Box',
    group: 'gann',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { levels: GANN_BOX_LEVELS, style: { fill: '#4FA3F7', fillOpacity: 0.05 } },
    build: (d, P) => {
      const [x0, y0] = xy(P, d.anchors[0]);
      const [x1, y1] = xy(P, d.anchors[1]);
      const out: Shape[] = [
        { ...path(d, rectPts(x0, y0, x1, y1)), closed: true, ...fillOf(d), hit: 'fill' },
      ];
      for (const l of enabled(d.levels)) {
        if (l.value <= 0 || l.value >= 1) continue;
        const x = x0 + (x1 - x0) * l.value;
        const y = y0 + (y1 - y0) * l.value;
        const col = levelColor(d, l);
        out.push({ ...path(d, [x, y0, x, y1], { alpha: 0.6, hit: 'none' }), stroke: col });
        out.push({ ...path(d, [x0, y, x1, y], { alpha: 0.6, hit: 'none' }), stroke: col });
        out.push(
          text(x, Math.max(y0, y1) + 4, fmtLevel(l.value), col, {
            align: 'center',
            base: 'top',
            size: 9,
            hit: false,
          }),
        );
      }
      out.push(
        path(d, [x0, y0, x1, y1], { alpha: 0.5, hit: 'none' }),
        path(d, [x0, y1, x1, y0], { alpha: 0.5, hit: 'none' }),
      );
      return out;
    },
  },
  {
    id: 'gann-square',
    label: 'Gann Square',
    group: 'gann',
    mode: 'two',
    n: 2,
    ready: true,
    build: (d, P) => {
      const [x0, y0] = xy(P, d.anchors[0]);
      const [x1, y1] = xy(P, d.anchors[1]);
      const out: Shape[] = [{ ...path(d, rectPts(x0, y0, x1, y1)), closed: true, ...fillOf(d) }];
      for (const f of [1 / 3, 2 / 3]) {
        out.push(
          path(d, [x0 + (x1 - x0) * f, y0, x0 + (x1 - x0) * f, y1], { alpha: 0.5, hit: 'none' }),
        );
        out.push(
          path(d, [x0, y0 + (y1 - y0) * f, x1, y0 + (y1 - y0) * f], { alpha: 0.5, hit: 'none' }),
        );
      }
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      out.push(
        path(d, [x0, y0, x1, y1], { hit: 'none' }),
        path(d, [x0, y1, x1, y0], { hit: 'none' }),
        path(d, [mx, y0, mx, y1], { dash: 'dotted', hit: 'none' }),
        path(d, [x0, my, x1, my], { dash: 'dotted', hit: 'none' }),
        {
          k: 'ellipse',
          cx: mx,
          cy: my,
          rx: Math.abs(x1 - x0) / 2,
          ry: Math.abs(y1 - y0) / 2,
          ...stroke(d),
          alpha: d.style.opacity * 0.6,
          hit: 'none',
        },
      );
      return out;
    },
  },
  {
    id: 'gann-grid',
    label: 'Gann Grid',
    group: 'gann',
    mode: 'two',
    n: 2,
    ready: true,
    build: (d, P) => {
      const [x0, y0] = xy(P, d.anchors[0]);
      const [x1, y1] = xy(P, d.anchors[1]);
      const dx = x1 - x0;
      const dy = y1 - y0;
      const step = Math.max(8, Math.abs(dx));
      const out: Shape[] = [path(d, [x0, y0, x1, y1], { width: d.style.width + 1 })];
      const n =
        Math.ceil(P.plot.w / step) + Math.ceil(Math.abs((P.plot.h * dx) / (dy || 1)) / step) + 2;
      for (let k = -n; k <= n; k++) {
        const ox = x0 + k * step;
        for (const s of [1, -1]) {
          const seg = extendSegment(ox, y0, ox + dx, y0 + s * dy, P.plot, true, true);
          if (seg) out.push(path(d, [...seg], { alpha: d.style.opacity * 0.45, hit: 'none' }));
        }
      }
      return out;
    },
  },
  {
    id: 'pitchfork',
    label: "Andrew's Pitchfork",
    group: 'gann',
    mode: 'multi',
    n: 3,
    ready: true,
    build: (d, P) => pitchfork(d, P, 'std'),
  },
  {
    id: 'schiff-pitchfork',
    label: 'Schiff Pitchfork',
    group: 'gann',
    mode: 'multi',
    n: 3,
    ready: true,
    build: (d, P) => pitchfork(d, P, 'schiff'),
  },
  {
    id: 'modified-schiff-pitchfork',
    label: 'Modified Schiff Pitchfork',
    group: 'gann',
    mode: 'multi',
    n: 3,
    ready: true,
    build: (d, P) => pitchfork(d, P, 'mod'),
  },
  // ---------------------------------------------------------- elliott & patterns
  waveTool('elliott-impulse', 'Elliott Impulse Wave (12345)', 6),
  waveTool('elliott-correction', 'Elliott Correction Wave (ABC)', 4),
  waveTool('elliott-triangle', 'Elliott Triangle Wave (ABCDE)', 6),
  waveTool('elliott-double', 'Elliott Double Combo Wave (WXY)', 4),
  waveTool('elliott-triple', 'Elliott Triple Combo Wave (WXYXZ)', 6),
  waveTool('abcd', 'ABCD Pattern', 4),
  waveTool('xabcd', 'XABCD Harmonic Pattern', 5),
  waveTool('triangle-pattern', 'Triangle Pattern', 4),
  waveTool('head-shoulders', 'Head & Shoulders', 7),
  // ---------------------------------------------------------- markers
  markerTool('arrow-up', 'Up Arrow', 'Ctrl+Shift+W', '#20C77A'),
  markerTool('arrow-down', 'Down Arrow', 'Ctrl+Shift+S', '#F04A5D'),
  markerTool('dot', 'Dot', 'Ctrl+Shift+N'),
  markerTool('diamond', 'Diamond', 'Ctrl+Shift+Q'),
  markerTool('square', 'Square', 'Ctrl+Shift+E'),
  markerTool('checkmark', 'Checkmark', undefined, '#20C77A'),
  markerTool('cross', 'Cross', undefined, '#F04A5D'),
  markerTool('star', 'Star', undefined, '#E8B04B'),
  markerTool('flag', 'Flag', undefined, '#E8B04B'),
  { ...markerTool('emoji', 'Emoji / icon'), defaults: { props: { size: 20, glyph: '⭐' } } },
  // ---------------------------------------------------------- commands (not drawings)
  {
    id: 'magnifier',
    label: 'Magnifier',
    group: 'measure',
    shortcut: 'M',
    mode: 'click',
    n: 1,
    ready: true,
    command: true,
    note: 'Zoom lens at the cursor (toggle)',
    build: () => [],
  },
  {
    id: 'remove-indicators',
    label: 'Remove indicators',
    group: 'measure',
    mode: 'click',
    n: 1,
    ready: true,
    command: true,
    note: 'Removes every indicator from the active chart',
    build: () => [],
  },
  // ---------------------------------------------------------- text
  {
    id: 'text',
    label: 'Text',
    group: 'text',
    shortcut: 'Ctrl+Shift+T',
    mode: 'click',
    n: 1,
    ready: true,
    defaults: { style: { text: 'Text', color: '#FFFFFF', fontSize: 13 } },
    build: (d, P) => {
      const [x, y] = xy(P, d.anchors[0]);
      return [
        text(x, y, d.style.text || 'Text', d.style.color, {
          size: d.style.fontSize,
          alpha: d.style.opacity,
          bg: d.style.fill || undefined,
          bgAlpha: d.style.fillOpacity,
          pad: d.style.fill ? 4 : 2,
          hit: true,
        }),
      ];
    },
    labels: () => ({ px: [], t: [] }),
  },
  {
    id: 'anchored-text',
    label: 'Anchored Text (screen-fixed)',
    group: 'text',
    mode: 'click',
    n: 1,
    ready: true,
    screen: true,
    defaults: {
      style: { text: 'Note', color: '#FFFFFF', fontSize: 13, fill: '#1A1A1A', fillOpacity: 0.9 },
    },
    build: (d, P) => {
      const a = d.anchors[0]!;
      return [
        text(
          P.plot.x + a.t * P.plot.w,
          P.plot.y + a.px * P.plot.h,
          d.style.text || 'Note',
          d.style.color,
          {
            size: d.style.fontSize,
            bg: d.style.fill || undefined,
            bgAlpha: d.style.fillOpacity,
            pad: 5,
            hit: true,
          },
        ),
      ];
    },
    handles: (d, P) => [
      {
        x: P.plot.x + d.anchors[0]!.t * P.plot.w,
        y: P.plot.y + d.anchors[0]!.px * P.plot.h,
        key: 0,
      },
    ],
    labels: () => ({ px: [], t: [] }),
  },
  {
    id: 'callout',
    label: 'Label / Callout',
    group: 'text',
    shortcut: 'Ctrl+Shift+L',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { style: { text: 'Callout', color: '#FFFFFF', fill: '#1A1A1A', fillOpacity: 0.95 } },
    build: (d, P) => {
      const [x0, y0] = xy(P, d.anchors[0]);
      const [x1, y1] = xy(P, d.anchors[1]);
      return [
        path(d, [x0, y0, x1, y1], { stroke: '#8C8C8C', dash: 'solid', width: 1 }),
        { k: 'marker', m: 'dot', x: x0, y: y0, size: 6, color: '#8C8C8C' },
        text(x1, y1, d.style.text || 'Callout', d.style.color, {
          align: 'center',
          size: d.style.fontSize,
          bg: d.style.fill || '#1A1A1A',
          bgAlpha: d.style.fillOpacity,
          border: '#3A3A3A',
          pad: 6,
          hit: true,
        }),
      ];
    },
  },
  {
    id: 'note',
    label: 'Note (expandable)',
    group: 'text',
    mode: 'click',
    n: 1,
    ready: true,
    defaults: { style: { text: 'Note', color: '#E8B04B' }, props: { expanded: true } },
    build: (d, P) => {
      const [x, y] = xy(P, d.anchors[0]);
      const out: Shape[] = [
        { k: 'marker', m: 'square', x, y, size: 12, color: d.style.color, alpha: d.style.opacity },
      ];
      if (prop(d, 'expanded', true))
        out.push(
          text(x + 10, y - 6, d.style.text || 'Note', '#FFFFFF', {
            base: 'top',
            size: d.style.fontSize,
            bg: '#1A1A1A',
            bgAlpha: 0.95,
            border: d.style.color,
            pad: 6,
            hit: true,
          }),
        );
      return out;
    },
  },
  {
    id: 'price-note',
    label: 'Price Note',
    group: 'text',
    mode: 'click',
    n: 1,
    ready: true,
    defaults: { style: { text: 'Note', color: '#BDBDBD' }, showLabels: true },
    build: (d, P) => {
      const a = d.anchors[0]!;
      const [x, y] = xy(P, a);
      const t = `${P.fmtPrice(a.px)}  ${d.style.text}`;
      return [
        path(d, [x, y, Math.min(P.plot.x + P.plot.w, x + 60), y]),
        { k: 'marker', m: 'dot', x, y, size: 6, color: d.style.color },
        text(x + 64, y, t, d.style.color, { size: d.style.fontSize, hit: true }),
      ];
    },
    labels: pricesOnly,
  },
  {
    id: 'right-price-label',
    label: 'Right Price Label',
    group: 'text',
    shortcut: 'Ctrl+Shift+D',
    mode: 'click',
    n: 1,
    ready: true,
    build: (d, P) => priceLabel(d, P, 'right'),
    labels: () => ({ px: [], t: [] }),
  },
  {
    id: 'left-price-label',
    label: 'Left Price Label',
    group: 'text',
    shortcut: 'Ctrl+Shift+A',
    mode: 'click',
    n: 1,
    ready: true,
    build: (d, P) => priceLabel(d, P, 'left'),
    labels: () => ({ px: [], t: [] }),
  },
  // ---------------------------------------------------------- measurement
  {
    id: 'ruler',
    label: 'Ruler',
    group: 'measure',
    shortcut: 'F9',
    mode: 'two',
    n: 2,
    ready: true,
    note: 'Bars, time, ticks, points, %, $ per contract, volume & delta in range',
    build: (d, P) => rangeBox(d, P, 'ruler'),
  },
  {
    id: 'measure',
    label: 'Measure',
    group: 'measure',
    mode: 'two',
    n: 2,
    ready: true,
    defaults: { style: { color: '#BDBDBD' } },
    build: (d, P) => rangeBox(d, P, 'measure'),
  },
  {
    id: 'date-range',
    label: 'Date Range',
    group: 'measure',
    mode: 'two',
    n: 2,
    ready: true,
    build: (d, P) => rangeBox(d, P, 'date'),
    labels: timesOnly,
  },
  {
    id: 'price-range',
    label: 'Price Range',
    group: 'measure',
    mode: 'two',
    n: 2,
    ready: true,
    build: (d, P) => rangeBox(d, P, 'price'),
    labels: pricesOnly,
  },
  // ---------------------------------------------------------- risk
  ...(['long', 'short'] as const).map((side): ToolDef => ({
    id: side === 'long' ? 'long-position' : 'short-position',
    label: side === 'long' ? 'Long Position' : 'Short Position',
    group: 'risk',
    mode: 'click',
    n: 1,
    ready: true,
    note: 'Drag entry, target, stop and the right edge',
    defaults: { props: { qty: 1, risk: 0 }, showLabels: true },
    init: positionInit(side),
    build: (d, P) => positionShapes(d, P, side),
    handles: (d, P) => {
      const [e, tp, sl] = d.anchors as [Anchor, Anchor, Anchor];
      if (!tp || !sl) return [];
      const xe = P.x(e.t);
      const xr = P.x(tp.t);
      return [
        { x: xe, y: P.y(e.px), key: 0 },
        { x: xe, y: P.y(tp.px), key: 1 },
        { x: xe, y: P.y(sl.px), key: 2 },
        { x: xr, y: P.y(e.px), key: 3 },
      ];
    },
    moveHandle: (d, key, a) => {
      const [e, tp, sl] = d.anchors as [Anchor, Anchor, Anchor];
      if (key === 0) d.anchors = [{ t: a.t, px: a.px }, tp, sl];
      else if (key === 1) d.anchors = [e, { t: tp.t, px: a.px }, sl];
      else if (key === 2) d.anchors = [e, tp, { t: sl.t, px: a.px }];
      else d.anchors = [e, { t: a.t, px: tp.px }, { t: a.t, px: sl.px }];
    },
    labels: (d) => ({ px: d.anchors.map((a) => a.px), t: [] }),
  })),
];

const BY_ID = new Map<string, ToolDef>(TOOLS.map((t) => [t.id, t]));

export function toolDef(id: string): ToolDef | undefined {
  return BY_ID.get(id);
}

export function isTool(id: string): boolean {
  return BY_ID.has(id);
}

export const TOOL_GROUPS: { id: ToolGroup; label: string }[] = [
  { id: 'lines', label: 'Lines' },
  { id: 'shapes', label: 'Shapes' },
  { id: 'channels', label: 'Channels & Regression' },
  { id: 'volume', label: 'Volume Analysis' },
  { id: 'fib', label: 'Fibonacci' },
  { id: 'gann', label: 'Gann & Pitchfork' },
  { id: 'elliott', label: 'Elliott Waves & Patterns' },
  { id: 'markers', label: 'Chart Markers' },
  { id: 'text', label: 'Text' },
  { id: 'measure', label: 'Measurement' },
  { id: 'risk', label: 'Positions' },
];

export function toolsIn(group: ToolGroup): ToolDef[] {
  return TOOLS.filter((t) => t.group === group);
}

/** Label shown in lists ("Horizontal Line 68,450.00"). */
export function drawingName(d: Drawing, fmtPrice: (px: number) => string): string {
  const def = toolDef(d.type);
  const base = def?.label ?? d.type;
  if (d.type === 'horizontal-line' || d.type === 'horizontal-ray' || d.type.endsWith('price-label'))
    return `${base} ${fmtPrice(d.anchors[0]!.px)}`;
  if (d.style.text && d.style.text !== DEFAULT_STYLE.text && def?.group === 'text')
    return `${base}: ${d.style.text.slice(0, 24)}`;
  return base;
}
