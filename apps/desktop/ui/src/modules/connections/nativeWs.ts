import { Channel, invoke } from '@tauri-apps/api/core';
import type { WsCtor, WsLike } from './customWsFeed';

/**
 * Desktop transport for the Custom WebSocket connector. The Tauri webview CSP blocks ws(s) URLs,
 * so the socket lives in the Rust core (`custom_ws_open` / `custom_ws_send` / `custom_ws_close`,
 * src-tauri/src/custom_ws.rs) and raw text frames arrive over a Tauri Channel. This class wraps
 * that in the same `WsLike` surface as the browser WebSocket, so the feed's mapping, status and
 * back-off logic are shared by both builds.
 */

/** Events sent by the core (`WsEvent` in custom_ws.rs). */
export type NativeWsEvent =
  | { kind: 'open' }
  | { kind: 'frames'; data: string[] }
  | { kind: 'closed'; code?: number; reason: string }
  | { kind: 'error'; message: string };

export type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
export interface ChannelLike<T> {
  onmessage: (msg: T) => void;
}
export interface NativeWsDeps {
  invoke: InvokeFn;
  channel: () => ChannelLike<NativeWsEvent>;
}

/** A `WsCtor` whose instances send the subscribe message themselves (passed to the constructor). */
export type SubscribingWsCtor = WsCtor & {
  readonly sendsSubscribe: true;
  new (url: string, subscribe?: string): WsLike;
};

const errText = (e: unknown): string =>
  e && typeof e === 'object' && 'message' in e
    ? String((e as { message: unknown }).message)
    : String(e);

export function nativeWsCtor(deps: NativeWsDeps): SubscribingWsCtor {
  return class NativeWs implements WsLike {
    static readonly sendsSubscribe = true as const;
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    private id: number | null = null;
    private closing = false;
    private pending: string[] = [];

    constructor(url: string, subscribe?: string) {
      const ch = deps.channel();
      ch.onmessage = (ev) => this.handle(ev);
      deps.invoke('custom_ws_open', { url, subscribe: subscribe || null, channel: ch }).then(
        (id) => {
          this.id = Number(id);
          if (this.closing) return void this.closeNative();
          for (const t of this.pending.splice(0)) this.sendNative(t);
        },
        (e: unknown) => this.handle({ kind: 'error', message: errText(e) }),
      );
    }

    private handle(ev: NativeWsEvent): void {
      if (this.readyState === 3) return;
      switch (ev.kind) {
        case 'open':
          this.readyState = 1;
          this.onopen?.({});
          break;
        case 'frames':
          for (const data of ev.data) {
            if (this.readyState !== 1) break;
            this.onmessage?.({ data });
          }
          break;
        case 'error':
          this.onerror?.({ message: ev.message });
          this.finish(ev.message);
          break;
        case 'closed':
          this.finish(ev.reason, ev.code);
          break;
      }
    }

    private finish(reason: string, code?: number): void {
      this.readyState = 3;
      this.onclose?.({ reason, code });
    }

    private sendNative(text: string): void {
      deps.invoke('custom_ws_send', { id: this.id, text }).catch(() => undefined);
    }

    private closeNative(): void {
      deps.invoke('custom_ws_close', { id: this.id }).catch(() => undefined);
    }

    send(data: string): void {
      if (this.readyState !== 1) throw new Error('WebSocket is not open');
      if (this.id === null) this.pending.push(data);
      else this.sendNative(data);
    }

    close(): void {
      if (this.closing) return;
      this.closing = true;
      if (this.readyState !== 3) this.readyState = 2;
      if (this.id !== null) this.closeNative();
    }
  };
}

const tauriDeps = (): NativeWsDeps => ({
  invoke: (cmd, args) => invoke(cmd, args),
  channel: () => new Channel<NativeWsEvent>(),
});

export const isTauriWebview = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Desktop build → native transport; web build → the browser WebSocket (if any). */
export function pickWsCtor(
  tauri = isTauriWebview(),
  deps: NativeWsDeps = tauriDeps(),
): WsCtor | undefined {
  if (tauri) return nativeWsCtor(deps);
  return typeof WebSocket === 'undefined' ? undefined : (WebSocket as unknown as WsCtor);
}

/** Opens `url` with `Ctor`; reports whether the transport already sent `subscribe`. */
export function openWs(
  Ctor: WsCtor,
  url: string,
  subscribe: string,
): { ws: WsLike; sentSubscribe: boolean } {
  if ((Ctor as Partial<SubscribingWsCtor>).sendsSubscribe) {
    return { ws: new (Ctor as SubscribingWsCtor)(url, subscribe), sentSubscribe: true };
  }
  return { ws: new Ctor(url), sentSubscribe: false };
}
