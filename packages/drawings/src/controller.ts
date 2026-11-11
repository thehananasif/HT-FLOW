import type { ChartView, PointerHandler } from '@htflow/chart-engine';
import { History } from './history';
import { anchorAt, type MagnetOptions } from './magnet';
import { cloneDrawing, createDrawing, isVisibleOn, maxZ } from './model';
import type { Proj } from './proj';
import { handlesOf } from './render';
import { hitShapes } from './shapes';
import { toolDef, type ToolDef } from './tools';
import type { Anchor, Drawing, ToolId } from './types';

export interface ControllerHost {
  items(): Drawing[];
  /** Persist the new list. */
  save(next: Drawing[]): void;
  tool(): ToolId | null;
  setTool(t: ToolId | null): void;
  keepDrawing(): boolean;
  magnet(): MagnetOptions;
  proj(v: ChartView): Proj;
  selected(): string | null;
  select(id: string | null): void;
  /** Timeframe key for "visible on timeframes". */
  tfKey(): string;
  invalidate(): void;
  /** A drawing was created (open the text editor for text tools…). */
  onCreated?(d: Drawing): void;
  /** Double-click on a drawing. */
  onEdit?(id: string): void;
}

interface Draft {
  d: Drawing;
  def: ToolDef;
  /** Anchors already fixed. */
  placed: number;
  downX: number;
  downY: number;
  lastDown: number;
}

interface Drag {
  orig: Drawing;
  key: number;
  x: number;
  y: number;
  moved: boolean;
}

const HANDLE_R = 7;
const HIT_TOL = 5;

/** Interaction state machine: create, select, move, edit handles, keys, undo/redo. */
export class DrawingController implements PointerHandler {
  readonly history = new History();
  private draft: Draft | null = null;
  private drag: Drag | null = null;
  private temp: Drawing | null = null;
  private hover: { id: string; handle: boolean } | null = null;
  private lastClick = { t: 0, id: '' };
  private lastView: ChartView | null = null;

  constructor(readonly host: ControllerHost) {}

  // ---------------------------------------------------------------- data

  /** Visible drawings in z order, with the draft / dragged drawing substituted. */
  list(): Drawing[] {
    const tf = this.host.tfKey();
    const out = this.host
      .items()
      .filter((d) => isVisibleOn(d, tf))
      .map((d) => (this.temp && this.temp.id === d.id ? this.temp : d))
      .sort((a, b) => a.z - b.z);
    if (this.draft) out.push(this.draft.d);
    return out;
  }

  /** Applies a change with undo history. */
  commit(next: Drawing[]): void {
    this.history.push(this.host.items());
    this.host.save(next);
    this.host.invalidate();
  }

  update(id: string, fn: (d: Drawing) => Drawing): void {
    this.commit(this.host.items().map((d) => (d.id === id ? fn(d) : d)));
  }

  remove(id: string): void {
    this.commit(this.host.items().filter((d) => d.id !== id));
    if (this.host.selected() === id) this.host.select(null);
  }

  removeSelected(): boolean {
    const id = this.host.selected();
    const d = this.host.items().find((x) => x.id === id);
    if (!d || d.locked) return false;
    this.remove(d.id);
    return true;
  }

  removeAll(): void {
    if (!this.host.items().length) return;
    this.commit([]);
    this.host.select(null);
  }

  clone(id: string): void {
    const items = this.host.items();
    const d = items.find((x) => x.id === id);
    if (!d) return;
    const c = cloneDrawing(d, maxZ(items) + 1);
    const def = toolDef(d.type);
    const P = this.lastView ? this.host.proj(this.lastView) : null;
    if (def?.screen) c.anchors = c.anchors.map((a) => ({ t: a.t + 0.03, px: a.px + 0.03 }));
    else if (P) {
      const ticks = Math.max(1, Math.round(16 / Math.max(1e-6, P.tickPx)));
      c.anchors = c.anchors.map((a) => ({
        t: P.axis.timeOf(P.axis.slotOf(a.t) + 16 / P.slotWidth),
        px: a.px - ticks,
      }));
    }
    this.commit([...items, c]);
    this.host.select(c.id);
  }

  bringToFront(id: string): void {
    const z = maxZ(this.host.items()) + 1;
    this.update(id, (d) => ({ ...d, z }));
  }

  sendToBack(id: string): void {
    const z = Math.min(0, ...this.host.items().map((d) => d.z)) - 1;
    this.update(id, (d) => ({ ...d, z }));
  }

  undo(): boolean {
    const prev = this.history.undo(this.host.items());
    if (!prev) return false;
    this.host.save(prev);
    this.host.invalidate();
    return true;
  }

  redo(): boolean {
    const next = this.history.redo(this.host.items());
    if (!next) return false;
    this.host.save(next);
    this.host.invalidate();
    return true;
  }

  cancel(): void {
    this.draft = null;
    this.drag = null;
    this.temp = null;
    this.host.invalidate();
  }

  get creating(): boolean {
    return !!this.draft;
  }

  // ---------------------------------------------------------------- hit-testing

  private anchor(P: Proj, def: ToolDef, x: number, y: number, e?: MouseEvent): Anchor {
    if (def.screen) return { t: (x - P.plot.x) / P.plot.w, px: (y - P.plot.y) / P.plot.h };
    const m = this.host.magnet();
    return anchorAt(P, x, y, e?.ctrlKey ? { ...m, magnet: !m.magnet } : m);
  }

  /** Top-most drawing (and handle) under the point. */
  hitAt(v: ChartView, x: number, y: number): { d: Drawing; key: number } | null {
    const P = this.host.proj(v);
    const list = this.list();
    const sel = this.host.selected();
    const selD = list.find((d) => d.id === sel);
    if (selD) {
      for (const h of handlesOf(selD, P))
        if (Math.hypot(h.x - x, h.y - y) <= HANDLE_R) return { d: selD, key: h.key };
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i]!;
      const def = toolDef(d.type);
      if (!def) continue;
      if (hitShapes(def.build(d, P), x, y, HIT_TOL, P.measure)) return { d, key: -1 };
    }
    return null;
  }

  // ---------------------------------------------------------------- pointer

  private inPlot(v: ChartView, x: number, y: number): boolean {
    return x >= v.plot.x && x <= v.plot.x + v.plot.w && y >= v.plot.y && y <= v.plot.y + v.plot.h;
  }

  onDown(v: ChartView, x: number, y: number, e: MouseEvent): boolean {
    this.lastView = v;
    if (!this.inPlot(v, x, y)) return false;
    const tool = this.host.tool();
    const P = this.host.proj(v);
    if (this.draft) {
      const dr = this.draft;
      const now = Date.now();
      const dbl = now - dr.lastDown < 350 && Math.hypot(x - dr.downX, y - dr.downY) < 5;
      dr.lastDown = now;
      dr.downX = x;
      dr.downY = y;
      if (dr.def.mode === 'poly' && dbl) {
        dr.d.anchors.pop();
        this.finish();
        return true;
      }
      const a = this.anchor(P, dr.def, x, y, e);
      dr.d.anchors[dr.placed] = a;
      dr.placed++;
      const need = dr.def.mode === 'poly' ? Infinity : dr.def.n;
      if (dr.placed >= need) this.finish();
      else dr.d.anchors.push({ ...a });
      return true;
    }
    if (tool) {
      const def = toolDef(tool);
      if (!def || !def.ready) return false;
      const a = this.anchor(P, def, x, y, e);
      const d = createDrawing(def.id, [a], def.defaults, maxZ(this.host.items()) + 1);
      this.draft = { d, def, placed: 1, downX: x, downY: y, lastDown: Date.now() };
      if (def.mode === 'click') {
        def.init?.(d, P);
        this.finish();
      } else if (def.mode !== 'free') d.anchors.push({ ...a });
      return true;
    }
    const hit = this.hitAt(v, x, y);
    if (!hit) {
      if (this.host.selected()) this.host.select(null);
      return false;
    }
    this.host.select(hit.d.id);
    const now = Date.now();
    if (this.lastClick.id === hit.d.id && now - this.lastClick.t < 350) {
      this.lastClick = { t: 0, id: '' };
      this.host.onEdit?.(hit.d.id);
      return true;
    }
    this.lastClick = { t: now, id: hit.d.id };
    if (!hit.d.locked) this.drag = { orig: hit.d, key: hit.key, x, y, moved: false };
    return true;
  }

  onMove(v: ChartView, x: number, y: number, e: MouseEvent, captured: boolean): void {
    this.lastView = v;
    const P = this.host.proj(v);
    if (this.draft) {
      const dr = this.draft;
      const a = this.anchor(P, dr.def, x, y, e);
      if (dr.def.mode === 'free') {
        if (captured) {
          const last = dr.d.anchors[dr.d.anchors.length - 1]!;
          if (Math.hypot(P.x(last.t) - x, P.y(last.px) - y) > 2) dr.d.anchors.push(a);
        }
      } else dr.d.anchors[dr.placed] = a;
      this.host.invalidate();
      return;
    }
    if (this.drag && captured) {
      const g = this.drag;
      if (!g.moved && Math.hypot(x - g.x, y - g.y) < 3) return;
      g.moved = true;
      const def = toolDef(g.orig.type)!;
      const d: Drawing = { ...g.orig, anchors: g.orig.anchors.map((a) => ({ ...a })) };
      if (g.key >= 0) {
        const a = this.anchor(P, def, x, y, e);
        if (def.moveHandle) def.moveHandle(d, g.key, a, P);
        else d.anchors[g.key] = a;
      } else if (def.screen) {
        const dx = (x - g.x) / P.plot.w;
        const dy = (y - g.y) / P.plot.h;
        d.anchors = d.anchors.map((a) => ({ t: a.t + dx, px: a.px + dy }));
      } else {
        const ds = (x - g.x) / P.slotWidth;
        let dp = P.px(y) - P.px(g.y);
        if (this.host.magnet().snapTicks) dp = Math.round(dp);
        d.anchors = d.anchors.map((a) => ({
          t: ds ? P.axis.timeOf(P.axis.slotOf(a.t) + ds) : a.t,
          px: a.px + dp,
        }));
      }
      this.temp = d;
      this.host.invalidate();
      return;
    }
    if (!captured && !this.host.tool()) {
      const hit = this.inPlot(v, x, y) ? this.hitAt(v, x, y) : null;
      const next = hit ? { id: hit.d.id, handle: hit.key >= 0 } : null;
      if (next?.id !== this.hover?.id || next?.handle !== this.hover?.handle) this.hover = next;
    }
  }

  onUp(_v: ChartView, x: number, y: number): void {
    if (this.draft) {
      const dr = this.draft;
      if (dr.def.mode === 'free') {
        if (dr.d.anchors.length > 1) this.finish();
        else this.draft = null;
      } else if (dr.def.mode === 'two' && dr.placed === 1) {
        // drag-to-create: releasing away from the press point places the second anchor
        if (Math.hypot(x - dr.downX, y - dr.downY) > 5) this.finish();
      }
      return;
    }
    if (this.drag) {
      const t = this.temp;
      const moved = this.drag.moved;
      this.drag = null;
      this.temp = null;
      if (t && moved) this.commit(this.host.items().map((d) => (d.id === t.id ? t : d)));
    }
  }

  private finish(): void {
    const dr = this.draft;
    if (!dr) return;
    this.draft = null;
    const d = dr.d;
    if (dr.def.mode === 'poly' && d.anchors.length < 2) return;
    this.commit([...this.host.items(), d]);
    this.host.select(d.id);
    if (!this.host.keepDrawing()) this.host.setTool(null);
    this.host.onCreated?.(d);
  }

  onKey(e: KeyboardEvent): boolean {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (k === 'Escape') {
      if (this.draft) this.cancel();
      else if (this.host.tool()) this.host.setTool(null);
      else if (this.host.selected()) this.host.select(null);
      else return false;
      return true;
    }
    if (k === 'Enter' && this.draft?.def.mode === 'poly') {
      this.draft.d.anchors.pop();
      this.finish();
      return true;
    }
    if (k === 'Delete' || k === 'Backspace') return this.removeSelected();
    if (ctrl && (k === 'z' || k === 'Z') && !e.shiftKey) return this.undo() || true;
    if (ctrl && (k === 'y' || k === 'Y' || ((k === 'z' || k === 'Z') && e.shiftKey)))
      return this.redo() || true;
    const sel = this.host.items().find((d) => d.id === this.host.selected());
    if (
      sel &&
      !sel.locked &&
      !toolDef(sel.type)?.screen &&
      (k === 'ArrowUp' || k === 'ArrowDown')
    ) {
      const dp = k === 'ArrowUp' ? 1 : -1;
      this.update(sel.id, (d) => ({
        ...d,
        anchors: d.anchors.map((a) => ({ t: a.t, px: a.px + dp })),
      }));
      return true;
    }
    return false;
  }

  cursor(): string | null {
    if (this.draft || this.host.tool()) return 'crosshair';
    if (this.drag) return 'grabbing';
    if (this.hover) return this.hover.handle ? 'grab' : 'pointer';
    return null;
  }
}
