import { useEffect, useRef, useState } from 'react';
import { alpha, FONT_UI, theme } from '@htflow/ui-kit';
import type { PayoffCurve } from '@htflow/options';
import { fmtMoney, fmtPx } from './format';

/** Payoff diagram: P/L at expiry (solid) and at the valuation date (dashed), breakevens, spot. */
export function PayoffChart({
  curve,
  spot,
  decimals,
  todayLabel,
}: {
  curve: PayoffCurve | null;
  spot: number;
  decimals: number;
  todayLabel: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [size, setSize] = useState({ w: 300, h: 200 });

  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, size.w * dpr);
    c.height = Math.max(1, size.h * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    const t = theme();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);
    g.font = `10px ${FONT_UI}`;
    if (!curve || curve.prices.length < 2) return;
    const L = 52;
    const R = 8;
    const T = 22;
    const B = 18;
    const W = size.w - L - R;
    const H = size.h - T - B;
    const xs = curve.prices;
    const all = [...curve.expiry, ...curve.now, 0];
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    const pad = (hi - lo) * 0.12 || 1;
    lo -= pad;
    hi += pad;
    const x0 = xs[0]!;
    const x1 = xs[xs.length - 1]!;
    const px = (v: number) => L + ((v - x0) / (x1 - x0)) * W;
    const py = (v: number) => T + (1 - (v - lo) / (hi - lo)) * H;
    // P/L axis
    g.fillStyle = t.textTertiary;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4;
      g.fillText(fmtMoney(v, true), L - 6, py(v));
      g.strokeStyle = t.grid;
      g.beginPath();
      g.moveTo(L, Math.round(py(v)) + 0.5);
      g.lineTo(L + W, Math.round(py(v)) + 0.5);
      g.stroke();
    }
    // zero line
    g.strokeStyle = t.muted;
    g.beginPath();
    g.moveTo(L, Math.round(py(0)) + 0.5);
    g.lineTo(L + W, Math.round(py(0)) + 0.5);
    g.stroke();
    // profit / loss fill under the expiry curve
    const fill = (positive: boolean) => {
      g.save();
      g.beginPath();
      if (positive) g.rect(L, T, W, py(0) - T);
      else g.rect(L, py(0), W, T + H - py(0));
      g.clip();
      g.beginPath();
      g.moveTo(px(x0), py(0));
      xs.forEach((x, i) => g.lineTo(px(x), py(curve.expiry[i]!)));
      g.lineTo(px(x1), py(0));
      g.closePath();
      g.fillStyle = alpha(positive ? t.up : t.down, 0.14);
      g.fill();
      g.restore();
    };
    fill(true);
    fill(false);
    const line = (ys: number[], color: string, dash: number[], width: number) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.setLineDash(dash);
      g.beginPath();
      xs.forEach((x, i) => (i ? g.lineTo(px(x), py(ys[i]!)) : g.moveTo(px(x), py(ys[i]!))));
      g.stroke();
      g.setLineDash([]);
      g.lineWidth = 1;
    };
    line(curve.now, t.special, [4, 3], 1.5);
    line(curve.expiry, t.textPrimary, [], 2);
    // spot line
    if (spot >= x0 && spot <= x1) {
      g.strokeStyle = t.textTertiary;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(Math.round(px(spot)) + 0.5, T);
      g.lineTo(Math.round(px(spot)) + 0.5, T + H);
      g.stroke();
      g.setLineDash([]);
    }
    // breakevens
    g.textAlign = 'center';
    for (const b of curve.breakevens) {
      if (b < x0 || b > x1) continue;
      g.fillStyle = t.warning;
      g.beginPath();
      g.arc(px(b), py(0), 3.5, 0, Math.PI * 2);
      g.fill();
      g.fillText(fmtPx(b, decimals), px(b), py(0) - 10);
    }
    // x axis
    g.fillStyle = t.textTertiary;
    g.textBaseline = 'alphabetic';
    for (const v of [x0, spot, x1]) {
      g.textAlign = v === x0 ? 'left' : v === x1 ? 'right' : 'center';
      g.fillText(fmtPx(v, decimals), px(v), size.h - 4);
    }
    // legend
    g.textAlign = 'left';
    g.fillStyle = t.textSecondary;
    g.fillText('Payoff at expiry /', L, 12);
    g.fillStyle = t.special;
    g.fillText(todayLabel, L + g.measureText('Payoff at expiry / ').width, 12);
    g.textAlign = 'right';
    g.fillStyle = t.textSecondary;
    g.fillText(`Spot ${fmtPx(spot, decimals)}`, L + W, 12);
    // hover
    if (hover !== null && hover >= L && hover <= L + W) {
      const xv = x0 + ((hover - L) / W) * (x1 - x0);
      const i = Math.round(((xv - x0) / (x1 - x0)) * (xs.length - 1));
      g.strokeStyle = t.textSecondary;
      g.beginPath();
      g.moveTo(hover + 0.5, T);
      g.lineTo(hover + 0.5, T + H);
      g.stroke();
      const txt = `${fmtPx(xs[i]!, decimals)}  exp ${fmtMoney(curve.expiry[i]!, true)}  ${todayLabel} ${fmtMoney(curve.now[i]!, true)}`;
      const w = g.measureText(txt).width + 10;
      const bx = Math.min(L + W - w, Math.max(L, hover - w / 2));
      g.fillStyle = t.surface3;
      g.fillRect(bx, T + 2, w, 16);
      g.fillStyle = t.textPrimary;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText(txt, bx + 5, T + 10);
    }
  }, [curve, spot, decimals, todayLabel, size, hover]);

  return (
    <canvas
      ref={ref}
      data-testid="payoff-chart"
      style={{ width: size.w, height: size.h, display: 'block' }}
      onMouseMove={(e) => setHover(e.nativeEvent.offsetX)}
      onMouseLeave={() => setHover(null)}
    />
  );
}
