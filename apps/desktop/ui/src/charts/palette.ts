import { useEffect, useState } from 'react';
import { onThemeChange, theme, type ThemeTokens } from '@htflow/ui-kit';
import type { ChartPalette } from '@htflow/chart-engine';

export function toPalette(t: ThemeTokens): ChartPalette {
  return {
    chartBg: t.chartBg,
    grid: t.grid,
    border: t.border,
    divider: t.divider,
    textPrimary: t.textPrimary,
    textSecondary: t.textSecondary,
    textTertiary: t.textTertiary,
    textSoft: t.textSoft,
    surface2: t.surface2,
    surface3: t.surface3,
    up: t.up,
    down: t.down,
    warning: t.warning,
    info: t.info,
    special: t.special,
    volume: t.volume,
    cluster: t.cluster,
    clusterStrong: t.clusterStrong,
    accent: t.accent,
    accentText: t.accentText,
  };
}

export function usePalette(): ChartPalette {
  const [p, setP] = useState(() => toPalette(theme()));
  useEffect(() => onThemeChange((t) => setP(toPalette(t))), []);
  return p;
}
