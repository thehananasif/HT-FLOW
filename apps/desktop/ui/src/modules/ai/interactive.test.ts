import { describe, expect, it } from 'vitest';
import { alertDirection, detectLevels, splitLevels } from './levels';
import { cardMath, moneyPerTick, proposalFromArgs, proposalToArgs } from './orderCard';
import { parseSlash, QUICK_ACTIONS, SLASH, suggestSlash } from './slash';
import {
  filterConversations,
  forSave,
  sortedConversations,
  toWire,
  truncateFrom,
  type ChatMsg,
  type Conversation,
} from './chat';
import { formatContext, FULL_INCLUDE, sanitizeInclude, type ScreenSnapshot } from './context';
import { providerStatus } from './providers';

describe('price-level detection', () => {
  it('finds prices with decimals, thousands separators and plain 4+ digit numbers', () => {
    const t = 'Support at 64,250.5, resistance 65000 and 1.0842 on EURUSD';
    expect(detectLevels(t).map((l) => l.value)).toEqual([64250.5, 65000, 1.0842]);
  });

  it('ignores times, percentages, multiples, small integers and years', () => {
    const t = 'On the 15m chart 2R target, up 3.5% in 4 hours, since 2024 with 12 orders';
    expect(detectLevels(t)).toEqual([]);
  });

  it('keeps only numbers near the last price when it is known', () => {
    const t = 'Levels 64000 and 100.5 and 250000';
    expect(detectLevels(t, { ref: 64100 }).map((l) => l.value)).toEqual([64000]);
    expect(detectLevels(t).map((l) => l.value)).toEqual([64000, 100.5, 250000]);
  });

  it('accepts a year-like number when it is close to the price', () => {
    expect(detectLevels('ES at 2024', { ref: 2030 }).map((l) => l.value)).toEqual([2024]);
  });

  it('handles a dollar sign and does not match inside words or code ids', () => {
    expect(detectLevels('buy $64,100 now').map((l) => l.value)).toEqual([64100]);
    expect(detectLevels('abc1234 x1.5').map((l) => l.value)).toEqual([]);
  });

  it('splits text into parts with correct offsets', () => {
    const parts = splitLevels('Hold 100.5 then 101.25.', { ref: 100 });
    expect(parts).toEqual([
      'Hold ',
      { start: 5, end: 10, text: '100.5', value: 100.5 },
      ' then ',
      { start: 16, end: 22, text: '101.25', value: 101.25 },
      '.',
    ]);
    expect(splitLevels('no numbers here')).toEqual(['no numbers here']);
  });

  it('picks the alert direction from the side of the last price', () => {
    expect(alertDirection(101, 100)).toBe('up');
    expect(alertDirection(99, 100)).toBe('down');
    expect(alertDirection(99, null)).toBe('up');
  });
});

describe('order card risk maths', () => {
  const futures = { tickSize: 0.25, tickValue: 12.5 };
  const crypto = { tickSize: 0.1, tickValue: 0 };

  it('derives SL / TP prices from tick distances on the protective side', () => {
    const buy = proposalFromArgs(
      { side: 'buy', type: 'limit', qty: 2, price: 5000, stopLossTicks: 8, takeProfitTicks: 16 },
      { tickSize: 0.25 },
    )!;
    expect(buy).toMatchObject({ entry: 5000, stopLoss: 4998, takeProfit: 5004, qty: 2 });
    const sell = proposalFromArgs(
      { side: 'sell', type: 'market', qty: 1, stopLossTicks: 8, takeProfitTicks: 16 },
      { tickSize: 0.25, last: 5000 },
    )!;
    expect(sell).toMatchObject({ entry: 5000, stopLoss: 5002, takeProfit: 4996 });
  });

  it('computes risk in money and R-multiple for tick-valued instruments', () => {
    const p = proposalFromArgs(
      { side: 'buy', type: 'limit', qty: 2, price: 5000, stopLossTicks: 8, takeProfitTicks: 16 },
      { tickSize: 0.25 },
    )!;
    const m = cardMath(p, futures);
    expect(m.riskTicks).toBe(8);
    expect(m.risk).toBe(200); // 8 ticks × 12.5 × 2
    expect(m.reward).toBe(400);
    expect(m.r).toBe(2);
    expect(m.issues).toEqual([]);
  });

  it('uses price × qty for linear instruments (tickValue 0)', () => {
    expect(moneyPerTick(crypto, 3)).toBeCloseTo(0.3);
    const p = proposalFromArgs(
      { side: 'sell', type: 'limit', qty: 0.5, price: 100, stopLossTicks: 50, takeProfitTicks: 75 },
      crypto,
    )!;
    const m = cardMath(p, crypto);
    expect(m.risk).toBe(2.5); // 5 price units × 0.5
    expect(m.r).toBe(1.5);
  });

  it('flags missing stops and stops on the wrong side', () => {
    const p = proposalFromArgs({ side: 'buy', type: 'limit', qty: 1, price: 100 }, crypto)!;
    expect(cardMath(p, crypto).issues).toContain('noStop');
    const wrong = { ...p, stopLoss: 101, takeProfit: 99 };
    const m = cardMath(wrong, crypto);
    expect(m.issues).toEqual(expect.arrayContaining(['stopSide', 'targetSide']));
    expect(m.risk).toBeNull();
    expect(cardMath({ ...p, qty: 0 }, crypto).issues).toContain('noQty');
  });

  it('rejects arguments that are not an order', () => {
    expect(proposalFromArgs(null, crypto)).toBeNull();
    expect(proposalFromArgs({ side: 'hold', type: 'market' }, crypto)).toBeNull();
  });

  it('turns an edited card back into tool arguments', () => {
    const base = { symbol: 'ESZ6', side: 'buy', type: 'limit', qty: 1, price: 5000 };
    const p = {
      side: 'buy' as const,
      type: 'limit' as const,
      qty: 3,
      entry: 4999.5,
      stopLoss: 4997.5,
      takeProfit: 5003.5,
    };
    expect(proposalToArgs(base, p, 0.25)).toEqual({
      symbol: 'ESZ6',
      side: 'buy',
      type: 'limit',
      qty: 3,
      price: 4999.5,
      stopLossTicks: 8,
      takeProfitTicks: 16,
    });
    const market = proposalToArgs({ side: 'buy', type: 'market', qty: 1, stopPrice: 1 }, {
      ...p,
      type: 'market',
      entry: 5000,
      stopLoss: null,
    }, 0.25);
    expect(market).not.toHaveProperty('price');
    expect(market).not.toHaveProperty('stopPrice');
    expect(market).not.toHaveProperty('stopLossTicks');
  });
});

describe('slash commands', () => {
  it('parses a command with and without extra text', () => {
    expect(parseSlash('/analyse')).toMatchObject({ def: { id: 'analyse' }, rest: '' });
    expect(parseSlash('  /levels  around the open ')).toMatchObject({
      def: { id: 'levels' },
      rest: 'around the open',
    });
    expect(parseSlash('/Risk')?.def.id).toBe('risk');
    expect(parseSlash('/analyze now')?.def.id).toBe('analyse');
    expect(parseSlash('/screenshot what is this?')).toMatchObject({
      def: { id: 'screenshot', screenshot: true },
      rest: 'what is this?',
    });
  });

  it('does not treat other text as a command', () => {
    expect(parseSlash('hello /analyse')).toBeNull();
    expect(parseSlash('/unknown thing')).toBeNull();
    expect(parseSlash('/')).toBeNull();
    expect(parseSlash('1/2 of it')).toBeNull();
  });

  it('suggests commands while typing the command word only', () => {
    expect(suggestSlash('/').map((s) => s.id)).toEqual(SLASH.map((s) => s.id));
    expect(suggestSlash('/an').map((s) => s.id)).toEqual(['analyse']);
    expect(suggestSlash('/fp').map((s) => s.id)).toEqual(['footprint']);
    expect(suggestSlash('/zzz')).toEqual([]);
    expect(suggestSlash('/risk now')).toEqual([]);
    expect(suggestSlash('risk')).toEqual([]);
  });

  it('quick actions map onto slash commands', () => {
    expect(QUICK_ACTIONS.map((q) => q.id)).toEqual([
      'analyse',
      'footprint',
      'flow15',
      'risk',
      'levels',
    ]);
    for (const q of QUICK_ACTIONS) expect(SLASH.some((s) => s.id === q.slash)).toBe(true);
  });
});

describe('conversation helpers', () => {
  const conv = (id: string, over: Partial<Conversation> = {}): Conversation => ({
    id,
    title: id,
    configId: 'c',
    provider: 'openai',
    model: 'm',
    presetId: 'analyst',
    system: '',
    messages: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });
  const msg = (id: string, role: ChatMsg['role'], text: string): ChatMsg => ({
    id,
    role,
    text,
    ts: 0,
  });

  it('sorts pinned first, then newest', () => {
    const list = [
      conv('a', { updatedAt: 1 }),
      conv('b', { updatedAt: 3 }),
      conv('c', { updatedAt: 2, pinned: true }),
    ];
    expect(sortedConversations(list).map((c) => c.id)).toEqual(['c', 'b', 'a']);
  });

  it('searches titles and message text, not tool output', () => {
    const list = [
      conv('Gold plan'),
      conv('x', { messages: [msg('1', 'user', 'what about Bitcoin delta?')] }),
      conv('y', { messages: [msg('2', 'tool', 'bitcoin raw tool text')] }),
    ];
    expect(filterConversations(list, 'gold').map((c) => c.id)).toEqual(['Gold plan']);
    expect(filterConversations(list, 'BITCOIN').map((c) => c.id)).toEqual(['x']);
    expect(filterConversations(list, '  ')).toHaveLength(3);
  });

  it('truncateFrom drops a message and what follows', () => {
    const c = conv('t', {
      messages: [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c')],
    });
    expect(truncateFrom(c, '2')).toBe(true);
    expect(c.messages.map((m) => m.id)).toEqual(['1']);
    expect(truncateFrom(c, 'nope')).toBe(false);
  });

  it('sends dropped images but never saves their pixels', () => {
    const m: ChatMsg = {
      ...msg('1', 'user', 'look'),
      attachments: [{ mediaType: 'image/png', data: 'AAAA' }],
    };
    const wire = toWire([m]);
    expect(wire[0]!.parts.map((p) => p.type)).toEqual(['text', 'image']);
    const saved = forSave([conv('s', { messages: [m] })])[0]!.messages[0]!;
    expect(saved.attachments).toBeUndefined();
    expect(saved.hadImage).toBe(true);
  });
});

describe('context checkboxes', () => {
  const snap: ScreenSnapshot = {
    symbol: 'BTCUSDT',
    instrumentId: 'mock:BTCUSDT',
    timeframe: '1m',
    chartType: 'footprint',
    indicators: ['VWAP'],
    last: 64000,
    bid: 63999,
    ask: 64001,
    flow: null,
    account: { name: 'Paper', kind: 'paper', balance: 50000, currency: 'USD' },
    positions: [{ instrument: 'mock:BTCUSDT', qty: 1, avgPrice: 63900, unrealized: 100 }],
    workingOrders: 2,
    openWindows: ['chart:mock:BTCUSDT'],
  };

  it('includes everything by default', () => {
    const text = formatContext(snap, 0);
    for (const k of ['active instrument', 'timeframe', 'indicators', 'last:', 'account', 'positions'])
      expect(text).toContain(k);
  });

  it('leaves unchecked parts out completely', () => {
    const text = formatContext(snap, 0, {
      ...FULL_INCLUDE,
      positions: false,
      price: false,
      account: false,
      indicators: false,
    });
    expect(text).not.toContain('positions');
    expect(text).not.toContain('last:');
    expect(text).not.toContain('account');
    expect(text).not.toContain('VWAP');
    expect(text).not.toContain('working orders');
    expect(text).toContain('BTCUSDT');
    expect(text).toContain('timeframe: 1m');
  });

  it('sanitises stored choices', () => {
    expect(sanitizeInclude({ flow: false, price: 'no', bogus: true })).toEqual({
      ...FULL_INCLUDE,
      flow: false,
    });
    expect(sanitizeInclude(null)).toEqual(FULL_INCLUDE);
  });
});

describe('provider status chip', () => {
  it('is green only for a saved key (or a keyless local model) that was reachable', () => {
    expect(providerStatus({ kind: 'openai', hasKey: false }, undefined)).toBe('nokey');
    expect(providerStatus({ kind: 'openai', hasKey: true }, undefined)).toBe('untested');
    expect(providerStatus({ kind: 'openai', hasKey: true }, { ok: true })).toBe('ok');
    expect(providerStatus({ kind: 'openai', hasKey: true }, { ok: false })).toBe('failed');
    expect(providerStatus({ kind: 'ollama', hasKey: false }, { ok: true })).toBe('ok');
  });
});
