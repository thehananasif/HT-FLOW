import type { ChartLayer, ChartView, Rect } from '@htflow/chart-engine';
import { ListOut, SeriesOut } from './buffers';
import {
  paneGroups,
  resolveStyles,
  titleOf,
  type IndicatorConfig,
  type PaneTarget,
} from './config';
import type { RuntimeLike } from './engine';
import { formatValue, niceStep, rgba } from './format';
import type { TfClass } from './periods';
import { IndicatorRuntime } from './runtime';
import { isPriceSource } from './types';
import type {
  AnyIndicator,
  BarData,
  InputDefs,
  InputValues,
  Level,
  Marker,
  OutputDef,
  OutputStyle,
  SourceId,
  ValueUnit,
  Zone,
} from './types';

export interface RenderItem {
  cfg: IndicatorConfig;
  def: AnyIndicator;
  rt: RuntimeLike;
  styles: Record<string, OutputStyle>;
  title: string;
  key: string;
}

export interface Hotspot {
  x: number;
  y: number;
  w: number;
  h: number;
  uid: string;
  action: 'toggle' | 'settings' | 'remove';
}

interface Mapper {
  y(val: number): number;
  rect: Rect;
  /** Baseline y for histograms / areas. */
  base: number;
}

const ORDER: Record<string, number> = {
  zones: 0,
  band: 1,
  histogram: 2,
  area: 3,
  bars: 4,
  levels: 5,
  step: 6,
  line: 7,
  dots: 8,
  markers: 9,
};

function dash(ctx: CanvasRenderingContext2D, s: OutputStyle): void {
  ctx.setLineDash(s.style === 'dashed' ? [6, 4] : s.style === 'dotted' ? [1.5, 3] : []);
}

const toneColor = (s: OutputStyle, t: number) =>
  t === 1 ? s.color2 : t === 2 ? s.color3 : s.color;

const orderCache = new WeakMap<AnyIndicator, [string, OutputDef][]>();
/** Outputs in paint order (computed once per definition, not on every frame). */
function drawOrder(def: AnyIndicator): [string, OutputDef][] {
  let e = orderCache.get(def);
  if (!e) {
    e = Object.entries(def.outputs).sort((p, q) => ORDER[p[1].kind]! - ORDER[q[1].kind]!);
    orderCache.set(def, e);
  }
  return e;
}

/** Draws every visible output of one indicator into `m.rect`. */
export function drawOutputs(v: ChartView, it: RenderItem, m: Mapper): void {
  const { ctx } = v;
  const n = it.rt.count;
  const a = Math.max(0, v.i0 - 1);
  const b = Math.min(n - 1, v.i1 + 1);
  const sw = v.slotWidth;
  const bw = Math.max(1, Math.floor(sw * 0.6));
  const right = m.rect.x + m.rect.w;
  const entries = drawOrder(it.def);
  for (const [id, od] of entries) {
    const st = it.styles[id]!;
    if (!st.visible) continue;
    const o = it.rt.outputs[id]!;
    ctx.save();
    ctx.globalAlpha = st.opacity;
    ctx.lineWidth = st.width;
    dash(ctx, st);
    if (o instanceof SeriesOut) {
      switch (od.kind) {
        case 'line':
        case 'area': {
          let started = false;
          let tone = 0;
          let px = 0;
          let py = 0;
          let x0 = 0;
          const flush = () => {
            if (!started) return;
            ctx.strokeStyle = toneColor(st, tone);
            ctx.stroke();
            if (od.kind === 'area') {
              ctx.lineTo(px, m.base);
              ctx.lineTo(x0, m.base);
              ctx.closePath();
              ctx.fillStyle = rgba(st.color, 0.18);
              ctx.fill();
            }
          };
          for (let i = a; i <= b; i++) {
            const val = o.v[i]!;
            if (Number.isNaN(val)) {
              flush();
              started = false;
              continue;
            }
            const x = v.xOf(i);
            const y = m.y(val);
            const t = o.tone[i]!;
            if (!started) {
              ctx.beginPath();
              ctx.moveTo(x, y);
              x0 = x;
              tone = t;
              started = true;
            } else if (t !== tone && od.kind === 'line') {
              ctx.strokeStyle = toneColor(st, tone);
              ctx.stroke();
              ctx.beginPath();
              ctx.moveTo(px, py);
              ctx.lineTo(x, y);
              tone = t;
            } else ctx.lineTo(x, y);
            px = x;
            py = y;
          }
          flush();
          break;
        }
        case 'step': {
          ctx.strokeStyle = st.color;
          ctx.beginPath();
          let runStart = -1;
          let lastEnd = 0;
          let lastY = 0;
          for (let i = a; i <= b + 1; i++) {
            const val = i <= b ? o.v[i]! : Number.NaN;
            const prev = runStart >= 0 ? o.v[runStart]! : Number.NaN;
            if (runStart >= 0 && val !== prev) {
              const y = Math.round(m.y(prev)) + 0.5;
              ctx.moveTo(v.xOf(runStart) - sw / 2, y);
              lastEnd = v.xOf(i - 1) + sw / 2;
              lastY = y;
              ctx.lineTo(lastEnd, y);
              runStart = -1;
            }
            if (runStart < 0 && !Number.isNaN(val)) runStart = i;
          }
          ctx.stroke();
          if (st.label && lastEnd > 0 && b === n - 1) {
            ctx.setLineDash([]);
            ctx.fillStyle = st.color;
            ctx.font = v.font(9);
            ctx.textAlign = 'left';
            ctx.fillText(st.label, Math.min(lastEnd + 3, right - 24), lastY - 6);
          }
          break;
        }
        case 'histogram': {
          ctx.setLineDash([]);
          for (let i = a; i <= b; i++) {
            const val = o.v[i]!;
            if (Number.isNaN(val)) continue;
            const x = v.xOf(i);
            const col = toneColor(st, o.tone[i]!);
            const hi = o.v2[i]!;
            const lo = o.v3[i]!;
            if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
              ctx.strokeStyle = rgba(col, 0.6);
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(Math.round(x) + 0.5, m.y(hi));
              ctx.lineTo(Math.round(x) + 0.5, m.y(lo));
              ctx.stroke();
            }
            const y = m.y(val);
            ctx.fillStyle = col;
            const top = Math.min(y, m.base);
            ctx.fillRect(Math.round(x - bw / 2), top, bw, Math.max(1, Math.abs(y - m.base)));
          }
          break;
        }
        case 'band': {
          for (const t of [0, 1, 2]) {
            let any = false;
            ctx.beginPath();
            for (let i = Math.max(1, a); i <= b; i++) {
              if (o.tone[i] !== t) continue;
              const u1 = o.v[i]!;
              const l1 = o.v2[i]!;
              const u0 = o.v[i - 1]!;
              const l0 = o.v2[i - 1]!;
              if (Number.isNaN(u1 + l1 + u0 + l0)) continue;
              const xa = v.xOf(i - 1);
              const xb = v.xOf(i);
              ctx.moveTo(xa, m.y(u0));
              ctx.lineTo(xb, m.y(u1));
              ctx.lineTo(xb, m.y(l1));
              ctx.lineTo(xa, m.y(l0));
              ctx.closePath();
              any = true;
            }
            if (any) {
              ctx.fillStyle = rgba(toneColor(st, t), 0.14);
              ctx.fill();
            }
          }
          break;
        }
        case 'dots': {
          const r = Math.max(1.5, st.width);
          for (let i = a; i <= b; i++) {
            const val = o.v[i]!;
            if (Number.isNaN(val)) continue;
            ctx.fillStyle = toneColor(st, o.tone[i]!);
            ctx.beginPath();
            ctx.arc(v.xOf(i), m.y(val), r, 0, Math.PI * 2);
            ctx.fill();
          }
          break;
        }
        case 'bars': {
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
          for (let i = a; i <= b; i++) {
            const op = o.v[i]!;
            if (Number.isNaN(op)) continue;
            const cl = o.v4[i]!;
            const col = toneColor(st, o.tone[i]!);
            const x = Math.round(v.xOf(i)) + 0.5;
            ctx.strokeStyle = col;
            ctx.beginPath();
            ctx.moveTo(x, m.y(o.v2[i]!));
            ctx.lineTo(x, m.y(o.v3[i]!));
            ctx.stroke();
            const yt = m.y(Math.max(op, cl));
            ctx.fillStyle = col;
            ctx.fillRect(Math.round(x - bw / 2), yt, bw, Math.max(1, m.y(Math.min(op, cl)) - yt));
          }
          break;
        }
      }
    } else if (o instanceof ListOut) {
      if (od.kind === 'markers') {
        ctx.font = v.font(10);
        ctx.textAlign = 'center';
        for (const mk of (o as ListOut<Marker>).items) {
          if (mk.bar < a || mk.bar > b) continue;
          const x = v.xOf(mk.bar);
          const y = m.y(mk.value);
          const r = mk.size || 3;
          const col = toneColor(st, mk.tone);
          ctx.fillStyle = rgba(col, mk.shape === 'circle' && r > 4 ? 0.35 : 0.9);
          ctx.strokeStyle = col;
          ctx.setLineDash([]);
          ctx.beginPath();
          if (mk.shape === 'circle') ctx.arc(x, y, r, 0, Math.PI * 2);
          else if (mk.shape === 'square') ctx.rect(x - r, y - r, r * 2, r * 2);
          else if (mk.shape === 'diamond') {
            ctx.moveTo(x, y - r);
            ctx.lineTo(x + r, y);
            ctx.lineTo(x, y + r);
            ctx.lineTo(x - r, y);
            ctx.closePath();
          } else if (mk.shape !== 'text') {
            const s = mk.shape === 'triangleUp' ? 1 : -1;
            ctx.moveTo(x, y - s * r);
            ctx.lineTo(x + r, y + s * r);
            ctx.lineTo(x - r, y + s * r);
            ctx.closePath();
          }
          if (mk.shape !== 'text') {
            ctx.fill();
            ctx.stroke();
          }
          if (mk.text) {
            ctx.fillStyle = mk.textPos === 'center' ? '#FFFFFF' : col;
            const dy = mk.textPos === 'above' ? -r - 7 : mk.textPos === 'below' ? r + 8 : 0;
            if (mk.textPos === 'right') {
              ctx.textAlign = 'left';
              ctx.fillText(mk.text, x + r + 4, y);
              ctx.textAlign = 'center';
            } else ctx.fillText(mk.text, x, y + dy);
          }
        }
      } else if (od.kind === 'levels') {
        ctx.font = v.font(9);
        ctx.textAlign = 'right';
        for (const lv of (o as ListOut<Level>).items) {
          const to = lv.to < 0 ? Infinity : lv.to;
          if (lv.bar > b || to < a) continue;
          const y = Math.round(m.y(lv.value)) + 0.5;
          if (y < m.rect.y || y > m.rect.y + m.rect.h) continue;
          const xa = Math.max(m.rect.x, v.xOf(Math.max(lv.bar, 0)) - sw / 2);
          const xb = lv.to < 0 ? right : Math.min(right, v.xOf(lv.to) + sw / 2);
          ctx.strokeStyle = toneColor(st, lv.tone);
          ctx.beginPath();
          ctx.moveTo(xa, y);
          ctx.lineTo(xb, y);
          ctx.stroke();
          if (lv.label) {
            ctx.fillStyle = toneColor(st, lv.tone);
            ctx.fillText(lv.label, xb - 4, y - 6);
          }
        }
      } else {
        for (const z of (o as ListOut<Zone>).items) {
          const to = z.to < 0 ? Infinity : z.to;
          if (z.bar > b || to < a) continue;
          const xa = Math.max(m.rect.x, v.xOf(z.bar) - sw / 2);
          const xb = z.to < 0 ? right : Math.min(right, v.xOf(z.to) + sw / 2);
          const yt = m.y(z.top);
          const yb = m.y(z.bottom);
          const col = toneColor(st, z.tone);
          ctx.fillStyle = rgba(col, 0.16);
          ctx.fillRect(xa, yt, xb - xa, Math.max(1, yb - yt));
          ctx.strokeStyle = rgba(col, 0.6);
          ctx.lineWidth = 1;
          ctx.strokeRect(xa + 0.5, Math.round(yt) + 0.5, xb - xa, Math.max(1, Math.round(yb - yt)));
        }
      }
    }
    ctx.restore();
  }
}

/** Min / max of the visible series outputs over bars [i0, i1]. */
export function valueRange(it: RenderItem, i0: number, i1: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  const b = Math.min(i1, it.rt.count - 1);
  for (const [id, od] of Object.entries(it.def.outputs)) {
    const o = it.rt.outputs[id];
    if (!(o instanceof SeriesOut) || !it.styles[id]!.visible) continue;
    for (let i = Math.max(0, i0); i <= b; i++) {
      const [l, h] = o.rangeAt(i);
      if (l < lo) lo = l;
      if (h > hi) hi = h;
    }
    if (od.kind === 'histogram' || od.kind === 'area') {
      const base = od.baseline ?? 0;
      if (base < lo) lo = base;
      if (base > hi) hi = base;
    }
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null;
}

/** Output unit; 'price' outputs computed from a non-price source (volume, delta, CVD…) format as volume. */
function unitFor(it: RenderItem, od: OutputDef): ValueUnit {
  const inputs = it.rt.inputs as Record<string, unknown>;
  // An input named `unit` (Custom Formula) overrides the output unit.
  if (typeof inputs.unit === 'string' && UNITS.includes(inputs.unit as ValueUnit))
    return inputs.unit as ValueUnit;
  const u = od.unit ?? 'value';
  const s = inputs.source;
  if (u === 'price' && typeof s === 'string' && !isPriceSource(s as SourceId))
    return s === 'trades' ? 'count' : 'volume';
  return u;
}

const UNITS: ValueUnit[] = ['price', 'volume', 'value', 'percent', 'count'];

/** Builds the runtime of one configured indicator (pool, other symbol, or main thread). */
export type RuntimeFactory = (cfg: IndicatorConfig, def: AnyIndicator) => RuntimeLike;

/** Key of everything that requires a new runtime when it changes. */
export function runtimeKey(cfg: IndicatorConfig): string {
  return `${cfg.type}|${JSON.stringify(cfg.inputs)}|${cfg.tf}|${cfg.tfMode}|${cfg.symbol}`;
}

function drawEye(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  on: boolean,
  col: string,
): void {
  ctx.save();
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.ellipse(x + 6, y, 5.5, 3.5, 0, 0, Math.PI * 2);
  ctx.stroke();
  if (on) {
    ctx.beginPath();
    ctx.arc(x + 6, y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(x + 1, y + 5);
    ctx.lineTo(x + 11, y - 5);
    ctx.stroke();
  }
  ctx.restore();
}

/** Owns the indicators of one chart: runtimes, layers, legend hot-spots. No DOM / React. */
export class IndicatorScene {
  items: RenderItem[] = [];
  hotspots: Hotspot[] = [];
  /** Show indicator values in the legend rows (Settings → Chart → status line). */
  showValues = true;
  private frame: unknown = null;
  private viewHeight = 600;
  private byUid = new Map<string, RenderItem>();

  /** Sub-pane rectangles of the last frame (drag & drop targets). */
  paneRects: { leader: string; y: number; h: number }[] = [];
  private plotRect = { y: 0, h: 0 };
  /** Indicator being dragged to another pane and the pointer y (drawn as a drop hint). */
  drag: { uid: string; y: number } | null = null;

  constructor(
    private getData: () => BarData | null,
    private lookup: (id: string) => AnyIndicator | undefined,
    private factory: RuntimeFactory = (cfg, def) => new IndicatorRuntime(def, cfg.inputs),
  ) {}

  /** Disposes every runtime (chart closed). */
  dispose(): void {
    for (const it of this.items) it.rt.dispose?.();
    this.items = [];
    this.byUid.clear();
  }

  /** Drop target for a pointer y: price pane, a sub-pane (join), or below the panes (new). */
  dropTarget(y: number): { target: PaneTarget; y: number; h: number } | null {
    for (const r of this.paneRects)
      if (y >= r.y && y < r.y + r.h) return { target: { join: r.leader }, y: r.y, h: r.h };
    const p = this.plotRect;
    if (p.h <= 0) return null;
    // The bottom 15 % of the price pane means "new pane"; the rest is the price pane.
    if (y >= p.y && y < p.y + p.h * 0.85) return { target: 'overlay', y: p.y, h: p.h * 0.85 };
    if (y >= p.y + p.h * 0.85 && y < p.y + p.h)
      return { target: 'new', y: p.y + p.h * 0.85, h: p.h * 0.15 };
    return null;
  }

  /** Applies a new configuration; runtimes are kept when type + inputs are unchanged. */
  sync(configs: IndicatorConfig[], tf: TfClass | null): void {
    const next: RenderItem[] = [];
    const map = new Map<string, RenderItem>();
    for (const cfg of configs) {
      const def = this.lookup(cfg.type);
      if (!def) continue;
      if (tf && !cfg.visibility.includes(tf)) continue;
      const key = runtimeKey(cfg);
      const old = this.byUid.get(cfg.uid);
      const rt = old && old.key === key ? old.rt : this.factory(cfg, def);
      const it: RenderItem = {
        cfg,
        def,
        rt,
        key,
        styles: resolveStyles(def, cfg.styles),
        title: titleOf(def, cfg.inputs),
      };
      next.push(it);
      map.set(cfg.uid, it);
    }
    for (const [uid, it] of this.byUid) if (map.get(uid)?.rt !== it.rt) it.rt.dispose?.();
    this.items = next;
    this.byUid = map;
  }

  private begin(v: ChartView): void {
    if (this.frame !== v.tags) {
      this.frame = v.tags;
      this.hotspots = [];
      this.paneRects = [];
      this.plotRect = { y: v.plot.y, h: v.plot.h };
      this.viewHeight = v.height;
    }
  }

  private ready(it: RenderItem): boolean {
    if (!it.cfg.enabled) return false;
    const d = this.getData();
    if (!d) return false;
    it.rt.update(d);
    return true;
  }

  hit(x: number, y: number): Hotspot | null {
    for (const h of this.hotspots)
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
    return null;
  }

  /** Total height of all sub-panes (for spacer layers on linked charts). */
  panesHeight(): number {
    return this.paneLayers.reduce((s, l) => s + l.bottomHeight(), 0);
  }

  private paneLayers: PaneLayer[] = [];

  /** Builds chart layers for the current items. */
  layers(): { below: ChartLayer[]; above: ChartLayer[] } {
    const below: ChartLayer[] = [];
    const above: ChartLayer[] = [];
    for (const it of this.items) {
      if (it.cfg.pane !== 'overlay') continue;
      (it.cfg.z === 'bottom' ? below : above).push(new OverlayLayer(this, it));
    }
    const groups = paneGroups(this.items.map((i) => i.cfg));
    this.paneLayers = groups.map(
      (g) => new PaneLayer(this, g.map((c) => this.byUid.get(c.uid)!).filter(Boolean)),
    );
    above.push(...this.paneLayers, new LegendLayer(this));
    return { below, above };
  }

  /** Shrinks panes when they would take more than 60 % of the chart. */
  paneFactor(): number {
    const total = this.paneLayers.reduce((s, l) => s + l.wanted(), 0);
    return total > 0 ? Math.min(1, (this.viewHeight * 0.6) / total) : 1;
  }

  /** @internal */
  _begin(v: ChartView): void {
    this.begin(v);
  }
  /** @internal */
  _ready(it: RenderItem): boolean {
    return this.ready(it);
  }

  /** Draws "eye  Title  v1 v2 ×" at (x, y) and registers hot-spots. */
  legendRow(v: ChartView, it: RenderItem, x: number, y: number): void {
    const { ctx, palette: p } = v;
    const on = it.cfg.enabled;
    drawEye(ctx, x, y, on, on ? p.textSecondary : p.textTertiary);
    this.hotspots.push({ x: x - 2, y: y - 8, w: 16, h: 16, uid: it.cfg.uid, action: 'toggle' });
    let cx = x + 18;
    ctx.textAlign = 'left';
    ctx.font = v.font(11);
    ctx.fillStyle = on ? p.textSoft : p.textTertiary;
    ctx.fillText(it.title, cx, y);
    const tw = ctx.measureText(it.title).width;
    this.hotspots.push({
      x: cx - 2,
      y: y - 8,
      w: tw + 4,
      h: 16,
      uid: it.cfg.uid,
      action: 'settings',
    });
    cx += tw + 8;
    if (on && it.rt.notice) {
      ctx.font = v.font(11);
      ctx.fillStyle = p.textTertiary;
      ctx.fillText(it.rt.notice, cx, y);
      cx += ctx.measureText(it.rt.notice).width + 8;
    }
    if (on && this.showValues && it.rt.count > 0) {
      const c = v.crosshair;
      const idx = c && c.slot >= 0 && c.slot < it.rt.count ? c.slot : it.rt.count - 1;
      ctx.font = v.font(11, 600);
      for (const [id, od] of Object.entries(it.def.outputs)) {
        const s = it.rt.series(id);
        const st = it.styles[id]!;
        if (!s || od.legend === false || !st.visible || od.kind === 'band') continue;
        const val = it.rt.valueAt(id, idx);
        if (Number.isNaN(val)) continue;
        const txt = formatValue(val, unitFor(it, od), v.instrument);
        ctx.fillStyle = toneColor(st, s.tone[idx]!);
        ctx.fillText(txt, cx, y);
        cx += ctx.measureText(txt).width + 7;
        if (cx > v.plot.x + v.plot.w - 40) break;
      }
    }
    ctx.font = v.font(11);
    ctx.fillStyle = p.textTertiary;
    ctx.fillText('×', cx, y);
    this.hotspots.push({ x: cx - 3, y: y - 8, w: 14, h: 16, uid: it.cfg.uid, action: 'remove' });
  }
}

class OverlayLayer implements ChartLayer {
  readonly id: string;
  constructor(
    private scene: IndicatorScene,
    private it: RenderItem,
  ) {
    this.id = `ind:${it.cfg.uid}`;
  }

  priceRange(i0: number, i1: number): [number, number] | null {
    const it = this.it;
    if (it.cfg.scale === 'own' || it.def.autoscale === false || !this.scene._ready(it)) return null;
    return valueRange(it, i0, i1);
  }

  draw(v: ChartView): void {
    this.scene._begin(v);
    const it = this.it;
    if (!this.scene._ready(it)) return;
    const { ctx } = v;
    ctx.beginPath();
    ctx.rect(v.plot.x, v.plot.y, v.plot.w, v.plot.h);
    ctx.clip();
    if (it.cfg.scale === 'own') {
      const r = valueRange(it, v.i0, v.i1);
      if (!r) return;
      const h = v.plot.h * 0.28;
      const bottom = v.plot.y + v.plot.h;
      const span = Math.max(1e-9, r[1] - r[0]);
      const y = (x: number) => bottom - ((x - r[0]) / span) * h;
      drawOutputs(v, it, { y, rect: v.plot, base: y(Math.max(r[0], Math.min(r[1], 0))) });
      return;
    }
    drawOutputs(v, it, { y: v.yOf, rect: v.plot, base: v.plot.y + v.plot.h });
    for (const [id, od] of Object.entries(it.def.outputs)) {
      const st = it.styles[id]!;
      if (!st.priceTag || !st.visible) continue;
      const val = it.rt.valueAt(id, it.rt.count - 1);
      if (!Number.isNaN(val))
        v.tags.push({
          px: val,
          bg: st.color,
          fg: '#000',
          text: formatValue(val, unitFor(it, od), v.instrument),
        });
    }
  }
}

const COLLAPSED = 20;

class PaneLayer implements ChartLayer {
  readonly id: string;
  constructor(
    private scene: IndicatorScene,
    private its: RenderItem[],
  ) {
    this.id = `ind-pane:${its[0]?.cfg.uid ?? ''}`;
  }

  wanted(): number {
    return this.its.some((i) => i.cfg.enabled) ? (this.its[0]?.cfg.height ?? 100) : COLLAPSED;
  }

  bottomHeight(): number {
    const w = this.wanted();
    return w === COLLAPSED ? w : Math.max(36, Math.round(w * this.scene.paneFactor()));
  }

  draw(v: ChartView): void {
    this.scene._begin(v);
    const { ctx, palette: p } = v;
    const r = v.bottom;
    if (this.its[0]) this.scene.paneRects.push({ leader: this.its[0].cfg.uid, y: r.y, h: r.h });
    ctx.strokeStyle = p.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, r.y + 0.5);
    ctx.lineTo(v.width, r.y + 0.5);
    ctx.stroke();
    const live = this.its.filter((it) => this.scene._ready(it));
    const lead = live[0];
    const pad = 6;
    const mapFor = (range: [number, number]): Mapper => {
      const span = Math.max(1e-9, range[1] - range[0]);
      const y = (x: number) => r.y + pad + ((range[1] - x) / span) * (r.h - pad * 2);
      return { y, rect: r, base: y(Math.max(range[0], Math.min(range[1], 0))) };
    };
    const rangeOf = (list: RenderItem[]): [number, number] | null => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const it of list) {
        const rg = it.def.range ?? valueRange(it, v.i0, v.i1);
        if (!rg) continue;
        lo = Math.min(lo, rg[0]);
        hi = Math.max(hi, rg[1]);
      }
      if (!Number.isFinite(lo)) return null;
      if (hi - lo < 1e-9) {
        hi += 1;
        lo -= 1;
      }
      return [lo, hi];
    };
    if (lead && r.h > COLLAPSED) {
      const merged = live.filter((it, k) => k === 0 || it.cfg.scale === 'merged');
      const range = rangeOf(merged);
      if (range) {
        const m = mapFor(range);
        const unit = unitFor(lead, Object.values(lead.def.outputs)[0]!);
        // Scale: grid lines + labels in the axis column.
        const k = unit === 'price' ? v.instrument.tickSize : 1;
        const step = niceStep((range[1] - range[0]) * k, Math.max(2, r.h / 30)) / k;
        ctx.font = v.font(10);
        ctx.textAlign = 'left';
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = p.grid;
        ctx.beginPath();
        const labels: [number, string][] = [];
        for (let x = Math.ceil(range[0] / step) * step; x <= range[1] + step * 1e-6; x += step) {
          const y = Math.round(m.y(x)) + 0.5;
          if (y < r.y + 7 || y > r.y + r.h - 5) continue;
          ctx.moveTo(v.plot.x, y);
          ctx.lineTo(v.plot.x + v.plot.w, y);
          labels.push([y, formatValue(Math.abs(x) < step * 1e-6 ? 0 : x, unit, v.instrument)]);
        }
        ctx.stroke();
        const guides = lead.def.guides?.(lead.rt.inputs as InputValues<InputDefs>) ?? [];
        if (lead.def.zeroLine) guides.push(0);
        ctx.strokeStyle = p.textTertiary;
        ctx.beginPath();
        for (const g of guides) {
          if (g < range[0] || g > range[1]) continue;
          const y = Math.round(m.y(g)) + 0.5;
          ctx.moveTo(v.plot.x, y);
          ctx.lineTo(v.plot.x + v.plot.w, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.save();
        ctx.beginPath();
        ctx.rect(v.plot.x, r.y + 1, v.plot.w, r.h - 1);
        ctx.clip();
        for (const it of live) {
          if (merged.includes(it)) drawOutputs(v, it, m);
          else {
            const own = rangeOf([it]);
            if (own) drawOutputs(v, it, mapFor(own));
          }
        }
        ctx.restore();
        if (v.priceAxis.w > 0) {
          const ax = v.priceAxis.x;
          ctx.fillStyle = p.textSecondary;
          ctx.font = v.font(10);
          ctx.textAlign = 'left';
          for (const [y, t] of labels) ctx.fillText(t, ax + 8, y);
          for (const it of merged) {
            for (const [id, od] of Object.entries(it.def.outputs)) {
              const st = it.styles[id]!;
              if (!st.priceTag || !st.visible) continue;
              const val = it.rt.valueAt(id, it.rt.count - 1);
              if (Number.isNaN(val)) continue;
              const y = Math.min(r.y + r.h - 8, Math.max(r.y + 8, m.y(val)));
              ctx.fillStyle = st.color;
              ctx.fillRect(ax + 1, Math.round(y - 8), v.priceAxis.w - 1, 16);
              ctx.fillStyle = '#000';
              ctx.font = v.font(10, 600);
              ctx.fillText(formatValue(val, unitFor(it, od), v.instrument), ax + 6, y);
            }
          }
        }
      }
    }
    this.its.forEach((it, k) => this.scene.legendRow(v, it, v.plot.x + 8, r.y + 11 + k * 15));
  }
}

class LegendLayer implements ChartLayer {
  readonly id = 'ind-legend';
  constructor(private scene: IndicatorScene) {}
  draw(v: ChartView): void {
    this.scene._begin(v);
    let y = 46;
    for (const it of this.scene.items) {
      if (it.cfg.pane !== 'overlay') continue;
      this.scene.legendRow(v, it, v.plot.x + 8, y);
      y += 16;
    }
    const d = this.scene.drag;
    const t = d && this.scene.dropTarget(d.y);
    if (t) {
      const { ctx, palette: p } = v;
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(v.plot.x, t.y, v.plot.w, t.h);
      ctx.strokeStyle = p.textSecondary;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(v.plot.x + 0.5, Math.round(t.y) + 0.5, v.plot.w - 1, Math.round(t.h) - 1);
      ctx.setLineDash([]);
      ctx.font = v.font(11, 600);
      ctx.fillStyle = p.textSoft;
      ctx.textAlign = 'center';
      const label =
        t.target === 'overlay'
          ? 'Move to price pane'
          : t.target === 'new'
            ? 'Move to a new pane'
            : 'Move to this pane';
      ctx.fillText(label, v.plot.x + v.plot.w / 2, t.y + Math.min(t.h / 2, 24));
      ctx.restore();
    }
  }
}

/** Reserves the same sub-pane height on a linked chart so both price panes stay aligned. */
export class PaneSpacerLayer implements ChartLayer {
  readonly id = 'ind-spacer';
  constructor(private scene: IndicatorScene) {}
  bottomHeight(): number {
    return this.scene.panesHeight();
  }
  draw(): void {}
}
