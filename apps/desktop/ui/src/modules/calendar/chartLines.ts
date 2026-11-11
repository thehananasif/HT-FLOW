import type { ChartLayer, ChartView } from '@htflow/chart-engine';
import type { Bar } from '@htflow/market-data';
import { currencyAffects, instrumentRoot, passesImpact } from '@htflow/info';
import { registerChartExtension, type ChartExtensionContext } from '../../charts/extensions';
import { allEvents, calendar } from './store';

/** x of time `t` on a bar chart (interpolated inside a bar, extrapolated past the last bar). */
export function timeToX(bars: readonly Bar[], t: number, v: Pick<ChartView, 'xOf' | 'slotWidth'>, barMs: number | null): number | null {
  const n = bars.length;
  if (!n || t < bars[0]!.t) return null;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  const b = bars[lo]!;
  let dur = lo + 1 < n ? bars[lo + 1]!.t - b.t : (barMs ?? Math.max(1, (b.t - bars[Math.max(0, n - 21)]!.t) / Math.min(20, n - 1 || 1)));
  if (!(dur > 0)) dur = 60_000;
  const frac = (t - b.t) / dur;
  if (lo + 1 < n && frac > 1) return v.xOf(lo) + v.slotWidth / 2; // gap between bars
  return v.xOf(lo) - v.slotWidth / 2 + frac * v.slotWidth;
}

class CalendarEventsLayer implements ChartLayer {
  readonly id = 'calendar-events';
  constructor(private ctx: ChartExtensionContext) {}

  draw(v: ChartView): void {
    const s = calendar.get();
    if (!s.showOnCharts) return;
    const series = this.ctx.series();
    if (!series || !series.bars.length) return;
    const inst = this.ctx.store.instrument;
    const root = instrumentRoot(inst.symbol);
    const spec = this.ctx.state().timeframe;
    const barMs = spec.kind === 'time' ? spec.ms : null;
    const { ctx, palette: p } = v;
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.plot.x, 0, v.plot.w, v.plot.h);
    ctx.clip();
    ctx.font = v.font(10);
    ctx.textBaseline = 'top';
    let row = 0;
    for (const e of allEvents(s)) {
      if (e.allDay || !passesImpact(e, s.chartImpact)) continue;
      if (e.currency && !currencyAffects(e.currency, root, inst.assetClass)) continue;
      const x = timeToX(series.bars, e.t, v, barMs);
      if (x === null || x < v.plot.x || x > v.plot.x + v.plot.w) continue;
      const color = e.impact === 'high' ? p.down : e.impact === 'medium' ? p.warning : p.textTertiary;
      const xx = Math.round(x) + 0.5;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(xx, 0);
      ctx.lineTo(xx, v.plot.h);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const label = `${e.currency ? e.currency + ' · ' : ''}${e.title}`;
      const w = ctx.measureText(label).width + 8;
      const y = 22 + (row++ % 4) * 16;
      ctx.fillStyle = p.surface3;
      ctx.fillRect(xx + 2, y, w, 14);
      ctx.fillStyle = color;
      ctx.fillRect(xx + 2, y, 2, 14);
      ctx.fillStyle = p.textSoft;
      ctx.fillText(label, xx + 7, y + 2);
    }
    ctx.restore();
  }
}

registerChartExtension({
  id: 'calendar-events',
  layers: (ctx) => [new CalendarEventsLayer(ctx)],
  attach: (ctx) => {
    void calendar.ensureLoaded();
    const redraw = () => ctx.cores.forEach((c) => c.invalidate());
    const un = calendar.subscribe(redraw);
    const i = setInterval(redraw, 60_000);
    return () => {
      un();
      clearInterval(i);
    };
  },
});
