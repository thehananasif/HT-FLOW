/** Ratio (0-1) of the first pane after dragging, honouring min pixel sizes of both panes. */
export function clampRatio(ratio: number, total: number, minA: number, minB: number): number {
  if (!(total > 0)) return 0.5;
  const lo = Math.min(0.5, minA / total);
  const hi = Math.max(0.5, 1 - minB / total);
  return Math.min(hi, Math.max(lo, Number.isFinite(ratio) ? ratio : 0.5));
}
