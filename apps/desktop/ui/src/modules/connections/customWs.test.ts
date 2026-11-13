import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBatch, FeedStatus } from '@htflow/market-data';
import {
  DEFAULT_WS_CONFIG,
  getPath,
  mapFrame,
  mapMessage,
  parseMappingText,
  renderSubscribe,
  validateMapping,
  validateWsConfig,
  type CustomWsConfig,
  type WsMapping,
} from './customWs';
import { CustomWsFeed, testCustomWs, type WsLike } from './customWsFeed';

const cfg = (mapping: WsMapping, tickSize = 0.01) => ({ tickSize, mapping });

describe('paths', () => {
  it('resolves dotted and indexed paths', () => {
    const o = { a: { b: [{ c: 5 }, { c: 6 }] }, 'x-y': 1 };
    expect(getPath(o, 'a.b[1].c')).toBe(6);
    expect(getPath(o, 'a.b.0.c')).toBe(5);
    expect(getPath(o, '$.a.b')).toHaveLength(2);
    expect(getPath(o, 'a.z.c')).toBeUndefined();
    expect(getPath(o, '')).toBe(o);
  });
});

describe('mapMessage', () => {
  it('maps a flat trade message (Binance style, buyer maker)', () => {
    const m: WsMapping = {
      when: { path: 'e', equals: 'trade' },
      price: 'p',
      qty: 'q',
      side: 'm',
      sideMode: 'buyerMaker',
      timestamp: 'T',
    };
    const msg = { e: 'trade', p: '100.25', q: '0.5', m: true, T: 1709287200123 };
    const b = mapMessage(msg, cfg(m), 1709287200500, 10)!;
    expect(b.trades).toEqual([{ ts: 1709287200123, px: 10025, qty: 0.5, side: 'sell', id: 11 }]);
    expect(mapMessage({ ...msg, e: 'ping' }, cfg(m), 1)).toBeNull();
    expect(mapMessage({ ...msg, m: false }, cfg(m), 1709287200500)!.trades[0]!.side).toBe('buy');
  });

  it('maps nested arrays with text sides and ISO / epoch-seconds timestamps', () => {
    const m: WsMapping = {
      tradesPath: 'data',
      price: 'price',
      qty: 'size',
      side: 'side',
      timestamp: 'time',
    };
    const msg = {
      data: [
        { price: 10, size: 2, side: 'Buy', time: '2024-03-01T10:00:00Z' },
        { price: 11, size: 1, side: 'sell', time: 1709287201 },
        { price: 'bad', size: 1 },
        { price: 12, size: 0 },
      ],
    };
    const b = mapMessage(msg, cfg(m, 1), 1709287300000)!;
    expect(b.trades.map((t) => [t.ts, t.px, t.side])).toEqual([
      [Date.UTC(2024, 2, 1, 10), 10, 'buy'],
      [1709287201000, 11, 'sell'],
    ]);
  });

  it('maps book snapshots and deltas from pairs and objects', () => {
    const m: WsMapping = { price: '', qty: '', bids: 'b', asks: 'a' } as WsMapping;
    delete (m as Partial<WsMapping>).price;
    const msg = {
      b: [
        ['100', '2'],
        ['99.5', 1],
      ],
      a: [{ price: 101, size: 3 }, [100.5, 0]],
    };
    const snap = mapMessage(msg, cfg(m, 0.5), 7)!;
    expect(snap.snapshot).toEqual({
      ts: 7,
      bids: [
        [200, 2],
        [199, 1],
      ],
      asks: [[202, 3]],
    });
    const delta = mapMessage(msg, cfg({ ...m, bookMode: 'delta' }, 0.5), 7)!;
    expect(delta.deltas).toEqual([
      { side: 'buy', px: 200, qty: 2 },
      { side: 'buy', px: 199, qty: 1 },
      { side: 'sell', px: 202, qty: 3 },
      { side: 'sell', px: 201, qty: 0 },
    ]);
  });

  it('ignores non-JSON and unrelated frames', () => {
    const m = cfg({ price: 'p', qty: 'q' });
    expect(mapFrame('not json', m, 1)).toBeNull();
    expect(mapFrame('{"result":null,"id":1}', m, 1)).toBeNull();
    expect(mapFrame('{"p":1,"q":2}', m, 1)!.trades).toHaveLength(1);
  });
});

describe('validation and templates', () => {
  it('validates mappings', () => {
    expect(validateMapping({ price: 'p', qty: 'q' })).toBeNull();
    expect(validateMapping({ bids: 'b' })).toBeNull();
    expect(validateMapping({})).toMatch(/price/);
    expect(validateMapping({ price: 'p' })).toMatch(/qty/);
    expect(validateMapping({ price: 'p', qty: 'q', sideMode: 'x' })).toMatch(/sideMode/);
    expect(parseMappingText('{oops').error).toMatch(/not valid JSON/);
    expect(parseMappingText('{"price":"p","qty":"q"}').mapping).toBeDefined();
  });

  it('renders the subscribe template and validates the form', () => {
    expect(renderSubscribe('{"sub":"{symbol}@trade"}', 'ETHUSDT').text).toBe(
      '{"sub":"ETHUSDT@trade"}',
    );
    expect(renderSubscribe('{bad', 'X').error).toMatch(/valid JSON/);
    expect(renderSubscribe('  ', 'X').text).toBeUndefined();
    expect(validateWsConfig({ ...DEFAULT_WS_CONFIG, url: 'wss://example.com/s' })).toEqual({});
    const e = validateWsConfig({ ...DEFAULT_WS_CONFIG, url: 'http://x', symbol: '', tickSize: 0 });
    expect(Object.keys(e).sort()).toEqual(['symbol', 'tickSize', 'url']);
  });
});

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  msg(o: unknown) {
    this.onmessage?.({ data: typeof o === 'string' ? o : JSON.stringify(o) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const CONFIG: CustomWsConfig = {
  url: 'ws://localhost:1/x',
  subscribe: '{"sub":"{symbol}"}',
  symbol: 'ABC',
  tickSize: 0.01,
  pricePrecision: 2,
  qtyPrecision: 0,
  mapping: { price: 'p', qty: 'q', side: 's', timestamp: 't' },
};

describe('CustomWsFeed', () => {
  beforeEach(() => {
    FakeWs.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('connects, subscribes, emits mapped batches and reports status', () => {
    const feed = new CustomWsFeed('c1', CONFIG, { ctor: FakeWs, jitter: 0 });
    const states: string[] = [];
    const batches: EventBatch[] = [];
    feed.onStatus((s: FeedStatus) => states.push(s.state));
    feed.subscribe((b) => batches.push(b));
    expect(feed.instrument.id).toBe('custom-ws:c1:ABC');
    feed.start();
    const ws = FakeWs.all[0]!;
    ws.open();
    expect(ws.sent).toEqual(['{"sub":"ABC"}']);
    ws.msg({ p: 12.34, q: 2, s: 'buy', t: Date.now() });
    ws.msg({ ack: true });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.trades[0]).toMatchObject({ px: 1234, qty: 2, side: 'buy' });
    expect(states).toEqual(['disconnected', 'connecting', 'live']);
    feed.stop();
  });

  it('reconnects with exponential back-off and resets after data', () => {
    const feed = new CustomWsFeed('c1', CONFIG, { ctor: FakeWs, jitter: 0 });
    const msgs: string[] = [];
    feed.onStatus((s) => s.message && msgs.push(s.message));
    feed.start();
    FakeWs.all[0]!.drop();
    expect(feed.status.state).toBe('error');
    expect(msgs.at(-1)).toMatch(/retrying in 0\.5 s/);
    vi.advanceTimersByTime(499);
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(2);
    FakeWs.all[1]!.drop();
    expect(msgs.at(-1)).toMatch(/retrying in 1\.0 s/);
    vi.advanceTimersByTime(1000);
    FakeWs.all[2]!.drop();
    expect(msgs.at(-1)).toMatch(/retrying in 2\.0 s/);
    vi.advanceTimersByTime(2000);
    const ws = FakeWs.all[3]!;
    ws.open();
    ws.msg({ p: 1, q: 1 });
    ws.drop();
    expect(msgs.at(-1)).toMatch(/retrying in 0\.5 s/);
    feed.stop();
  });

  it('stays down while disabled and does not reconnect after stop', () => {
    const feed = new CustomWsFeed('c1', CONFIG, { ctor: FakeWs, jitter: 0 });
    feed.start();
    feed.setEnabled(false);
    expect(feed.status.state).toBe('disconnected');
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all).toHaveLength(1);
    feed.setEnabled(true);
    expect(FakeWs.all).toHaveLength(2);
    feed.stop();
    FakeWs.all[1]!.drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all).toHaveLength(2);
  });
});

describe('testCustomWs', () => {
  it('succeeds on the first mappable message and fails on timeout', async () => {
    FakeWs.all = [];
    const p = testCustomWs(CONFIG, { ctor: FakeWs, timeoutMs: 50 });
    const ws = FakeWs.all[0]!;
    ws.open();
    ws.msg('{"hello":1}');
    ws.msg({ p: 1, q: 1 });
    expect((await p).ok).toBe(true);
    const q = await testCustomWs(CONFIG, { ctor: FakeWs, timeoutMs: 20 });
    expect(q.ok).toBe(false);
    expect(q.text).toMatch(/timed out/);
  });
});
