/** Visual options of ChartCore that are not palette colours (P34 Visual Settings). */
export type LineStyle = 'solid' | 'dash' | 'dot';

export interface StrokeStyle {
  /** Colour; empty string = theme default. */
  color: string;
  style: LineStyle;
  width: number;
}

export interface ChartStyle {
  /** Second background colour for a vertical gradient; empty = single colour. */
  background2: string;
  grid: { h: boolean; v: boolean; line: StrokeStyle };
  crosshair: { line: StrokeStyle; labelBg: string; labelText: string; snap: boolean };
  axis: { bg: string; text: string; fontSize: number; border: boolean };
  /** 24-hour or 12-hour axis labels. */
  timeFormat: '24h' | '12h';
}

export const DEFAULT_STYLE: ChartStyle = {
  background2: '',
  grid: { h: true, v: true, line: { color: '', style: 'dash', width: 1 } },
  crosshair: {
    line: { color: '', style: 'dash', width: 1 },
    labelBg: '',
    labelText: '',
    snap: false,
  },
  axis: { bg: '', text: '', fontSize: 11, border: true },
  timeFormat: '24h',
};

/** Canvas dash pattern for a line style. */
export function dashFor(style: LineStyle, width = 1): number[] {
  if (style === 'dash') return [4 * Math.max(1, width * 0.75), 3 * Math.max(1, width * 0.75)];
  if (style === 'dot') return [Math.max(1, width), Math.max(2, width * 2)];
  return [];
}

/** First non-empty colour. */
export function pick(...cols: (string | undefined | null)[]): string {
  for (const c of cols) if (c) return c;
  return '#000000';
}
