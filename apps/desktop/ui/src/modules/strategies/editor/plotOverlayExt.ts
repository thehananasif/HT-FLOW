import type { ChartLayer, ChartView } from '@htflow/chart-engine';
import type { Bar } from '@htflow/market-data';
import { registerChartExtension } from '../../../charts/extensions';
import { PLOT_PALETTE, plotLines, plotOverlay, plotSlots } from './plotOverlay';
import { scriptRuns } from './runs';

export const PLOTS_EXT_ID = 'strategy-plots';

/** Draws the overlay `plot()` lines of active HT Editor runs on the chart of their instrument. */
export class ScriptPlotsLayer implements ChartLayer {
  readonly id = 'script-plots';
  constructor(
    private instrumentId: string,
    private tickSize: number,
    private bars: () => readonly Bar[],
  ) {}

  draw(v: ChartView): void {
    const bars = this.bars();
    if (!bars.length) return;
    const lines = plotLines(scriptRuns.list(), this.instrumentId);
    if (!lines.length) return;
    const { ctx } = v;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, v.plot.y, v.plot.w, v.plot.h);
    ctx.clip();
    ctx.font = v.font(10, 600, true);
    ctx.lineWidth = 1.4;
    lines.forEach((line, k) => {
      const slots = plotSlots(bars, line.points, this.tickSize);
      if (!slots.length) return;
      const color = line.color || PLOT_PALETTE[k % PLOT_PALETTE.length]!;
      ctx.strokeStyle = color;
      ctx.beginPath();
      let started = false;
      for (const s of slots) {
        if (s.i < v.i0 - 1 || s.i > v.i1 + 1) {
          started = false;
          continue;
        }
        const x = v.xOf(s.i);
        const y = v.yOf(s.ticks);
        if (started) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        started = true;
      }
      ctx.stroke();
      const last = slots[slots.length - 1]!;
      if (last.i >= v.i0 && last.i <= v.i1) {
        ctx.fillStyle = color;
        // Dot on the newest value (also the only mark while the line has a single point).
        ctx.beginPath();
        ctx.arc(v.xOf(last.i), v.yOf(last.ticks), 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(line.name, v.xOf(last.i) + 6, v.yOf(last.ticks));
      }
    });
    ctx.restore();
  }
}

registerChartExtension({
  id: PLOTS_EXT_ID,
  layers(ctx) {
    return [
      new ScriptPlotsLayer(
        ctx.store.instrument.id,
        ctx.store.instrument.tickSize,
        () => ctx.series()?.bars ?? [],
      ),
    ];
  },
  attach(ctx) {
    const redraw = () => ctx.cores.forEach((c) => c.invalidate());
    const offA = plotOverlay.subscribe(redraw);
    const offB = scriptRuns.subscribe(redraw);
    return () => {
      offA();
      offB();
    };
  },
});
