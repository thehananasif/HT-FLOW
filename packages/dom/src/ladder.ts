import { formatCompact, formatPrice, type Instrument, type OrderBook } from '@htflow/market-data';
import type { Order, Position } from '@htflow/trading';
import { cumulativeDepth } from './analytics';
import { barLength, fitColumns, fitFontSize, fitRowHeight, nextCentre } from './autobalance';
import type { DomModel } from './model';
import {
  BUILTIN_TEMPLATES,
  columnDef,
  type DomColumnConfig,
  type DomColumnId,
  type DomTemplate,
} from './templates';

export interface DomFrame {
  book: OrderBook;
  model: DomModel;
  instrument: Instrument;
  lastPx: number;
  orders: readonly Order[];
  position: Position | null;
  /** Currency per tick per lot (for P&L at price). */
  pnlPerTick: number;
  /** User notes by price (ticks). */
  notes?: ReadonlyMap<number, string>;
  now: number;
  /** Order being dragged in the Orders column (preview at the target price). */
  drag?: { fromPx: number; toPx: number } | null;
}

export interface DomHit {
  column: DomColumnId;
  px: number;
  row: number;
}

export interface ColumnBox {
  id: DomColumnId;
  x: number;
  w: number;
}

export interface HeaderHit {
  id: DomColumnId;
  /** Pointer is on the right edge (resize handle). */
  edge: boolean;
  box: ColumnBox;
}

/** Abstract 2D surface so the renderer also runs headless (benchmarks, tests). */
export interface DomSurface {
  width: number;
  height: number;
  getContext(kind: '2d'): CanvasRenderingContext2D | null;
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Price an order sits at on the ladder: limit price for limits, trigger price otherwise. */
export const orderPx = (o: Pick<Order, 'type' | 'px' | 'stopPx'>): number | undefined =>
  o.type === 'limit' ? o.px : (o.stopPx ?? o.px);

/** Stop, stop-limit, MIT and trailing orders (triggered at a price) — shown as S / STP. */
export const isStopLike = (o: Pick<Order, 'type'>): boolean =>
  o.type !== 'limit' && o.type !== 'market';

const fmtSigned = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + formatCompact(Math.abs(v));

/**
 * Canvas Smart DOM ladder (P15). Rows are price groups around a centre price. Only the visible
 * rows are drawn (the ladder is virtual by construction) and the host calls `draw` at most once
 * per animation frame. Column order, widths, colours, font and row height come from a template.
 */
export class DomLadder {
  template: DomTemplate = BUILTIN_TEMPLATES[0]!;
  centerPx = Number.NaN;
  /** True while the user has scrolled away (auto / always centring paused). */
  paused = false;
  /** Ticks per row (price grouping 1, 2, 5, 10). */
  grouping = 1;
  /** Book levels drawn per side (Settings → DOM levels). 0 = all. */
  maxLevels = 0;
  /** Fit row height, font and column widths to the window (no clipped numbers, no sideways scroll). */
  autoFit = true;
  /** Override labels per column (e.g. "Vol (S)"). */
  labels: Partial<Record<DomColumnId, string>> = {};
  private width = 0;
  private height = 0;
  private dpr = 1;
  private boxes: ColumnBox[] = [];
  private scale = 1;
  private curFont = '';
  private rh = 0;
  private nRows = 1;
  private fs = 12;

  constructor(readonly canvas: DomSurface) {}

  setTemplate(t: DomTemplate): void {
    this.template = t;
    this.layoutColumns();
  }

  /** Displayed row height (the template's, grown / shrunk to fill the window when auto-fit is on). */
  get rowHeight(): number {
    return this.rh || this.template.style.rowHeight;
  }

  /** Font size actually drawn (never taller than the row allows). */
  get fontSize(): number {
    return this.fs;
  }

  get headerHeight(): number {
    return this.template.style.headerHeight;
  }

  resize(
    w: number,
    h: number,
    dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
  ): void {
    this.dpr = dpr;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.layoutColumns();
  }

  /** Visible columns with their pixel boxes (configured widths scaled to fill the canvas). */
  get layout(): readonly ColumnBox[] {
    return this.boxes;
  }

  /** Configured width → displayed width factor. */
  get widthScale(): number {
    return this.scale;
  }

  private layoutColumns(): void {
    const st = this.template.style;
    const vis = this.template.columns.filter((c) => c.visible);
    // Rows: the template's height, fitted so the ladder fills the window with an odd row count.
    const avail = this.height - st.headerHeight;
    if (this.autoFit && this.height > 0) {
      const fit = fitRowHeight(avail, st.rowHeight);
      this.rh = fit.rowHeight;
      this.nRows = fit.rows;
    } else {
      this.rh = st.rowHeight;
      this.nRows = Math.max(1, Math.floor(avail / st.rowHeight));
    }
    this.fs = this.autoFit ? fitFontSize(st.fontSize, this.rh) : st.fontSize;
    // Columns: drop the lowest-priority ones that cannot fit instead of scrolling sideways.
    const widths =
      this.autoFit && this.width > 0
        ? fitColumns(vis, this.width, this.fs)
        : (() => {
            const total = vis.reduce((a, c) => a + c.width, 0) || 1;
            const k = this.width > 0 ? this.width / total : 1;
            let used = 0;
            return vis.map((c, i) => {
              const w = i === vis.length - 1 ? this.width - used : Math.floor(c.width * k);
              used += w;
              return { id: c.id, w: Math.max(0, w) };
            });
          })();
    const kept = new Set(widths.map((w) => w.id));
    const total = vis.filter((c) => kept.has(c.id)).reduce((a, c) => a + c.width, 0) || 1;
    this.scale = this.width > 0 ? this.width / total : 1;
    let x = 0;
    this.boxes = widths.map((c) => {
      const r = { id: c.id as DomColumnId, x, w: c.w };
      x += r.w;
      return r;
    });
  }

  get rows(): number {
    return this.nRows;
  }

  scroll(rows: number): void {
    this.paused = true;
    if (!Number.isNaN(this.centerPx)) this.centerPx += rows * this.grouping;
  }

  recenter(): void {
    this.paused = false;
    this.centerPx = Number.NaN;
  }

  pxAtRow(r: number): number {
    const half = Math.floor(this.rows / 2);
    return this.centerPx + (half - r) * this.grouping;
  }

  rowOfPx(px: number): number {
    const half = Math.floor(this.rows / 2);
    return (
      half -
      Math.round((Math.floor(px / this.grouping) * this.grouping - this.centerPx) / this.grouping)
    );
  }

  hitTest(x: number, y: number): DomHit | null {
    if (y < this.headerHeight || Number.isNaN(this.centerPx)) return null;
    const row = Math.floor((y - this.headerHeight) / this.rowHeight);
    if (row >= this.rows) return null;
    const col = this.boxes.find((c) => x >= c.x && x < c.x + c.w);
    if (!col) return null;
    return { column: col.id, px: this.pxAtRow(row), row };
  }

  headerHit(x: number, y: number): HeaderHit | null {
    if (y >= this.headerHeight) return null;
    for (const b of this.boxes) {
      if (x >= b.x && x < b.x + b.w) {
        return { id: b.id, edge: x >= b.x + b.w - 5, box: b };
      }
    }
    return null;
  }

  /** Column whose box contains x (for drag-to-reorder drops). */
  columnAtX(x: number): ColumnBox | null {
    return this.boxes.find((b) => x >= b.x && x < b.x + b.w) ?? null;
  }

  private updateCentre(ref: number): void {
    const g = this.grouping;
    const style = this.template.style;
    if (style.centring === 'auto') {
      // Legacy band mode: re-centre when price leaves the middle band of the ladder.
      if (Number.isNaN(ref)) return;
      const snapped = Math.round(ref / g) * g;
      if (Number.isNaN(this.centerPx)) this.centerPx = snapped;
      else if (!this.paused) {
        const band = Math.max(1, Math.floor(this.rows * style.centreBand)) * g;
        if (Math.abs(ref - this.centerPx) > band) this.centerPx = snapped;
      }
      return;
    }
    const mode =
      style.centring === 'always' ? 'always' : style.centring === 'manual' ? 'off' : 'out-of-view';
    this.centerPx = nextCentre({
      mode,
      centre: this.centerPx,
      ref,
      rows: this.rows,
      g,
      paused: this.paused,
    });
  }

  private font(ctx: CanvasRenderingContext2D, weight: number, size: number): void {
    const f = `${weight} ${size}px "${this.template.style.fontFamily}", "Segoe UI", sans-serif`;
    if (f !== this.curFont) {
      ctx.font = f;
      this.curFont = f;
    }
  }

  draw(f: DomFrame): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || this.width < 10) return;
    this.curFont = '';
    const t = this.template;
    const st = t.style;
    const p = st.palette;
    const fs = this.fs;
    const { book, model } = f;
    const g = this.grouping;
    const ref = !Number.isNaN(f.lastPx) ? f.lastPx : book.mid;
    this.updateCentre(ref);
    const hh = this.headerHeight;
    const rh = this.rowHeight;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.textBaseline = 'middle';
    const cfg = new Map<DomColumnId, DomColumnConfig>(t.columns.map((c) => [c.id, c]));

    // Header.
    ctx.fillStyle = p.header;
    ctx.fillRect(0, 0, this.width, hh);
    this.font(ctx, 500, Math.max(8, fs - 1));
    ctx.textAlign = 'center';
    const pos = f.position && f.position.qty !== 0 ? f.position : null;
    const openPnl =
      pos && !Number.isNaN(f.lastPx) ? (f.lastPx - pos.avgPx) * f.pnlPerTick * pos.qty : Number.NaN;
    for (const b of this.boxes) {
      let label = this.labels[b.id] ?? columnDef(b.id).label;
      ctx.fillStyle = p.headerText;
      if (b.id === 'orders' && !Number.isNaN(openPnl)) {
        label = `${openPnl >= 0 ? '+' : ''}${openPnl.toFixed(2)}`;
        ctx.fillStyle = openPnl >= 0 ? p.buy : p.sell;
      }
      ctx.fillText(label, b.x + b.w / 2, hh / 2, Math.max(4, b.w - 4));
      ctx.fillStyle = p.grid;
      ctx.fillRect(b.x + b.w - 1, 4, 1, hh - 8);
    }
    ctx.fillStyle = p.grid;
    ctx.fillRect(0, hh - 1, this.width, 1);
    if (Number.isNaN(this.centerPx)) return;

    const rows = this.rows;
    const topPx = this.pxAtRow(0) + g - 1;
    const botPx = this.pxAtRow(rows - 1);
    const sizeAt = (m: ReadonlyMap<number, number>, px: number) => {
      if (g === 1) return m.get(px) ?? 0;
      let s = 0;
      for (let k = 0; k < g; k++) s += m.get(px + k) ?? 0;
      return s;
    };
    const has = (id: DomColumnId) => this.boxes.some((b) => b.id === id);
    const lim = this.maxLevels;
    const bidAt = (px: number) =>
      lim > 0 && px <= book.bestBid - lim * g ? 0 : sizeAt(book.bids, px);
    const askAt = (px: number) =>
      lim > 0 && px >= book.bestAsk + lim * g ? 0 : sizeAt(book.asks, px);
    const vol = model.volume;
    let maxBook = 0;
    let maxVol = 0;
    let maxRecent = 0;
    let maxDelta = 0;
    for (let r = 0; r < rows; r++) {
      const px = this.pxAtRow(r);
      maxBook = Math.max(maxBook, bidAt(px), askAt(px));
      maxVol = Math.max(maxVol, sizeAt(vol, px));
      maxRecent = Math.max(maxRecent, sizeAt(model.recentBuys, px), sizeAt(model.recentSells, px));
      if (has('delta')) {
        let d = 0;
        for (let k = 0; k < g; k++) d += model.deltaAt(px + k);
        maxDelta = Math.max(maxDelta, Math.abs(d));
      }
    }
    const cum =
      has('cumBid') || has('cumAsk') ? cumulativeDepth(book.bids, book.asks, botPx, topPx) : null;
    const cumAt = (side: 'bid' | 'ask', px: number) => {
      if (!cum) return 0;
      // Group row: bid total down to the lowest tick of the group, ask total up to the highest.
      const i = side === 'bid' ? px - cum.lo : px + g - 1 - cum.lo;
      const arr = side === 'bid' ? cum.bid : cum.ask;
      return i >= 0 && i < arr.length ? arr[i]! : 0;
    };
    let maxCum = 0;
    if (cum) {
      const bb = book.bestBid;
      const ba = book.bestAsk;
      for (let r = 0; r < rows; r++) {
        const px = this.pxAtRow(r);
        if (px <= bb) maxCum = Math.max(maxCum, cumAt('bid', px));
        if (px + g - 1 >= ba) maxCum = Math.max(maxCum, cumAt('ask', px));
      }
    }
    const va = has('vapoc') ? model.valueArea() : null;
    const ordersAt = new Map<number, Order[]>();
    for (const o of f.orders) {
      const opx = orderPx(o);
      if (opx === undefined) continue;
      const k = Math.floor(opx / g) * g;
      const arr = ordersAt.get(k);
      if (arr) arr.push(o);
      else ordersAt.set(k, [o]);
    }
    const groupFind = <T>(m: ReadonlyMap<number, T> | undefined, px: number): T | undefined => {
      if (!m) return undefined;
      for (let k = 0; k < g; k++) {
        const v = m.get(px + k);
        if (v !== undefined) return v;
      }
      return undefined;
    };
    const bestBid = book.bestBid;
    const bestAsk = book.bestAsk;
    const lastRow = Math.floor(f.lastPx / g) * g;
    const big = t.behaviour.bigSize;
    const lastFadeMs = Math.max(2000, t.behaviour.recentSeconds * 1000);

    for (let r = 0; r < rows; r++) {
      const px = this.pxAtRow(r);
      const y = hh + r * rh;
      const h = rh - 1;
      const midY = y + h / 2;
      const bid = bidAt(px);
      const ask = askAt(px);
      const isAskSide = px + g - 1 >= bestAsk;
      const isBidSide = px <= bestBid;
      for (const b of this.boxes) {
        const c = cfg.get(b.id)!;
        const cx = b.x;
        const cw = b.w - 1;
        const fg = c.fg ?? p.text;
        ctx.fillStyle = c.bg ?? (r % 2 && st.gridLines ? p.rowAlt : p.bg);
        ctx.fillRect(cx, y, cw, h);
        switch (b.id) {
          case 'orders': {
            const os = ordersAt.get(px);
            const dragged = f.drag && Math.floor(f.drag.fromPx / g) * g === px;
            if (os?.length && !dragged) {
              const q = os.reduce((a, o) => a + (o.qty - o.filled), 0);
              const buy = os[0]!.side === 'buy';
              ctx.fillStyle = c.accent ?? p.order;
              ctx.fillRect(cx + cw - 5, y + 2, 3, h - 4);
              ctx.fillStyle = buy ? p.buy : p.sell;
              this.font(ctx, 600, fs);
              ctx.textAlign = 'right';
              const kind = os.some(isStopLike) ? 'S' : 'L';
              ctx.fillText(`${kind} ${formatCompact(q)}`, cx + cw - 9, midY, cw - 10);
            } else if (pos && Math.floor(pos.avgPx / g) * g === px) {
              ctx.fillStyle = p.position;
              this.font(ctx, 600, fs - 1);
              ctx.textAlign = 'right';
              ctx.fillText(`AVG ${pos.qty > 0 ? '+' : ''}${pos.qty}`, cx + cw - 5, midY, cw - 6);
            }
            if (f.drag && Math.floor(f.drag.toPx / g) * g === px) {
              ctx.strokeStyle = c.accent ?? p.order;
              ctx.setLineDash([3, 2]);
              ctx.strokeRect(cx + 1.5, y + 1.5, cw - 3, h - 3);
              ctx.setLineDash([]);
            }
            break;
          }
          case 'limits': {
            const l = groupFind(model.limits, px);
            if (l) {
              const q = l.buyQty - l.sellQty;
              ctx.fillStyle = rgba(c.accent ?? p.order, 0.18);
              ctx.fillRect(cx, y, cw, h);
              this.font(ctx, 600, fs - 1);
              ctx.textAlign = 'left';
              ctx.fillStyle = q >= 0 ? p.buy : p.sell;
              ctx.fillText(`${q >= 0 ? 'B' : 'S'} ${formatCompact(Math.abs(q))}`, cx + 4, midY);
              if (!Number.isNaN(l.ahead)) {
                ctx.textAlign = 'right';
                ctx.fillStyle = c.fg ?? p.textDim;
                ctx.fillText(`Q ${formatCompact(l.ahead)}`, cx + cw - 4, midY);
              }
            }
            break;
          }
          case 'markers': {
            const stops = ordersAt.get(px)?.filter(isStopLike);
            const ice = model.iceberg('bid', px) ?? model.iceberg('ask', px);
            this.font(ctx, 600, fs - 1);
            if (ice) {
              ctx.fillStyle = rgba(c.accent ?? p.iceberg, 0.22);
              ctx.fillRect(cx, y, cw, h);
              ctx.fillStyle = c.accent ?? p.iceberg;
              ctx.textAlign = 'left';
              ctx.fillText(`◆${ice.refills}× ${formatCompact(ice.hidden)}`, cx + 4, midY, cw - 6);
            } else if (stops?.length) {
              const q = stops.reduce((a, o) => a + o.qty - o.filled, 0);
              ctx.fillStyle = stops[0]!.side === 'buy' ? p.buy : p.sell;
              ctx.textAlign = 'left';
              ctx.fillText(`STP ${formatCompact(q)}`, cx + 4, midY, cw - 6);
            }
            break;
          }
          case 'notes': {
            const n = groupFind(f.notes, px);
            if (n) {
              ctx.fillStyle = c.accent ? rgba(c.accent, 0.15) : rgba(p.note, 0.12);
              ctx.fillRect(cx, y, cw, h);
              ctx.fillStyle = c.fg ?? p.note;
              this.font(ctx, 500, fs - 1);
              ctx.textAlign = 'left';
              ctx.fillText(n, cx + 4, midY, cw - 6);
            }
            break;
          }
          case 'pnl': {
            if (pos) {
              const v = (px - pos.avgPx) * f.pnlPerTick * pos.qty;
              ctx.fillStyle = v >= 0 ? p.buy : p.sell;
              this.font(ctx, px === lastRow ? 700 : 400, fs - 1);
              ctx.textAlign = 'right';
              ctx.fillText(fmtSigned(Math.round(v * 100) / 100), cx + cw - 4, midY, cw - 6);
            }
            break;
          }
          case 'volume': {
            const v = sizeAt(vol, px);
            if (v > 0 && maxVol > 0) {
              const k = v / maxVol;
              ctx.fillStyle = rgba(c.accent ?? p.volume, va && px === va.poc ? 1 : 0.85);
              ctx.fillRect(cx + 1, y + 2, Math.max(1, k * (cw - 2)), h - 4);
              ctx.fillStyle = fg;
              this.font(ctx, k > 0.8 ? 600 : 400, fs - 1);
              ctx.textAlign = 'left';
              ctx.fillText(formatCompact(v), cx + 4, midY, cw - 6);
            }
            break;
          }
          case 'delta': {
            let d = 0;
            for (let k = 0; k < g; k++) d += model.deltaAt(px + k);
            if (d !== 0) {
              const k = maxDelta > 0 ? Math.abs(d) / maxDelta : 0;
              ctx.fillStyle = rgba(d > 0 ? p.buy : p.sell, 0.15 + k * 0.45);
              const w = Math.max(1, k * (cw - 2));
              ctx.fillRect(d > 0 ? cx + 1 : cx + cw - 1 - w, y + 2, w, h - 4);
              ctx.fillStyle = c.fg ?? (d > 0 ? p.buy : p.sell);
              this.font(ctx, 500, fs - 1);
              ctx.textAlign = 'center';
              ctx.fillText(fmtSigned(d), cx + cw / 2, midY, cw - 4);
            }
            break;
          }
          case 'lastSize': {
            let lp: { qty: number; side: string; ts: number } | undefined;
            for (let k = 0; k < g; k++) {
              const e = model.lastPrint.get(px + k);
              if (e && (!lp || e.ts > lp.ts)) lp = e;
            }
            if (lp) {
              const age = f.now - lp.ts;
              if (age < lastFadeMs) {
                const a = Math.max(0.25, 1 - age / lastFadeMs);
                const col = lp.side === 'buy' ? p.buy : lp.side === 'sell' ? p.sell : p.textDim;
                if (px === lastRow) {
                  ctx.fillStyle = rgba(c.accent ?? col, 0.3);
                  ctx.fillRect(cx, y, cw, h);
                }
                ctx.globalAlpha = a;
                ctx.fillStyle = c.fg ?? col;
                this.font(ctx, px === lastRow ? 700 : 500, fs);
                ctx.textAlign = 'center';
                ctx.fillText(formatCompact(lp.qty), cx + cw / 2, midY, cw - 4);
                ctx.globalAlpha = 1;
              }
            }
            break;
          }
          case 'vapoc': {
            if (va && !Number.isNaN(va.poc)) {
              const top = px + g - 1;
              if (top >= va.val && px <= va.vah) {
                ctx.fillStyle = c.accent ?? p.va;
                ctx.fillRect(cx + 2, y, cw - 4, rh);
              }
              this.font(ctx, 700, Math.max(8, fs - 3));
              ctx.textAlign = 'center';
              if (va.poc >= px && va.poc <= top) {
                ctx.fillStyle = p.poc;
                ctx.fillRect(cx + 1, y + 1, cw - 2, h - 2);
                ctx.fillStyle = p.bg;
                ctx.fillText('POC', cx + cw / 2, midY, cw - 2);
              } else if (va.vah >= px && va.vah <= top) {
                ctx.fillStyle = c.fg ?? p.text;
                ctx.fillText('VAH', cx + cw / 2, midY, cw - 2);
              } else if (va.val >= px && va.val <= top) {
                ctx.fillStyle = c.fg ?? p.text;
                ctx.fillText('VAL', cx + cw / 2, midY, cw - 2);
              }
            }
            break;
          }
          case 'cumBid':
          case 'cumAsk': {
            const side = b.id === 'cumBid' ? 'bid' : 'ask';
            const show = side === 'bid' ? isBidSide : isAskSide;
            if (show) {
              const v = cumAt(side, px);
              if (v > 0) {
                const tint = c.accent ?? (side === 'bid' ? p.bid : p.ask);
                const w = maxCum > 0 ? Math.max(1, (v / maxCum) * (cw - 2)) : 0;
                ctx.fillStyle = rgba(tint, 0.22);
                if (side === 'bid') ctx.fillRect(cx + cw - 1 - w, y + 2, w, h - 4);
                else ctx.fillRect(cx + 1, y + 2, w, h - 4);
                ctx.fillStyle = fg;
                this.font(ctx, 400, fs - 1);
                ctx.textAlign = 'center';
                ctx.fillText(formatCompact(Math.round(v * 1000) / 1000), cx + cw / 2, midY, cw - 4);
              }
            }
            break;
          }
          case 'price': {
            const isLast = px === lastRow;
            ctx.fillStyle = isLast ? (c.accent ?? p.lastBg) : (c.bg ?? p.priceBg);
            ctx.fillRect(cx, y, cw, h);
            ctx.fillStyle = fg;
            this.font(ctx, isLast ? 700 : 600, fs);
            ctx.textAlign = 'center';
            ctx.fillText(formatPrice(px, f.instrument), cx + cw / 2, midY, cw - 4);
            if (groupFind(f.notes, px) && !has('notes')) {
              ctx.fillStyle = p.note;
              ctx.fillRect(cx + 2, y + 3, 3, 3);
            }
            break;
          }
          case 'bid':
          case 'ask': {
            const side = b.id;
            const size = side === 'bid' ? bid : ask;
            const tint = c.accent ?? (side === 'bid' ? p.bid : p.ask);
            if (!c.bg) {
              ctx.fillStyle = rgba(tint, (side === 'bid' ? isBidSide : isAskSide) ? 0.08 : 0.03);
              ctx.fillRect(cx, y, cw, h);
            }
            if (size > 0) {
              const isBig = big > 0 && size >= big;
              const w = barLength(size, maxBook, cw);
              ctx.fillStyle = isBig ? tint : rgba(tint, 0.6);
              if (side === 'bid') ctx.fillRect(cx + cw - w, y + 1, w, h - 2);
              else ctx.fillRect(cx, y + 1, w, h - 2);
              ctx.fillStyle = fg;
              this.font(ctx, isBig ? 700 : 500, fs);
              ctx.textAlign = side === 'bid' ? 'right' : 'left';
              ctx.fillText(formatCompact(size), side === 'bid' ? cx + cw - 5 : cx + 5, midY);
            }
            let fl = undefined as ReturnType<DomModel['flash']>;
            for (let k = 0; k < g && !fl; k++) fl = model.flash(side, px + k);
            if (fl) {
              const life = 1 - Math.min(1, (f.now - fl.at) / Math.max(1, t.behaviour.flashMs));
              const col = fl.kind === 'pulled' ? p.pulled : p.stacked;
              ctx.strokeStyle = rgba(col, 0.4 + 0.6 * life);
              ctx.lineWidth = 2;
              ctx.strokeRect(cx + 1, y + 1, cw - 2, h - 2);
              ctx.lineWidth = 1;
              ctx.fillStyle = rgba(col, 0.25 * life);
              ctx.fillRect(cx, y, cw, h);
              ctx.fillStyle = col;
              this.font(ctx, 700, Math.max(8, fs - 2));
              ctx.textAlign = side === 'bid' ? 'left' : 'right';
              ctx.fillText(fmtSigned(fl.amount), side === 'bid' ? cx + 4 : cx + cw - 4, midY);
            }
            const ice = model.iceberg(side, px);
            if (ice) {
              ctx.fillStyle = p.iceberg;
              this.font(ctx, 700, Math.max(8, fs - 2));
              ctx.textAlign = side === 'bid' ? 'left' : 'right';
              ctx.fillText('◆', side === 'bid' ? cx + 3 : cx + cw - 3, midY);
            }
            break;
          }
          case 'sells':
          case 'buys': {
            const m = b.id === 'sells' ? model.recentSells : model.recentBuys;
            const v = sizeAt(m, px);
            if (v > 0) {
              const k = maxRecent > 0 ? v / maxRecent : 0;
              ctx.fillStyle = rgba(c.accent ?? (b.id === 'sells' ? p.sell : p.buy), 0.2 + k * 0.5);
              ctx.fillRect(cx, y, cw, h);
              ctx.fillStyle = fg;
              this.font(ctx, k > 0.6 ? 700 : 400, fs);
              ctx.textAlign = 'center';
              ctx.fillText(formatCompact(v), cx + cw / 2, midY, cw - 4);
            }
            break;
          }
          case 'bidChg':
          case 'askChg': {
            let ch = 0;
            for (let k = 0; k < g; k++)
              ch +=
                b.id === 'bidChg' ? model.bidChange(px + k, book) : model.askChange(px + k, book);
            if (Math.abs(ch) > 1e-9) {
              ctx.fillStyle = c.fg ?? (ch > 0 ? p.text : p.textDim);
              this.font(ctx, 400, fs - 1);
              ctx.textAlign = 'center';
              ctx.fillText(fmtSigned(Math.round(ch * 1000) / 1000), cx + cw / 2, midY, cw - 4);
            }
            break;
          }
        }
        if (st.gridLines) {
          ctx.fillStyle = p.grid;
          ctx.fillRect(cx + cw, y, 1, rh);
        }
      }
      if (st.gridLines) {
        ctx.fillStyle = p.grid;
        ctx.fillRect(0, y + rh - 1, this.width, 1);
      }
      // Spread line between best bid and best ask.
      if (px === Math.floor(bestBid / g) * g) {
        ctx.fillStyle = p.spread;
        ctx.fillRect(0, y - 1, this.width, 2);
      }
    }
  }
}
