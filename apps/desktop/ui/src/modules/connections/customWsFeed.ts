import type {
  EventBatch,
  FeedSource,
  FeedStatus,
  HistoryData,
  Instrument,
} from '@htflow/market-data';
import { reconnectDelayMs } from '../../state/feedTuning';
import { instrumentOf, mapFrame, renderSubscribe, type CustomWsConfig } from './customWs';

/** Minimal WebSocket surface used here (the browser class, or a fake in tests). */
export interface WsLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type WsCtor = new (url: string) => WsLike;

export interface WsFeedOptions {
  ctor?: WsCtor;
  now?: () => number;
  /** Re-connect back-off ceiling in seconds (default 30). */
  maxBackoffSec?: number;
  /** Random extra delay as a fraction of the back-off (default 0.2); tests pass 0. */
  jitter?: number;
}

const globalCtor = (): WsCtor | undefined =>
  typeof WebSocket === 'undefined' ? undefined : (WebSocket as unknown as WsCtor);

/**
 * A FeedSource for a user-defined JSON WebSocket: connects, sends the subscribe message, maps every
 * frame with the user's mapping, reports status and reconnects with exponential back-off
 * (0.5 s, 1 s, 2 s … up to 30 s plus jitter). It has no history; charts start empty and fill live.
 */
export class CustomWsFeed implements FeedSource {
  readonly kind = 'live' as const;
  readonly capabilities = { aggressor: true, ticks: true, subSecond: true };
  readonly instrument: Instrument;
  private batchL = new Set<(b: EventBatch) => void>();
  private statusL = new Set<(s: FeedStatus) => void>();
  private ws: WsLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private meter: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private running = false;
  private enabled = true;
  private msgs = 0;
  private perSec = 0;
  private lastTs = 0;
  private nextId = 0;
  private status_: FeedStatus = { state: 'disconnected', latencyMs: 0, msgsPerSec: 0 };
  private readonly now: () => number;

  constructor(
    readonly connectionId: string,
    readonly config: CustomWsConfig,
    private opts: WsFeedOptions = {},
  ) {
    this.instrument = instrumentOf(connectionId, config);
    this.now = opts.now ?? Date.now;
  }

  get status(): FeedStatus {
    return this.status_;
  }

  history(): Promise<HistoryData> {
    const t = this.now();
    return Promise.resolve({ trades: [], depth: [], book: { ts: t, bids: [], asks: [] }, end: t });
  }

  subscribe(listener: (b: EventBatch) => void): () => void {
    this.batchL.add(listener);
    return () => this.batchL.delete(listener);
  }

  onStatus(listener: (s: FeedStatus) => void): () => void {
    this.statusL.add(listener);
    listener(this.status_);
    return () => this.statusL.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.meter = setInterval(() => {
      this.perSec = this.msgs;
      this.msgs = 0;
      if (this.status_.state === 'live') this.emit({ ...this.status_, msgsPerSec: this.perSec });
    }, 1000);
    if (this.enabled) this.connect();
    else this.emit({ state: 'disconnected', latencyMs: 0, msgsPerSec: 0, message: 'Disconnected' });
  }

  stop(): void {
    this.running = false;
    this.teardown();
    if (this.meter) clearInterval(this.meter);
    this.meter = null;
    this.emit({ state: 'disconnected', latencyMs: 0, msgsPerSec: 0, message: 'Stopped' });
  }

  /** Connections window: Connect / Disconnect. */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!this.running) return;
    if (on) {
      this.attempt = 0;
      this.connect();
    } else {
      this.teardown();
      this.emit({ state: 'disconnected', latencyMs: 0, msgsPerSec: 0, message: 'Disconnected' });
    }
  }

  private teardown(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }

  private emit(s: FeedStatus): void {
    this.status_ = s;
    for (const l of this.statusL) l(s);
  }

  private connect(): void {
    const Ctor = this.opts.ctor ?? globalCtor();
    if (!Ctor) {
      this.emit({
        state: 'error',
        latencyMs: 0,
        msgsPerSec: 0,
        message: 'WebSocket is not available',
      });
      return;
    }
    const sub = renderSubscribe(this.config.subscribe ?? '', this.config.symbol);
    if (sub.error) {
      this.emit({ state: 'error', latencyMs: 0, msgsPerSec: 0, message: sub.error });
      return;
    }
    this.emit({
      state: 'connecting',
      latencyMs: 0,
      msgsPerSec: 0,
      message: this.attempt ? `Reconnecting (attempt ${this.attempt})…` : 'Connecting…',
    });
    let ws: WsLike;
    try {
      ws = new Ctor(this.config.url);
    } catch (e) {
      this.emit({
        state: 'error',
        latencyMs: 0,
        msgsPerSec: 0,
        message: `Cannot open ${this.config.url}: ${e instanceof Error ? e.message : String(e)}`,
      });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      if (sub.text) ws.send(sub.text);
      this.emit({ state: 'live', latencyMs: 0, msgsPerSec: this.perSec, message: 'Connected' });
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      this.msgs++;
      this.attempt = 0;
      const t = this.now();
      const b = mapFrame(ev.data, this.config, t, this.nextId);
      if (!b) return;
      this.nextId += b.trades.length;
      if (b.trades.length) this.lastTs = b.trades.at(-1)!.ts;
      if (this.lastTs) this.status_ = { ...this.status_, latencyMs: Math.max(0, t - this.lastTs) };
      for (const l of this.batchL) l(b);
    };
    ws.onerror = () => {
      // `close` follows and handles the reconnect.
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.running || !this.enabled) return;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const base = reconnectDelayMs(this.attempt, this.opts.maxBackoffSec ?? 30);
    const delay = Math.round(base * (1 + (this.opts.jitter ?? 0.2) * Math.random()));
    this.attempt++;
    this.emit({
      state: 'error',
      latencyMs: 0,
      msgsPerSec: 0,
      message: `Disconnected, retrying in ${(delay / 1000).toFixed(1)} s`,
    });
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.running && this.enabled) this.connect();
    }, delay);
  }
}

export interface WsTestResult {
  ok: boolean;
  text: string;
}

/** Wizard "Test connection": connects, subscribes and waits for the first frame the mapping understands. */
export function testCustomWs(
  cfg: CustomWsConfig,
  opts: { ctor?: WsCtor; timeoutMs?: number } = {},
): Promise<WsTestResult> {
  return new Promise((resolve) => {
    const Ctor = opts.ctor ?? globalCtor();
    if (!Ctor) return resolve({ ok: false, text: 'WebSocket is not available here' });
    const sub = renderSubscribe(cfg.subscribe ?? '', cfg.symbol);
    if (sub.error) return resolve({ ok: false, text: sub.error });
    let ws: WsLike;
    let opened = 0;
    let frames = 0;
    const t0 = Date.now();
    const finish = (r: WsTestResult) => {
      clearTimeout(timer);
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(r);
    };
    const timer = setTimeout(
      () =>
        finish(
          opened
            ? {
                ok: false,
                text: frames
                  ? `Connected, ${frames} message${frames === 1 ? '' : 's'} received but none matched the mapping`
                  : 'Connected, but no message arrived. Check the subscribe message.',
              }
            : { ok: false, text: 'Could not connect (timed out)' },
        ),
      opts.timeoutMs ?? 8000,
    );
    try {
      ws = new Ctor(cfg.url);
    } catch (e) {
      clearTimeout(timer);
      return resolve({
        ok: false,
        text: `Cannot open the URL: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    ws.onopen = () => {
      opened = Date.now() - t0;
      if (sub.text) ws.send(sub.text);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      frames++;
      const b = mapFrame(ev.data, cfg, Date.now());
      if (b)
        finish({
          ok: true,
          text: `OK · connected in ${opened} ms · first message mapped: ${b.trades.length} trade${b.trades.length === 1 ? '' : 's'}${b.snapshot || b.deltas.length ? ' + book' : ''}`,
        });
    };
    ws.onerror = () => undefined;
    ws.onclose = () =>
      finish({
        ok: false,
        text: opened ? 'The server closed the connection' : 'Could not connect',
      });
  });
}
