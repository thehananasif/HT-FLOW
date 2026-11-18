import type { ChartView, Rect } from '../types';
import { RECT_STRIDE, type RectBatch } from './batch';
import { cssOf, parseColor } from './color';

export type RendererKind = 'canvas2d' | 'webgl2';
/** User choice: auto picks WebGL2 on a hardware GPU and falls back to Canvas2D. */
export type RendererPref = 'auto' | RendererKind;
export type PowerPreference = 'default' | 'high-performance' | 'low-power';

/**
 * RGBA8 pixel buffer handed to `Painter.image` (e.g. the heatmap's off-screen pixel buffer).
 * `key` identifies the texture / off-screen canvas across frames; bump `version` when the pixels
 * change so the backend re-uploads them.
 */
export interface PixelImage {
  key: object;
  version: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray | Uint8Array;
}

/**
 * Geometry sink of one frame. The Canvas2D backend draws immediately on the chart's 2D context;
 * the WebGL2 backend draws on the GL canvas under the 2D overlay (text, axes and everything a
 * layer still draws with `ctx` stay on the overlay).
 */
export interface Painter {
  readonly kind: RendererKind;
  /** Clip rect for the following calls (null = whole canvas). Canvas2D layers clip `ctx` themselves. */
  setClip(r: Rect | null): void;
  rects(b: RectBatch): void;
  /** Solid polyline through `n` points (x, y pairs). */
  polyline(pts: ArrayLike<number>, n: number, color: string, width: number, alpha?: number): void;
  /** Draws pixel rows [sx, sx+sw) × [sy, sy+sh) of `img` into the destination rect. */
  image(img: PixelImage, src: Rect, dst: Rect, smoothing: boolean): void;
}

/** Canvas2D backend: replays batches with fillRect / stroke on the chart context. */
export class Canvas2DPainter implements Painter {
  readonly kind = 'canvas2d' as const;
  private offs = new WeakMap<object, { canvas: HTMLCanvasElement; version: number }>();

  constructor(readonly ctx: CanvasRenderingContext2D) {}

  setClip(): void {
    /* Canvas2D layers already clip their context. */
  }

  rects(b: RectBatch): void {
    const ctx = this.ctx;
    const d = b.data;
    let lr = -1;
    let lg = -1;
    let lb = -1;
    let la = -1;
    for (let k = 0; k < b.count; k++) {
      const o = k * RECT_STRIDE;
      const r = d[o + 4]!;
      const g = d[o + 5]!;
      const bl = d[o + 6]!;
      const a = d[o + 7]!;
      if (r !== lr || g !== lg || bl !== lb || a !== la) {
        ctx.fillStyle = cssOf(r, g, bl, a);
        lr = r;
        lg = g;
        lb = bl;
        la = a;
      }
      ctx.fillRect(d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!);
    }
  }

  polyline(pts: ArrayLike<number>, n: number, color: string, width: number, alpha = 1): void {
    if (n < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(pts[0]!, pts[1]!);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i * 2]!, pts[i * 2 + 1]!);
    ctx.stroke();
    ctx.restore();
  }

  image(img: PixelImage, src: Rect, dst: Rect, smoothing: boolean): void {
    let off = this.offs.get(img.key);
    if (!off) {
      off = { canvas: document.createElement('canvas'), version: -1 };
      this.offs.set(img.key, off);
    }
    const c = off.canvas;
    if (c.width !== img.width || c.height !== img.height) {
      c.width = img.width;
      c.height = img.height;
      off.version = -1;
    }
    if (off.version !== img.version) {
      const px = new Uint8ClampedArray(
        img.pixels.buffer as ArrayBuffer,
        img.pixels.byteOffset,
        img.width * img.height * 4,
      );
      c.getContext('2d')?.putImageData(new ImageData(px, img.width, img.height), 0, 0);
      off.version = img.version;
    }
    const ctx = this.ctx;
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = smoothing;
    ctx.drawImage(c, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
    ctx.imageSmoothingEnabled = prev;
  }
}

const fallback = new WeakMap<CanvasRenderingContext2D, Canvas2DPainter>();

/** The frame's painter, or a Canvas2D painter on `v.ctx` (views built outside ChartCore). */
export function painterOf(v: Pick<ChartView, 'ctx' | 'paint'>): Painter {
  if (v.paint) return v.paint;
  let p = fallback.get(v.ctx);
  if (!p) {
    p = new Canvas2DPainter(v.ctx);
    fallback.set(v.ctx, p);
  }
  return p;
}

/** Colour parse helper re-exported for layers that build batches. */
export { parseColor };

/**
 * Backend for a preference. `probe` reports whether a WebGL2 context can be created and whether
 * it runs on a hardware GPU (software rasterisers such as SwiftShader are slower than Canvas2D).
 */
export function resolveRenderer(
  pref: RendererPref,
  probe: { webgl2: boolean; hardware: boolean },
  lost = false,
): RendererKind {
  if (pref === 'canvas2d' || !probe.webgl2 || lost) return 'canvas2d';
  if (pref === 'webgl2') return 'webgl2';
  return probe.hardware ? 'webgl2' : 'canvas2d';
}

/** True when a GL renderer string names a software rasteriser. */
export function isSoftwareRenderer(name: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen/i.test(name);
}
