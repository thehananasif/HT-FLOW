import type { ChartLayer, ChartView } from '@htflow/chart-engine';

export interface LensConfig {
  on: boolean;
  /** Magnification (1.5..8). */
  zoom: number;
  /** Lens diameter in CSS px. */
  size: number;
}

/** Lens placement: beside the cursor, flipped when it would leave the plot. */
export function lensCentre(
  x: number,
  y: number,
  r: number,
  plot: { x: number; y: number; w: number; h: number },
): { cx: number; cy: number } {
  const gap = 22;
  let cx = x + r + gap;
  if (cx + r > plot.x + plot.w) cx = x - r - gap;
  let cy = y - r - gap;
  if (cy - r < plot.y) cy = y + r + gap;
  return { cx, cy };
}

/** Source square (CSS px) copied into the lens: centred on the cursor, size / zoom wide. */
export function lensSource(x: number, y: number, size: number, zoom: number) {
  const s = size / Math.max(1, zoom);
  return { sx: x - s / 2, sy: y - s / 2, sw: s };
}

/** Zoom lens at the cursor (Magnifier tool, hotkey M): re-draws the canvas pixels around it larger. */
export class MagnifierLayer implements ChartLayer {
  readonly id = 'magnifier';
  constructor(private cfg: () => LensConfig) {}

  draw(v: ChartView): void {
    const c = this.cfg();
    const ch = v.crosshair;
    if (!c.on || !ch) return;
    const ctx = v.ctx;
    const r = c.size / 2;
    const { cx, cy } = lensCentre(ch.x, ch.y, r, v.plot);
    const { sx, sy, sw } = lensSource(ch.x, ch.y, c.size, c.zoom);
    const dpr = ctx.getTransform().a || 1;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = v.palette.chartBg;
    ctx.fill();
    ctx.clip();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    try {
      ctx.drawImage(
        ctx.canvas,
        sx * dpr,
        sy * dpr,
        sw * dpr,
        sw * dpr,
        (cx - r) * dpr,
        (cy - r) * dpr,
        c.size * dpr,
        c.size * dpr,
      );
    } catch {
      // Canvas not readable (test environments): the ring is still drawn.
    }
    ctx.restore();
    ctx.strokeStyle = v.palette.textTertiary;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy);
    ctx.lineTo(cx + 5, cy);
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx, cy + 5);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.font = v.font(10, 600);
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.fillText(`${c.zoom.toFixed(c.zoom % 1 ? 1 : 0)}×`, cx, cy + r - 8);
    ctx.restore();
  }
}
