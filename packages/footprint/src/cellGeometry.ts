import { parseColor, type ChartPalette, type RectBatch } from '@htflow/chart-engine';
import type { FootprintModeDef } from './modes';
import type { Row } from './merge';

/**
 * Footprint cell rects (P10) shared by the Canvas2D and WebGL2 backends. Pure: the layer
 * resolves the layout (x, y, w, h) and the visible maxima, this turns one row into rect instances.
 */
export interface CellParams {
  mode: FootprintModeDef;
  palette: Pick<ChartPalette, 'up' | 'down' | 'surface3' | 'clusterStrong' | 'divider'>;
  /** Cell opacity 0..1 (plain / delta-coloured cells). */
  opacity: number;
  colorMode: 'volume' | 'delta' | 'none';
  maxD: number;
  maxSide: number;
}

/** Rects of one footprint cell (background and / or histogram bars) at (x, y, w, h). */
export function buildFootprintCell(
  out: RectBatch,
  p: CellParams,
  r: Row,
  x: number,
  y: number,
  w: number,
  h: number,
  /** Value share of the visible maximum (0..1). */
  kv: number,
  /** Delta / volume of the row (-1..1). */
  dShare: number,
): RectBatch {
  const pal = p.palette;
  const st = p.mode.style;
  const content = p.mode.content;
  const op = Math.max(0, Math.min(1, p.opacity));
  const up = parseColor(pal.up);
  const down = parseColor(pal.down);
  const deltaAlpha = () => (0.15 + Math.min(1, Math.abs(dShare)) * 0.6 * (0.4 + kv * 0.6)) * op;
  switch (st) {
    case 'plain':
      if (p.colorMode === 'none') out.rect(x, y, w, h, pal.surface3, 0.5 * op);
      else if (p.colorMode === 'delta') out.rect(x, y, w, h, dShare >= 0 ? up : down, deltaAlpha());
      else if (content === 'bidask') out.rect(x, y, w, h, pal.surface3, 0.9 * op);
      else out.rect(x, y, w, h, pal.clusterStrong, (0.18 + kv * 0.55) * op);
      return out;
    case 'deltaColored':
      if (content === 'delta')
        out.rect(x, y, w, h, r.delta >= 0 ? up : down, 0.12 + (Math.abs(r.delta) / p.maxD) * 0.7);
      else out.rect(x, y, w, h, dShare >= 0 ? up : down, deltaAlpha());
      return out;
    case 'histogram':
    case 'digital':
    case 'deltaHistogram': {
      out.rect(x, y, w, h, pal.surface3, 0.6);
      if (content === 'bidask') {
        const half = w / 2;
        const bw = (r.bid / p.maxSide) * half;
        out.rect(x + half - bw, y, bw, h, down, 0.6);
        out.rect(x + half, y, (r.ask / p.maxSide) * half, h, up, 0.6);
      } else {
        const col =
          st === 'deltaHistogram' ? (dShare >= 0 ? up : down) : parseColor(pal.clusterStrong);
        out.rect(x, y, Math.max(1, kv * w), h, col, st === 'digital' ? 0.9 : 0.7);
      }
      return out;
    }
    case 'ladder': {
      const half = w / 2;
      out.rect(x, y, half - 1, h, down, 0.12 + (r.bid / p.maxSide) * 0.55);
      out.rect(x + half, y, half, h, up, 0.12 + (r.ask / p.maxSide) * 0.55);
      return out;
    }
    case 'profile': {
      const half = w / 2;
      const bw = (r.bid / p.maxSide) * half;
      out.rect(x + half - bw, y, bw, h, down, 0.65);
      out.rect(x + half, y, (r.ask / p.maxSide) * half, h, up, 0.65);
      return out;
    }
    case 'deltaProfile': {
      const half = w / 2;
      const len = (Math.abs(r.delta) / p.maxD) * half;
      if (r.delta >= 0) out.rect(x + half, y, len, h, up, 0.7);
      else out.rect(x + half - len, y, len, h, down, 0.7);
      out.rect(x + half, y, 1, h, pal.divider);
      return out;
    }
  }
  return out;
}
