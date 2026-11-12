import type { ChartLayer, ChartView } from '@htflow/chart-engine';
import type { Proj } from './proj';
import { dashArray, textBox, type Shape } from './shapes';
import { shapesBounds } from './selection';
import { toolDef, type Handle } from './tools';
import type { Drawing } from './types';

function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  if (h.length < 6) return hex;
  const n = parseInt(h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function arrowHead(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  const s = 8;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - s * Math.cos(a - 0.4), y1 - s * Math.sin(a - 0.4));
  ctx.lineTo(x1 - s * Math.cos(a + 0.4), y1 - s * Math.sin(a + 0.4));
  ctx.closePath();
  ctx.fill();
}

export function drawShape(v: ChartView, s: Shape, P: Proj): void {
  const ctx = v.ctx;
  switch (s.k) {
    case 'path': {
      if (s.pts.length < 4) return;
      ctx.beginPath();
      ctx.moveTo(s.pts[0]!, s.pts[1]!);
      for (let i = 2; i < s.pts.length; i += 2) ctx.lineTo(s.pts[i]!, s.pts[i + 1]!);
      if (s.closed) ctx.closePath();
      if (s.fill && (s.fillAlpha ?? 1) > 0) {
        ctx.fillStyle = rgba(s.fill, s.fillAlpha ?? 1);
        ctx.fill();
      }
      if (s.stroke) {
        ctx.strokeStyle = rgba(s.stroke, s.alpha ?? 1);
        ctx.lineWidth = s.width ?? 1;
        ctx.setLineDash(dashArray(s.dash, s.width));
        ctx.stroke();
        ctx.setLineDash([]);
        if (s.arrow) {
          const n = s.pts.length;
          ctx.fillStyle = rgba(s.stroke, s.alpha ?? 1);
          if (s.arrow & 1)
            arrowHead(ctx, s.pts[n - 4]!, s.pts[n - 3]!, s.pts[n - 2]!, s.pts[n - 1]!);
          if (s.arrow & 2) arrowHead(ctx, s.pts[2]!, s.pts[3]!, s.pts[0]!, s.pts[1]!);
        }
      }
      return;
    }
    case 'ellipse': {
      ctx.beginPath();
      ctx.ellipse(
        s.cx,
        s.cy,
        Math.max(0.5, s.rx),
        Math.max(0.5, s.ry),
        0,
        s.a0 ?? 0,
        s.a1 ?? Math.PI * 2,
      );
      if (s.fill && (s.fillAlpha ?? 1) > 0) {
        ctx.fillStyle = rgba(s.fill, s.fillAlpha ?? 1);
        ctx.fill();
      }
      if (s.stroke) {
        ctx.strokeStyle = rgba(s.stroke, s.alpha ?? 1);
        ctx.lineWidth = s.width ?? 1;
        ctx.setLineDash(dashArray(s.dash, s.width));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      return;
    }
    case 'text': {
      const b = textBox(s, P.measure);
      const pad = s.pad ?? (s.bg ? 4 : 0);
      if (s.bg) {
        ctx.fillStyle = rgba(s.bg, s.bgAlpha ?? 1);
        ctx.fillRect(b.x, b.y, b.w, b.h);
      }
      if (s.border) {
        ctx.strokeStyle = s.border;
        ctx.lineWidth = 1;
        ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
      }
      ctx.font = v.font(s.size, s.weight ?? 400);
      ctx.fillStyle = rgba(s.color, s.alpha ?? 1);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const lh = s.size * 1.3;
      s.text.split('\n').forEach((line, i) => {
        ctx.fillText(line, b.x + pad, b.y + pad + lh * (i + 0.5));
      });
      return;
    }
    case 'marker': {
      const r = s.size / 2;
      const { x, y } = s;
      ctx.fillStyle = rgba(s.color, s.alpha ?? 1);
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 2;
      ctx.beginPath();
      switch (s.m) {
        case 'dot':
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'square':
          ctx.fillRect(x - r, y - r, s.size, s.size);
          break;
        case 'diamond':
          ctx.moveTo(x, y - r);
          ctx.lineTo(x + r, y);
          ctx.lineTo(x, y + r);
          ctx.lineTo(x - r, y);
          ctx.fill();
          break;
        case 'arrow-up':
        case 'arrow-down': {
          const d = s.m === 'arrow-up' ? 1 : -1;
          ctx.moveTo(x, y - d * r);
          ctx.lineTo(x + r, y);
          ctx.lineTo(x + r * 0.35, y);
          ctx.lineTo(x + r * 0.35, y + d * r);
          ctx.lineTo(x - r * 0.35, y + d * r);
          ctx.lineTo(x - r * 0.35, y);
          ctx.lineTo(x - r, y);
          ctx.fill();
          break;
        }
        case 'checkmark':
          ctx.moveTo(x - r, y);
          ctx.lineTo(x - r * 0.3, y + r * 0.7);
          ctx.lineTo(x + r, y - r * 0.7);
          ctx.stroke();
          break;
        case 'cross':
          ctx.moveTo(x - r, y - r);
          ctx.lineTo(x + r, y + r);
          ctx.moveTo(x + r, y - r);
          ctx.lineTo(x - r, y + r);
          ctx.stroke();
          break;
        case 'star':
          for (let i = 0; i < 10; i++) {
            const rr = i % 2 ? r * 0.45 : r;
            const a = -Math.PI / 2 + (i * Math.PI) / 5;
            ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
          }
          ctx.fill();
          break;
        case 'flag':
          ctx.moveTo(x - r * 0.6, y + r);
          ctx.lineTo(x - r * 0.6, y - r);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x - r * 0.6, y - r);
          ctx.lineTo(x + r, y - r * 0.5);
          ctx.lineTo(x - r * 0.6, y);
          ctx.fill();
          break;
        case 'emoji':
          ctx.font = v.font(s.size);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(s.text ?? '⭐', x, y);
          break;
      }
      return;
    }
  }
}

/** Handles of a drawing (tool-specific, or its anchors), kept inside the plot. */
export function handlesOf(d: Drawing, P: Proj): Handle[] {
  const def = toolDef(d.type);
  if (!def) return [];
  if (def.handles) return def.handles(d, P);
  return d.anchors.map((a, key) => ({ x: P.x(a.t), y: P.y(a.px), key }));
}

export interface LayerSource {
  /** Visible drawings in z order (including the one being created / dragged). */
  list(): Drawing[];
  selected(): string | null;
  /** Every selected id (multi-selection); defaults to `selected()`. */
  selectedIds?(): string[];
  /** Rubber-band rectangle in plot px while Ctrl+dragging. */
  box?(): { x0: number; y0: number; x1: number; y1: number } | null;
  proj(v: ChartView): Proj;
}

/** ChartLayer that renders all drawings of one chart window. */
export class DrawingsLayer implements ChartLayer {
  readonly id = 'drawings';
  constructor(private src: LayerSource) {}

  draw(v: ChartView): void {
    const list = this.src.list();
    const box = this.src.box?.() ?? null;
    if (!list.length && !box) return;
    const P = this.src.proj(v);
    const ctx = v.ctx;
    const sel = this.src.selected();
    const multi = new Set(this.src.selectedIds?.() ?? (sel ? [sel] : []));
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, v.plot.y, v.plot.w, v.plot.h);
    ctx.clip();
    ctx.lineJoin = 'round';
    for (const d of list) {
      const def = toolDef(d.type);
      if (!def) continue;
      for (const s of def.build(d, P)) drawShape(v, s, P);
      if (multi.size > 1 && multi.has(d.id)) {
        const b = shapesBounds(def.build(d, P), P);
        if (b) {
          ctx.save();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 1;
          ctx.strokeRect(b.x0 - 3, b.y0 - 3, b.x1 - b.x0 + 6, b.y1 - b.y0 + 6);
          ctx.restore();
        }
      } else if (d.id === sel) {
        for (const h of handlesOf(d, P)) {
          ctx.beginPath();
          ctx.arc(h.x, h.y, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = v.palette.chartBg;
          ctx.fill();
          ctx.strokeStyle = d.locked ? v.palette.textTertiary : '#FFFFFF';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      if (d.showLabels && !def.screen) {
        const l = def.labels
          ? def.labels(d)
          : { px: d.anchors.map((a) => a.px), t: d.anchors.map((a) => a.t) };
        for (const px of l.px) {
          if (v.priceAxis.w > 0)
            v.tags.push({ px, bg: d.style.color, fg: '#000000', text: P.fmtPrice(px) });
          else
            drawShape(
              v,
              {
                k: 'text',
                x: v.plot.x + v.plot.w - 4,
                y: v.yOf(px),
                text: P.fmtPrice(px),
                size: 10,
                color: '#000000',
                align: 'right',
                base: 'middle',
                bg: d.style.color,
                pad: 3,
              },
              P,
            );
        }
        for (const t of l.t)
          drawShape(
            v,
            {
              k: 'text',
              x: P.x(t),
              y: v.plot.y + v.plot.h - 3,
              text: P.fmtTime(t),
              size: 10,
              color: '#000000',
              align: 'center',
              base: 'bottom',
              bg: d.style.color,
              pad: 3,
            },
            P,
          );
      }
    }
    if (box) {
      const x = Math.min(box.x0, box.x1);
      const y = Math.min(box.y0, box.y1);
      const w = Math.abs(box.x1 - box.x0);
      const h = Math.abs(box.y1 - box.y0);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(x, y, w, h);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#FFFFFF';
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }
}
