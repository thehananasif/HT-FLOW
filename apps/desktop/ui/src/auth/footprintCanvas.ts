/**
 * Canvas renderer + animation loop for the login background: footprint candles (bid x ask numbers
 * in cells, delta-tinted, POC outline, imbalance highlights) forming at the right and scrolling
 * left. Closed candles are rendered once into a bitmap, so a frame only redraws the forming candle.
 *
 * - requestAnimationFrame loop, delta-time based, paused while the document is hidden
 * - prefers-reduced-motion: draws one static frame instead of animating
 * - `destroy()` removes every listener and cancels the frame
 */
import {
  candleDelta,
  imbalances,
  maxAbsDelta,
  pocOf,
  SyntheticFlow,
  type SimCandle,
} from './footprintSim';

export type AnimState = 'running' | 'paused' | 'static' | 'stopped';

const CELL_W = 30;
const CELL_H = 14;
const GAP = 22; // gap between candles
const CANDLE_W = CELL_W * 2 + 8; // bid cell + ask cell + wick lane
const STEP = CANDLE_W + GAP;
const MAX_DPR = 1.5;
const CANDLE_MS = 5200;
const PRINTS_PER_SEC = 16;

const UP = '32, 199, 122';
const DOWN = '240, 74, 93';
const POC = '232, 185, 49';

interface Cached {
  canvas: HTMLCanvasElement;
  minTick: number;
  maxTick: number;
}

export interface AnimOptions {
  seed?: number;
  onState?: (s: AnimState) => void;
}

export class FootprintAnimation {
  private ctx: CanvasRenderingContext2D;
  private flow: SyntheticFlow;
  private done: { candle: SimCandle; cache: Cached | null }[] = [];
  private raf = 0;
  private last = 0;
  private candleAge = 0;
  private printCarry = 0;
  private camX = 0; // world x (in candle steps) of the forming candle, eased
  private camTick: number;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private reduce: MediaQueryList | null = null;
  private _state: AnimState = 'stopped';
  frames = 0;
  private ro: ResizeObserver | null = null;
  private readonly onVis = () => this.sync();
  private readonly onReduce = () => this.sync();
  private started = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: AnimOptions = {},
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas unavailable');
    this.ctx = ctx;
    this.flow = new SyntheticFlow(opts.seed);
    // History so the first frame is already full of candles.
    for (let i = 0; i < 48; i++) {
      this.flow.prints(Math.round((CANDLE_MS / 1000) * PRINTS_PER_SEC));
      this.done.push({ candle: this.flow.roll(), cache: null });
    }
    this.flow.prints(30);
    this.camTick = this.flow.current.close;
    this.camX = this.done.length;
  }

  get state(): AnimState {
    return this._state;
  }

  private setState(s: AnimState) {
    if (s === this._state) return;
    this._state = s;
    this.opts.onState?.(s);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.reduce =
      typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.reduce?.addEventListener?.('change', this.onReduce);
    document.addEventListener('visibilitychange', this.onVis);
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this.canvas);
    }
    this.resize();
    this.sync();
  }

  /** Re-evaluates what the loop should be doing (visibility / reduced motion changed). */
  private sync(): void {
    if (!this.started) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.reduce?.matches) {
      this.setState('static');
      this.draw();
      return;
    }
    if (document.hidden) {
      this.setState('paused');
      return;
    }
    this.setState('running');
    this.last = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  private readonly tick = (t: number) => {
    const dt = this.last ? Math.min(0.05, (t - this.last) / 1000) : 0;
    this.last = t;
    this.update(dt);
    this.draw();
    this.frames++;
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Advances the simulation by `dt` seconds. */
  update(dt: number): void {
    this.printCarry += dt * PRINTS_PER_SEC;
    const n = Math.floor(this.printCarry);
    if (n > 0) {
      this.flow.prints(n);
      this.printCarry -= n;
    }
    this.candleAge += dt * 1000;
    if (this.candleAge >= CANDLE_MS) {
      this.candleAge = 0;
      this.done.push({ candle: this.flow.roll(), cache: null });
      if (this.done.length > 80) this.done.shift();
    }
    const target = this.done.length; // world position of the forming candle
    this.camX += (target - this.camX) * Math.min(1, dt * 3.2);
    this.camTick += (this.flow.current.close - this.camTick) * Math.min(1, dt * 1.6);
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    if (dpr !== this.dpr) for (const d of this.done) d.cache = null;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    if (this._state !== 'running') this.draw();
  }

  private cacheFor(c: SimCandle): Cached {
    let min = Infinity;
    let max = -Infinity;
    for (const t of c.levels.keys()) {
      min = Math.min(min, t);
      max = Math.max(max, t);
    }
    if (min === Infinity) min = max = c.close;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(CANDLE_W * this.dpr);
    cv.height = Math.ceil(((max - min + 1) * CELL_H + 24) * this.dpr);
    const x = cv.getContext('2d')!;
    x.scale(this.dpr, this.dpr);
    this.paintCandle(x, c, 0, max);
    return { canvas: cv, minTick: min, maxTick: max };
  }

  /** Paints one candle; `baseY` is the top of the row of `topTick`. */
  private paintCandle(
    x: CanvasRenderingContext2D,
    c: SimCandle,
    left: number,
    topTick: number,
    camTick?: number,
    midY?: number,
  ): void {
    const imb = imbalances(c);
    const poc = pocOf(c);
    const scale = Math.max(maxAbsDelta(c), 8);
    x.font = '9px ui-monospace, "Cascadia Mono", Consolas, monospace';
    x.textBaseline = 'middle';
    const rowY = (tick: number) =>
      camTick === undefined || midY === undefined
        ? (topTick - tick) * CELL_H + 1
        : midY - (tick - camTick) * CELL_H - CELL_H / 2;
    const bodyUp = c.close >= c.open;
    // candle body lane (open-close) and wick (high-low) at the left edge
    const yHigh = rowY(c.high);
    const yLow = rowY(c.low) + CELL_H - 1;
    x.fillStyle = `rgba(${bodyUp ? UP : DOWN}, 0.55)`;
    x.fillRect(left + 3, yHigh, 1, yLow - yHigh);
    const yO = rowY(c.open);
    const yC = rowY(c.close);
    x.fillRect(left + 1, Math.min(yO, yC), 5, Math.abs(yO - yC) + CELL_H - 1);
    const x0 = left + 8;
    for (const [tick, l] of c.levels) {
      const y = rowY(tick);
      const d = l.ask - l.bid;
      const k = Math.min(1, Math.abs(d) / scale);
      x.fillStyle = `rgba(${d >= 0 ? UP : DOWN}, ${0.06 + 0.34 * k})`;
      x.fillRect(x0, y, CELL_W * 2 - 2, CELL_H - 1);
      if (tick === poc) {
        x.strokeStyle = `rgba(${POC}, 0.9)`;
        x.lineWidth = 1;
        x.strokeRect(x0 + 0.5, y + 0.5, CELL_W * 2 - 3, CELL_H - 2);
      }
      const bidImb = imb.has(`${tick}:bid`);
      const askImb = imb.has(`${tick}:ask`);
      if (bidImb) {
        x.fillStyle = `rgba(${DOWN}, 0.55)`;
        x.fillRect(x0, y, CELL_W - 1, CELL_H - 1);
      }
      if (askImb) {
        x.fillStyle = `rgba(${UP}, 0.55)`;
        x.fillRect(x0 + CELL_W - 1, y, CELL_W - 1, CELL_H - 1);
      }
      x.textAlign = 'right';
      x.fillStyle = bidImb ? '#ffd8dd' : 'rgba(205,210,220,0.72)';
      x.fillText(String(l.bid), x0 + CELL_W - 4, y + CELL_H / 2);
      x.textAlign = 'left';
      x.fillStyle = askImb ? '#d6ffe9' : 'rgba(205,210,220,0.72)';
      x.fillText(String(l.ask), x0 + CELL_W + 2, y + CELL_H / 2);
    }
    // delta footer under the candle
    const dl = candleDelta(c);
    const yFoot = rowY(c.low) + CELL_H + 3;
    x.textAlign = 'center';
    x.fillStyle = `rgba(${dl >= 0 ? UP : DOWN}, 0.85)`;
    x.fillText(`${dl >= 0 ? '+' : ''}${dl}`, x0 + CELL_W - 1, yFoot + 5);
  }

  draw(): void {
    const { ctx, w, h, dpr } = this;
    if (!w || !h) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const anchorX = Math.round(w * 0.58);
    const midY = Math.round(h * 0.5);
    ctx.globalAlpha = 1;
    // closed candles from cache
    for (let i = 0; i < this.done.length; i++) {
      const x = anchorX + (i - this.camX) * STEP;
      if (x > w || x + CANDLE_W < 0) continue;
      const d = this.done[i]!;
      d.cache ??= this.cacheFor(d.candle);
      const y = midY - (d.cache.maxTick - this.camTick) * CELL_H - CELL_H / 2 - 1; // top of the max row (rowY - 1)
      if (y > h || y + d.cache.canvas.height / dpr < 0) continue;
      ctx.drawImage(d.cache.canvas, x, y, d.cache.canvas.width / dpr, d.cache.canvas.height / dpr);
    }
    // forming candle (redrawn)
    const fx = anchorX + (this.done.length - this.camX) * STEP;
    this.paintCandle(ctx, this.flow.current, fx, this.flow.current.high, this.camTick, midY);
    // price axis ticks along the right edge (decor)
    ctx.font = '9px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(150,155,170,0.35)';
    const top = Math.floor(this.camTick + midY / CELL_H);
    for (let tk = top; tk > top - h / CELL_H; tk--) {
      if (tk % 5 !== 0) continue;
      ctx.fillText(String(tk), w - 8, midY - (tk - this.camTick) * CELL_H);
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro?.disconnect();
    this.ro = null;
    document.removeEventListener('visibilitychange', this.onVis);
    this.reduce?.removeEventListener?.('change', this.onReduce);
    this.started = false;
    this.setState('stopped');
  }
}
