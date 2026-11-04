/**
 * HT Flow design tokens (Master Context → DESIGN SYSTEM). Monochrome chrome; white is the only
 * accent; colour is reserved for market meaning. Themes are plain objects so every token can be
 * edited in Settings → Appearance and exported as JSON.
 */
export interface ThemeTokens {
  bg: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surfaceSheet: string;
  border: string;
  divider: string;
  hover: string;
  pressed: string;
  muted: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textDisabled: string;
  textSoft: string;
  accent: string;
  accentText: string;
  up: string;
  down: string;
  warning: string;
  info: string;
  special: string;
  downSoft: string;
  /** Chart-specific */
  chartBg: string;
  grid: string;
  volume: string;
  cluster: string;
  clusterStrong: string;
}

export type ThemeName = 'dark' | 'dark-blue' | 'gray' | 'light' | 'high-contrast';

const market = {
  up: '#20C77A',
  down: '#F04A5D',
  warning: '#E8B04B',
  info: '#4FA3F7',
  special: '#B07CF0',
  downSoft: '#F28A96',
};

const dark: ThemeTokens = {
  bg: '#000000',
  surface1: '#0B0B0B',
  surface2: '#121212',
  surface3: '#1A1A1A',
  surfaceSheet: '#0F0F0F',
  border: '#1F1F1F',
  divider: '#161616',
  hover: '#262626',
  pressed: '#2A2A2A',
  muted: '#3A3A3A',
  textPrimary: '#FFFFFF',
  textSecondary: '#8C8C8C',
  textTertiary: '#5E5E5E',
  textDisabled: '#3A3A3A',
  textSoft: '#BDBDBD',
  accent: '#FFFFFF',
  accentText: '#000000',
  ...market,
  chartBg: '#0A0A0A',
  grid: '#161616',
  volume: '#2D5A8A',
  cluster: '#1E3A5A',
  clusterStrong: '#2F6CB0',
};

export const THEMES: Record<ThemeName, ThemeTokens> = {
  dark,
  'dark-blue': {
    ...dark,
    bg: '#060B14',
    surface1: '#0A111D',
    surface2: '#0F1826',
    surface3: '#152032',
    surfaceSheet: '#0C1420',
    border: '#1C2A40',
    divider: '#142033',
    hover: '#1E2C44',
    pressed: '#24344F',
    chartBg: '#08101C',
    grid: '#122036',
  },
  gray: {
    ...dark,
    bg: '#161616',
    surface1: '#1C1C1C',
    surface2: '#222222',
    surface3: '#2A2A2A',
    surfaceSheet: '#1F1F1F',
    border: '#333333',
    divider: '#2A2A2A',
    hover: '#383838',
    pressed: '#404040',
    chartBg: '#1A1A1A',
    grid: '#262626',
  },
  light: {
    ...dark,
    bg: '#F4F4F2',
    surface1: '#FFFFFF',
    surface2: '#F7F7F5',
    surface3: '#EDEDEA',
    surfaceSheet: '#FFFFFF',
    border: '#E0E0DC',
    divider: '#EBEBE7',
    hover: '#E6E6E2',
    pressed: '#DCDCD8',
    muted: '#C4C4C0',
    textPrimary: '#0A0A0A',
    textSecondary: '#5C5C5A',
    textTertiary: '#8A8A87',
    textDisabled: '#B8B8B4',
    textSoft: '#2E2E2C',
    accent: '#0A0A0A',
    accentText: '#FFFFFF',
    up: '#109A5C',
    down: '#D7263D',
    chartBg: '#FFFFFF',
    grid: '#EFEFEC',
    volume: '#8FB6E0',
    cluster: '#D6E5F5',
    clusterStrong: '#8FB6E0',
  },
  'high-contrast': {
    ...dark,
    border: '#5A5A5A',
    divider: '#3A3A3A',
    textSecondary: '#D0D0D0',
    textTertiary: '#A8A8A8',
    up: '#00FF8C',
    down: '#FF3355',
    grid: '#2A2A2A',
  },
};

const cssName = (k: string) => '--ht-' + k.replace(/[A-Z0-9]/g, (m) => '-' + m.toLowerCase());

let current: ThemeTokens = dark;
const themeListeners = new Set<(t: ThemeTokens) => void>();

/** Applies a theme (plus optional token overrides) to :root CSS variables. */
export function applyTheme(name: ThemeName, overrides: Partial<ThemeTokens> = {}): ThemeTokens {
  const t = { ...THEMES[name], ...overrides };
  current = t;
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(t)) root.style.setProperty(cssName(k), v);
    root.dataset.theme = name;
    root.style.colorScheme = name === 'light' ? 'light' : 'dark';
  }
  for (const l of themeListeners) l(t);
  return t;
}

/** Current theme tokens for canvas renderers. */
export function theme(): ThemeTokens {
  return current;
}

export function onThemeChange(fn: (t: ThemeTokens) => void): () => void {
  themeListeners.add(fn);
  return () => themeListeners.delete(fn);
}

/** rgba() from a #RRGGBB token. */
export function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Linear blend between two #RRGGBB colours. */
export function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1, 7), 16);
  const pb = parseInt(b.slice(1, 7), 16);
  const ch = (s: number) => {
    const x = (pa >> s) & 255;
    const y = (pb >> s) & 255;
    return Math.round(x + (y - x) * t);
  };
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

export const FONT_UI = '"Geist", "Segoe UI", system-ui, sans-serif';
export const FONT_MONO = '"Geist Mono", Consolas, monospace';
