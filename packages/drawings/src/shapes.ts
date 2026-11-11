import type { Dash } from './types';
import { distToEllipse, distToPolyline, ellipseNorm, pointInPoly } from './geometry';

/**
 * Display list produced by every tool: the renderer draws it and the hit-tester tests it,
 * so what you see is exactly what you can click.
 */
export type MarkerKind =
  | 'dot'
  | 'diamond'
  | 'square'
  | 'arrow-up'
  | 'arrow-down'
  | 'checkmark'
  | 'cross'
  | 'star'
  | 'flag'
  | 'emoji';

interface StrokeProps {
  stroke?: string;
  width?: number;
  dash?: Dash | number[];
  alpha?: number;
  fill?: string;
  fillAlpha?: number;
  /** 'stroke' (default when stroked) · 'fill' (inside counts) · 'none'. */
  hit?: 'stroke' | 'fill' | 'none';
}

export interface PathShape extends StrokeProps {
  k: 'path';
  /** Flat [x0, y0, x1, y1, …]. */
  pts: number[];
  closed?: boolean;
  /** Arrow heads: 1 = at end, 2 = at start, 3 = both. */
  arrow?: number;
}

export interface EllipseShape extends StrokeProps {
  k: 'ellipse';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Partial arc (radians, canvas convention); full ellipse when omitted. */
  a0?: number;
  a1?: number;
}

export interface TextShape {
  k: 'text';
  x: number;
  y: number;
  text: string;
  size: number;
  color: string;
  align: 'left' | 'center' | 'right';
  base: 'top' | 'middle' | 'bottom';
  weight?: number;
  alpha?: number;
  bg?: string;
  bgAlpha?: number;
  border?: string;
  pad?: number;
  hit?: boolean;
  /** Filled by the renderer/hit-tester from the measure function. */
  w?: number;
}

export interface MarkerShape {
  k: 'marker';
  m: MarkerKind;
  x: number;
  y: number;
  size: number;
  color: string;
  alpha?: number;
  text?: string;
}

export type Shape = PathShape | EllipseShape | TextShape | MarkerShape;

export function textBox(
  s: TextShape,
  measure: (text: string, size: number, weight?: number) => number,
): { x: number; y: number; w: number; h: number } {
  const pad = s.pad ?? (s.bg ? 4 : 0);
  const lines = s.text.split('\n');
  const w = s.w ?? Math.max(...lines.map((l) => measure(l, s.size, s.weight)));
  const lh = s.size * 1.3;
  const h = lines.length * lh;
  const x = s.align === 'left' ? s.x : s.align === 'center' ? s.x - w / 2 : s.x - w;
  const y = s.base === 'top' ? s.y : s.base === 'middle' ? s.y - h / 2 : s.y - h;
  return { x: x - pad, y: y - pad, w: w + 2 * pad, h: h + 2 * pad };
}

/** True when (x, y) hits the shape within tol px. */
export function hitShape(
  s: Shape,
  x: number,
  y: number,
  tol: number,
  measure: (text: string, size: number, weight?: number) => number,
): boolean {
  switch (s.k) {
    case 'path': {
      const mode = s.hit ?? (s.stroke ? 'stroke' : s.fill ? 'fill' : 'none');
      if (mode === 'none') return false;
      if (mode === 'fill' && s.pts.length >= 6 && pointInPoly(x, y, s.pts)) return true;
      return distToPolyline(x, y, s.pts, s.closed) <= tol + (s.width ?? 1) / 2;
    }
    case 'ellipse': {
      const mode = s.hit ?? (s.stroke ? 'stroke' : s.fill ? 'fill' : 'none');
      if (mode === 'none') return false;
      if (mode === 'fill' && ellipseNorm(x, y, s.cx, s.cy, s.rx, s.ry) <= 1) return true;
      return distToEllipse(x, y, s.cx, s.cy, s.rx, s.ry) <= tol;
    }
    case 'text': {
      if (s.hit === false) return false;
      const b = textBox(s, measure);
      return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    }
    case 'marker':
      return Math.abs(x - s.x) <= s.size / 2 + tol && Math.abs(y - s.y) <= s.size / 2 + tol;
  }
}

export function hitShapes(
  shapes: readonly Shape[],
  x: number,
  y: number,
  tol: number,
  measure: (text: string, size: number, weight?: number) => number,
): boolean {
  for (const s of shapes) if (hitShape(s, x, y, tol, measure)) return true;
  return false;
}

export function dashArray(d: Dash | number[] | undefined, width = 1): number[] {
  if (Array.isArray(d)) return d;
  if (d === 'dashed') return [6 + width, 4 + width];
  if (d === 'dotted') return [Math.max(1, width), 2 + width];
  return [];
}
