import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBatch } from '@htflow/market-data';
import type { CustomWsConfig } from './customWs';
import { CustomWsFeed, testCustomWs } from './customWsFeed';
import {
  nativeWsCtor,
  pickWsCtor,
  type ChannelLike,
  type NativeWsDeps,
  type NativeWsEvent,
} from './nativeWs';

const CONFIG: CustomWsConfig = {
  url: 'wss://example.test/x',
  subscribe: '{"sub":"{symbol}"}',
  symbol: 'ABC',
  tickSize: 0.01,
  pricePrecision: 2,
  qtyPrecision: 0,
  mapping: { price: 'p', qty: 'q', side: 's', timestamp: 't' },
};

/** Fake core: records invokes, hands out ids and lets the test push channel events. */
function fakeCore(opts: { reject?: string } = {}) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const channels: ChannelLike<NativeWsEvent>[] = [];
  let next = 0;
  const deps: NativeWsDeps = {
    channel: () => {
      const ch: ChannelLike<NativeWsEvent> = { onmessage: () => undefined };
      channels.push(ch);
      return ch;
    },
    invoke: (cmd, args = {}) => {
      calls.push({ cmd, args });
      if (cmd === 'custom_ws_open') {
        return opts.reject
          ? Promise.reject({ code: 'ws.bad_url', message: opts.reject })
          : Promise.resolve(++next);
      }
      return Promise.resolve(null);
    },
  };
  const push = (i: number, ev: NativeWsEvent) => channels[i]!.onmessage(ev);
  return { deps, calls, channels, push };
}

const flush = () => Promise.resolve().then(() => undefined);

describe('pickWsCtor', () => {
  it('uses the native core transport in the desktop app and the browser WebSocket otherwise', () => {
    const core = fakeCore();
    const native = pickWsCtor(true, core.deps) as unknown as { sendsSubscribe?: boolean };
    expect(native.sendsSubscribe).toBe(true);
    const web = pickWsCtor(false, core.deps) as unknown as { sendsSubscribe?: boolean } | undefined;
    expect(web?.sendsSubscribe).toBeUndefined();
    if (typeof WebSocket !== 'undefined') expect(web).toBe(WebSocket);
  });
});

describe('CustomWsFeed over the native transport', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens through the core with the subscribe message and maps relayed frames', async () => {
    const core = fakeCore();
    const feed = new CustomWsFeed('c1', CONFIG, { ctor: nativeWsCtor(core.deps), jitter: 0 });
    const batches: EventBatch[] = [];
    const states: string[] = [];
    feed.subscribe((b) => batches.push(b));
    feed.onStatus((s) => states.push(s.state));
    feed.start();
    expect(core.calls[0]).toMatchObject({
      cmd: 'custom_ws_open',
      args: { url: 'wss://example.test/x', subscribe: '{"sub":"ABC"}' },
    });
    expect(core.calls[0]!.args.channel).toBe(core.channels[0]);
    await flush();
    core.push(0, { kind: 'open' });
    // The core already sent the subscribe message: no custom_ws_send.
    expect(core.calls.map((c) => c.cmd)).toEqual(['custom_ws_open']);
    expect(feed.status.state).toBe('live');
    core.push(0, {
      kind: 'frames',
      data: [JSON.stringify({ p: 12.34, q: 2, s: 'buy', t: Date.now() }), '{"ack":1}'],
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.trades[0]).toMatchObject({ px: 1234, qty: 2, side: 'buy' });
    expect(states).toEqual(['disconnected', 'connecting', 'live']);
    feed.stop();
    expect(core.calls.at(-1)).toEqual({ cmd: 'custom_ws_close', args: { id: 1 } });
  });

  it('reconnects with back-off after a core error and shows its reason', async () => {
    const core = fakeCore();
    const feed = new CustomWsFeed('c1', CONFIG, { ctor: nativeWsCtor(core.deps), jitter: 0 });
    feed.start();
    await flush();
    core.push(0, { kind: 'error', message: 'Cannot connect: refused' });
    expect(feed.status).toMatchObject({
      state: 'error',
      message: 'Cannot connect: refused, retrying in 0.5 s',
    });
    vi.advanceTimersByTime(500);
    expect(core.calls.filter((c) => c.cmd === 'custom_ws_open')).toHaveLength(2);
    await flush();
    core.push(1, { kind: 'open' });
    core.push(1, { kind: 'closed', code: 1006, reason: 'gone' });
    expect(feed.status.message).toMatch(/retrying in 1\.0 s/);
    // Events from the dead first socket are ignored.
    core.push(0, { kind: 'open' });
    expect(feed.status.state).toBe('error');
    feed.stop();
  });

  it('closes a socket whose id arrives after close() and reports open failures', async () => {
    const core = fakeCore();
    const Ctor = nativeWsCtor(core.deps);
    const ws = new Ctor('wss://example.test/x');
    ws.close();
    await flush();
    expect(core.calls.at(-1)).toEqual({ cmd: 'custom_ws_close', args: { id: 1 } });

    const bad = fakeCore({ reject: 'Only ws:// and wss:// URLs are supported' });
    const r = testCustomWs(
      { ...CONFIG, url: 'http://x' },
      { ctor: nativeWsCtor(bad.deps), timeoutMs: 1000 },
    );
    await flush();
    await flush();
    expect(await r).toEqual({ ok: false, text: 'Only ws:// and wss:// URLs are supported' });
  });

  it('forwards later sends to custom_ws_send', async () => {
    const core = fakeCore();
    const ws = new (nativeWsCtor(core.deps))('wss://example.test/x');
    await flush();
    core.push(0, { kind: 'open' });
    ws.send('hello');
    expect(core.calls.at(-1)).toEqual({ cmd: 'custom_ws_send', args: { id: 1, text: 'hello' } });
  });
});
