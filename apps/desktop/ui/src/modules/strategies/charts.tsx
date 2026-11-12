import { useEffect, useRef, useState } from 'react';
import type { BacktestResult, Heatmap } from '@htflow/strategy';
import { cssVar, money } from './shared';

export interface ResultStyle {
  equity: string;
  drawdown: string;
  heatLow: string;
  heatHigh: string;
}

export const DEFAULT_STYLE: ResultStyle = {
  equity: '#FFFFFF',
  drawdown: '#F04A5D',
  heatLow: '#F04A5D',
  heatHigh: '#20C77A',
};

function useCanvas(
  draw: (g: CanvasRenderingContext2D, w: number, h: number) => void,
  deps: unknown[],
) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const paint = () => {
      const w = c.clientWidth;
      const h = c.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      const g = c.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      draw(g, w, h);
    };
    paint();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(paint);
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/** Equity (balance + open P&L at each bar close) with the drawdown band underneath. */
export function EquityCanvas({ result, style }: { result: BacktestResult; style: ResultStyle }) {
  const ref = useCanvas(
    (g, w, h) => {
      const pts = result.equity;
      const grid = cssVar('--ht-divider', '#1c1c1c');
      const text = cssVar('--ht-text-tertiary', '#5E5E5E');
      const pad = { l: 8, r: 70, t: 10, b: 18 };
      const ddH = Math.round((h - pad.t - pad.b) * 0.28);
      const eqH = h - pad.t - pad.b - ddH - 8;
      g.font = '10px Geist, sans-serif';
      g.textBaseline = 'middle';
      if (pts.length < 2) {
        g.fillStyle = text;
        g.fillText('Not enough bars for a curve', pad.l, h / 2);
        return;
      }
      const start = result.config.startingBalance;
      let lo = start;
      let hi = start;
      let ddMin = 0;
      for (const p of pts) {
        lo = Math.min(lo, p.equity);
        hi = Math.max(hi, p.equity);
        ddMin = Math.min(ddMin, p.drawdown);
      }
      const span = hi - lo || 1;
      const x = (i: number) => pad.l + (i / (pts.length - 1)) * (w - pad.l - pad.r);
      const y = (v: number) => pad.t + (1 - (v - lo) / span) * eqH;
      const ddTop = pad.t + eqH + 8;
      const yd = (v: number) => ddTop + (ddMin < 0 ? (v / ddMin) * ddH : 0);
      g.strokeStyle = grid;
      g.lineWidth = 1;
      g.fillStyle = text;
      for (let k = 0; k <= 4; k++) {
        const v = lo + (span * k) / 4;
        const yy = Math.round(y(v)) + 0.5;
        g.beginPath();
        g.moveTo(pad.l, yy);
        g.lineTo(w - pad.r, yy);
        g.stroke();
        g.fillText(money(v), w - pad.r + 6, yy);
      }
      // Starting balance reference.
      g.setLineDash([2, 4]);
      g.beginPath();
      g.moveTo(pad.l, y(start));
      g.lineTo(w - pad.r, y(start));
      g.stroke();
      g.setLineDash([]);
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(x(i), y(p.equity)) : g.moveTo(x(i), y(p.equity))));
      g.strokeStyle = style.equity;
      g.lineWidth = 1.5;
      g.stroke();
      // Drawdown band.
      g.beginPath();
      g.moveTo(x(0), ddTop);
      pts.forEach((p, i) => g.lineTo(x(i), yd(p.drawdown)));
      g.lineTo(x(pts.length - 1), ddTop);
      g.closePath();
      g.globalAlpha = 0.35;
      g.fillStyle = style.drawdown;
      g.fill();
      g.globalAlpha = 1;
      g.fillStyle = text;
      g.fillText('Drawdown', pad.l + 2, ddTop + 8);
      g.fillText(money(ddMin), w - pad.r + 6, ddTop + ddH);
      const d0 = new Date(pts[0]!.t);
      const d1 = new Date(pts[pts.length - 1]!.t);
      g.textBaseline = 'bottom';
      g.fillText(d0.toISOString().slice(5, 16).replace('T', ' '), pad.l, h - 2);
      g.textAlign = 'right';
      g.fillText(d1.toISOString().slice(5, 16).replace('T', ' '), w - pad.r, h - 2);
      g.textAlign = 'left';
    },
    [result, style],
  );
  return <canvas ref={ref} className="stg-canvas" data-testid="strategy-equity" />;
}

function mix(a: string, b: string, t: number): string {
  const p = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a);
  const [r2, g2, b2] = p(b);
  const f = (u: number, v: number) => Math.round(u + (v - u) * t);
  return `rgb(${f(r1!, r2!)},${f(g1!, g2!)},${f(b1!, b2!)})`;
}

/** Two-parameter optimisation heatmap; click a cell to pick its inputs. */
export function HeatmapCanvas({
  map,
  style,
  format,
  onPick,
}: {
  map: Heatmap;
  style: ResultStyle;
  format(v: number): string;
  onPick(x: number, y: number): void;
}) {
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const geo = useRef({ l: 48, t: 8, cw: 1, ch: 1 });
  const ref = useCanvas(
    (g, w, h) => {
      const l = 52;
      const t = 8;
      const b = 22;
      const r = 8;
      const nx = map.xs.length;
      const ny = map.ys.length;
      if (!nx || !ny) return;
      const cw = (w - l - r) / nx;
      const ch = (h - t - b) / ny;
      geo.current = { l, t, cw, ch };
      const text = cssVar('--ht-text-secondary', '#9a9a9a');
      const empty = cssVar('--ht-surface2', '#141414');
      g.font = '10px Geist, sans-serif';
      const span = map.max - map.min || 1;
      for (let yi = 0; yi < ny; yi++)
        for (let xi = 0; xi < nx; xi++) {
          const v = map.cells[yi]![xi]!;
          const px = l + xi * cw;
          const py = t + (ny - 1 - yi) * ch;
          g.fillStyle = Number.isNaN(v)
            ? empty
            : mix(style.heatLow, style.heatHigh, (v - map.min) / span);
          g.fillRect(px + 0.5, py + 0.5, cw - 1, ch - 1);
          if (cw > 44 && ch > 16 && !Number.isNaN(v)) {
            g.fillStyle = '#000';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText(format(v), px + cw / 2, py + ch / 2);
          }
        }
      if (hover) {
        g.strokeStyle = '#fff';
        g.lineWidth = 1.5;
        g.strokeRect(l + hover.x * cw + 1, t + (ny - 1 - hover.y) * ch + 1, cw - 2, ch - 2);
      }
      g.fillStyle = text;
      g.textAlign = 'center';
      g.textBaseline = 'top';
      const stepX = Math.ceil(nx / Math.max(1, Math.floor((w - l) / 40)));
      map.xs.forEach(
        (v, i) => i % stepX === 0 && g.fillText(String(v), l + (i + 0.5) * cw, h - b + 5),
      );
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      const stepY = Math.ceil(ny / Math.max(1, Math.floor((h - b) / 16)));
      map.ys.forEach(
        (v, i) => i % stepY === 0 && g.fillText(String(v), l - 6, t + (ny - 1 - i + 0.5) * ch),
      );
    },
    [map, style, hover],
  );
  const cellAt = (e: React.MouseEvent) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const { l, t, cw, ch } = geo.current;
    const xi = Math.floor((e.clientX - rect.left - l) / cw);
    const yi = map.ys.length - 1 - Math.floor((e.clientY - rect.top - t) / ch);
    return xi >= 0 && xi < map.xs.length && yi >= 0 && yi < map.ys.length ? { x: xi, y: yi } : null;
  };
  const hv = hover ? map.cells[hover.y]?.[hover.x] : undefined;
  return (
    <div className="stg-heat">
      <canvas
        ref={ref}
        className="stg-canvas"
        data-testid="strategy-heatmap"
        onMouseMove={(e) => setHover(cellAt(e))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const c = cellAt(e);
          if (c) onPick(map.xs[c.x]!, map.ys[c.y]!);
        }}
      />
      <div className="stg-heat-foot tnum">
        {hover ? (
          <>
            {map.xKey} = {map.xs[hover.x]} · {map.yKey} = {map.ys[hover.y]} ·{' '}
            {hv === undefined || Number.isNaN(hv) ? 'no trades' : format(hv)} — click to use
          </>
        ) : (
          <>
            x: {map.xKey} · y: {map.yKey} · range {format(map.min)} … {format(map.max)}
          </>
        )}
      </div>
    </div>
  );
}
