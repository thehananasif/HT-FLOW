/** Number formatting for the options board (tabular cells). */
export function fmtPx(v: number | null | undefined, decimals: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtIv(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`;
}

export function fmtNum(v: number | null | undefined, decimals: number): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(decimals);
}

/** Currency with sign; ∞ for unlimited. `compact` abbreviates thousands. */
export function fmtMoney(v: number, compact = false): string {
  if (v === Infinity) return 'Unlimited';
  if (v === -Infinity) return '-Unlimited';
  if (!Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (compact && a >= 10_000) return `${sign}$${(a / 1000).toFixed(a >= 100_000 ? 0 : 1)}k`;
  return `${sign}$${a.toLocaleString('en-US', { maximumFractionDigits: a >= 100 ? 0 : 2 })}`;
}

/** Decimals for greeks shown in currency-per-unit (theta, vega). */
export function greekDecimals(priceDecimals: number): number {
  return Math.max(0, Math.min(3, priceDecimals));
}
