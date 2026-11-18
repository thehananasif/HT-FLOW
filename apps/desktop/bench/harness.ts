/**
 * Shared helpers for `pnpm bench` (P29). Benchmarks run the real renderers against a headless 2D
 * context: every canvas call is a no-op, so the numbers are the CPU (JavaScript) cost of building a
 * frame — layout, aggregation, colour grading, text formatting and the draw-call stream. Raster /
 * GPU time inside the WebView is not included; see docs/PERFORMANCE.md for how to read them.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESULTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '.cache',
  'htflow-bench',
);
export const RESULTS_FILE = join(RESULTS_DIR, 'results.jsonl');

export interface BenchResult {
  /** Group shown as a section in the report (e.g. "Charts"). */
  group: string;
  /** What was measured. */
  name: string;
  /** Spec target in words (e.g. "60 fps with 1M+ ticks"). */
  target: string;
  /** Budget in `unit` derived from the target (16.7 ms for 60 fps). */
  budget: number;
  unit: 'ms' | 'ms/frame' | 'prints/s' | 'ticks/s';
  /** Median of the timed runs (or the throughput for prints/s). */
  median: number;
  p95: number;
  runs: number;
  /** Higher is better (throughput) instead of lower (time). */
  higherIsBetter?: boolean;
  notes?: string;
}

export function passes(r: BenchResult): boolean {
  return r.higherIsBetter ? r.median >= r.budget : r.median <= r.budget;
}

export function record(r: BenchResult): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(RESULTS_FILE, JSON.stringify(r) + '\n');
  console.info(
    `[bench] ${r.group} · ${r.name}: median ${r.median.toFixed(2)} ${r.unit} (p95 ${r.p95.toFixed(2)}), budget ${r.budget} → ${passes(r) ? 'PASS' : 'MISS'}`,
  );
}

export function quantile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

/** Times `fn` `runs` times after `warmup` untimed calls; returns median / p95 in ms. */
export function measure(
  fn: (k: number) => void,
  { warmup = 5, runs = 30 }: { warmup?: number; runs?: number } = {},
): { median: number; p95: number; runs: number } {
  for (let k = 0; k < warmup; k++) fn(k);
  const times: number[] = [];
  for (let k = 0; k < runs; k++) {
    const t0 = performance.now();
    fn(warmup + k);
    times.push(performance.now() - t0);
  }
  return { median: quantile(times, 0.5), p95: quantile(times, 0.95), runs };
}

/** Deterministic LCG in [0, 1). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A 2D context whose every call is a no-op (measureText returns a plausible width). */
export function headlessContext(): CanvasRenderingContext2D {
  const noop = () => {};
  const gradient = { addColorStop: noop };
  const fns: Record<string, unknown> = {
    measureText: (s: string) => ({
      width: String(s).length * 6.5,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
    }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => null,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
      width: w,
      height: h,
    }),
    getLineDash: () => [],
    isPointInPath: () => false,
  };
  const store: Record<string | symbol, unknown> = {};
  return new Proxy(store, {
    get: (t, k) => (typeof k === 'string' && k in fns ? fns[k] : k in t ? t[k] : noop),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/**
 * Installs the browser APIs ChartCore and the canvas modules need on top of jsdom: a headless 2D
 * context, ResizeObserver, manual requestAnimationFrame and ImageData.
 */
export function installHeadlessDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    const self = this as unknown as { __ctx?: CanvasRenderingContext2D };
    return (self.__ctx ??= headlessContext());
  } as unknown as HTMLCanvasElement['getContext'];
  HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  g.requestAnimationFrame = () => 0;
  g.cancelAnimationFrame = () => {};
  if (!('ImageData' in g)) {
    g.ImageData = class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    };
  }
}

/** A host element with a fixed size (jsdom has no layout). */
export function sizedHost(width: number, height: number): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

/** Calls ChartCore's private render (what one animation frame does when the chart is dirty). */
export function renderFrame(core: unknown): void {
  (core as { render(): void }).render();
}
