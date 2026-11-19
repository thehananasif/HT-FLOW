import { describe, expect, it } from 'vitest';
import { PaperEngine, RiskEngine, defaultRiskRules } from '@htflow/trading';
import type { Trade } from '@htflow/market-data';
import { codeBlocks, parseInline, parseMarkdown, safeHref } from './markdown';
import { AGENT_TAG, AgentGuard, installAgentGuard, sanitizeLimits, symbolAllowed } from './guard';
import { flowStats, runTool, TOOL_DEFS, type ToolDeps } from './tools';
import { runTurn, toWire, forSave, type Conversation } from './chat';
import { createMockNative } from './native';
import { checkBaseUrl, sanitizeConfigs, newCustomId, defaultConfigs } from './providers';

describe('markdown (sanitized by construction)', () => {
  it('parses blocks and inline marks', () => {
    const b = parseMarkdown(
      '# Title\n\nSome **bold** and `code`.\n\n- a\n- b\n\n```ts\nconst x = 1;\n```',
    );
    expect(b.map((x) => x.t)).toEqual(['h', 'p', 'ul', 'code']);
    expect(codeBlocks('```\nx\n```')).toEqual(['x']);
    const t = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(t[0]!.t).toBe('table');
  });
  it('never produces unsafe links or HTML', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('https://example.com/x')).toBe('https://example.com/x');
    const inl = parseInline('[click](javascript:alert(1)) <img src=x onerror=alert(1)>');
    expect(inl.some((n) => n.t === 'a')).toBe(false);
    expect(JSON.stringify(inl)).toContain('<img src=x');
    // The HTML stays a text node: it is rendered as text, never as markup.
    expect(inl.every((n) => n.t === 'text')).toBe(true);
  });
});

describe('providers', () => {
  it('mirrors the native allow-list', () => {
    expect(checkBaseUrl('openai', '')).toBeNull();
    expect(checkBaseUrl('openai', 'https://evil.com/v1')).toMatch(/Only https/);
    expect(checkBaseUrl('openai', 'http://api.openai.com/v1')).toMatch(/Only https/);
    expect(checkBaseUrl('custom', 'http://example.com/v1')).toMatch(/https/);
    expect(checkBaseUrl('custom', 'http://localhost:8080/v1')).toBeNull();
    expect(checkBaseUrl('custom', 'https://192.168.1.4/v1')).toMatch(/Private/);
    expect(checkBaseUrl('ollama', 'http://example.com/v1')).toMatch(/Local/);
    expect(checkBaseUrl('qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1')).toBeNull();
  });
  it('sanitizes configs and never keeps key material', () => {
    const c = sanitizeConfigs([
      { id: 'openai', kind: 'openai', apiKey: 'sk-secret', models: ['m'] },
      { id: 'BAD ID', kind: 'openai' },
    ]);
    expect(c.find((x) => x.id === 'openai')).not.toHaveProperty('apiKey');
    expect(c.some((x) => x.id === 'BAD ID')).toBe(false);
    expect(c.length).toBe(defaultConfigs().length);
    expect(newCustomId(c)).toBe('custom-1');
    expect(newCustomId(c, 'openai')).toBe('openai-2');
  });
});

function engine() {
  const paper = new PaperEngine({
    book: () => undefined,
    economics: () => ({ tickSize: 1, tickValue: 0 }),
  });
  paper.createAccount({ id: 'p', name: 'Paper', startingBalance: 10_000 });
  return paper;
}

const trades: Trade[] = [
  { ts: 1_000, px: 100, qty: 2, side: 'buy', id: 1 },
  { ts: 2_000, px: 101, qty: 1, side: 'sell', id: 2 },
  { ts: 61_000, px: 101, qty: 10, side: 'buy', id: 3 },
];

function deps(paper: PaperEngine, guard: AgentGuard, confirm = true): ToolDeps {
  return {
    paper,
    guard,
    accountId: () => 'p',
    resolve: (s) => (s ? `mock:${s}` : 'mock:ES'),
    market: (id) => ({
      symbol: id.slice(5),
      tickSize: 0.25,
      pricePrecision: 2,
      lastPx: 101,
      bestBid: 100,
      bestAsk: 101,
      trades,
    }),
    dayPnl: () => 0,
    confirm: async () => confirm,
    addAlert: () => null,
    now: () => 120_000,
  };
}

describe('agent guard + tool dispatch', () => {
  it('flow stats', () => {
    const s = flowStats(trades, 0.25);
    expect(s.buyVolume).toBe(12);
    expect(s.sellVolume).toBe(1);
    expect(s.delta).toBe(11);
    expect(s.poc).toBe(25.25);
    expect(s.cumulativeDeltaPerMinute.map((x) => x.cumDelta)).toEqual([1, 11]);
  });

  it('symbols and limits', () => {
    expect(symbolAllowed('binance-futures:BTCUSDT', ['btcusdt'])).toBe(true);
    expect(symbolAllowed('mock:ES', ['NQ'])).toBe(false);
    expect(sanitizeLimits({ maxQty: -5, maxOrdersPerHour: 'x' }).maxQty).toBeGreaterThan(0);
  });

  it('rejects over-limit orders in the engine, accepts within limits', async () => {
    const paper = engine();
    const guard = new AgentGuard();
    guard.setLimits({
      maxQty: 2,
      maxOrdersPerHour: 2,
      dailyLossStop: 100,
      allowedSymbols: ['ES'],
      confirmEachTrade: false,
    });
    installAgentGuard(
      paper,
      guard,
      () => 0,
      () => 0,
    );
    const d = deps(paper, guard);
    // Tool layer rejects before reaching the engine.
    const big = await runTool(
      'place_order',
      { symbol: 'ES', side: 'buy', type: 'limit', qty: 5, price: 20 },
      d,
    );
    expect(big.ok).toBe(false);
    expect(big.summary).toMatch(/above the maximum/);
    const sym = await runTool(
      'place_order',
      { symbol: 'NQ', side: 'buy', type: 'limit', qty: 1, price: 20 },
      d,
    );
    expect(sym.summary).toMatch(/allowed symbols/);
    // An order tagged by the agent that bypasses the tool layer is still rejected by the engine.
    const direct = paper.place({
      accountId: 'p',
      instrumentId: 'mock:ES',
      side: 'buy',
      type: 'limit',
      qty: 9,
      px: 80,
      tag: AGENT_TAG,
    });
    expect(direct.status).toBe('rejected');
    expect(direct.reason).toMatch(/above the maximum/);
    // Untagged (manual) orders are not affected by the AI limits.
    expect(
      paper.place({
        accountId: 'p',
        instrumentId: 'mock:ES',
        side: 'buy',
        type: 'limit',
        qty: 9,
        px: 80,
      }).status,
    ).toBe('working');
    const ok = await runTool(
      'place_order',
      { symbol: 'ES', side: 'buy', type: 'limit', qty: 1, price: 20 },
      d,
    );
    expect(ok.ok).toBe(true);
    await runTool(
      'place_order',
      { symbol: 'ES', side: 'buy', type: 'limit', qty: 1, price: 20 },
      d,
    );
    const third = await runTool(
      'place_order',
      { symbol: 'ES', side: 'buy', type: 'limit', qty: 1, price: 20 },
      d,
    );
    expect(third.summary).toMatch(/orders per hour/);
  });

  it('existing risk engine rules also reject agent orders', async () => {
    const paper = engine();
    const risk = new RiskEngine(paper, { mark: () => 100 }, defaultRiskRules('UTC'));
    risk.setRules('p', {
      ...defaultRiskRules('UTC'),
      maxPositionSize: { enabled: true, value: 1, perInstrument: {} },
    });
    const guard = new AgentGuard();
    guard.setLimits({ ...sanitizeLimits({}), maxQty: 5, confirmEachTrade: false });
    installAgentGuard(paper, guard, () => 0);
    const r = await runTool(
      'place_order',
      { symbol: 'ES', side: 'buy', type: 'market', qty: 3 },
      deps(paper, guard),
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/Rejected/);
  });

  it('kill switch, live arming, confirmation and daily loss', async () => {
    const paper = engine();
    const guard = new AgentGuard();
    guard.setLimits({ ...sanitizeLimits({}), maxQty: 5, confirmEachTrade: true });
    const declined = await runTool(
      'place_order',
      { side: 'buy', type: 'limit', qty: 1, price: 20 },
      deps(paper, guard, false),
    );
    expect(declined.summary).toMatch(/declined/);
    expect(
      guard.check(
        { accountId: 'x', instrumentId: 'mock:ES', qty: 1 },
        { accountKind: 'broker', dayPnl: 0, now: 0 },
      ),
    ).toMatch(/arm live/);
    guard.armLive(true);
    expect(
      guard.check(
        { accountId: 'x', instrumentId: 'mock:ES', qty: 1 },
        { accountKind: 'broker', dayPnl: 0, now: 0 },
      ),
    ).toBeNull();
    expect(
      guard.check(
        { accountId: 'x', instrumentId: 'mock:ES', qty: 1 },
        { accountKind: 'paper', dayPnl: -500, now: 0 },
      ),
    ).toMatch(/daily loss/);
    guard.kill();
    expect(guard.isLiveArmed).toBe(false);
    expect(
      guard.check(
        { accountId: 'x', instrumentId: 'mock:ES', qty: 1 },
        { accountKind: 'paper', dayPnl: 0, now: 0 },
      ),
    ).toMatch(/kill switch/);
  });

  it('read tools report in price units', async () => {
    const paper = engine();
    const r = await runTool('get_market_data', {}, deps(paper, new AgentGuard()));
    expect(r.result).toMatchObject({ last: 25.25, bid: 25, ask: 25.25, spread: 0.25 });
    expect(TOOL_DEFS.every((t) => /^[a-z_]+$/.test(t.name))).toBe(true);
  });
});

describe('turn loop', () => {
  const conv = (): Conversation => ({
    id: 'c',
    title: '',
    configId: 'openai',
    provider: 'openai',
    model: 'm',
    presetId: 'agent',
    system: '',
    messages: [
      {
        id: 'u',
        role: 'user',
        text: 'go',
        ts: 0,
        image: { mediaType: 'image/jpeg', data: 'AAAA' },
        hadImage: true,
      },
    ],
    createdAt: 0,
    updatedAt: 0,
  });

  it('runs tools between model calls and stops at the step limit', async () => {
    const log = { requests: [] as never[] };
    const native = createMockNative(
      { toolCalls: [{ name: 'get_positions', arguments: {} }], tokenMs: 0 },
      log,
    );
    const c = conv();
    const ran: string[] = [];
    await runTurn(c, {
      native,
      target: { configId: 'openai' },
      tools: TOOL_DEFS,
      maxSteps: 4,
      signal: { stopped: false },
      onChange: () => undefined,
      runTool: async (n) => (ran.push(n), { ok: true, result: { positions: [] }, summary: 'ok' }),
    });
    expect(ran).toEqual(['get_positions']);
    expect(c.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(c.messages.at(-1)!.text).toContain('Tool results');
    // Second request carries the tool call and its result.
    const wire = (log.requests as unknown as { messages: unknown[] }[])[1]!.messages;
    expect(JSON.stringify(wire)).toContain('"toolResult"');
    expect(JSON.stringify(wire)).toContain('"toolCall"');
  });

  it('step limit and persistence drop images', async () => {
    const native = createMockNative({
      toolCalls: [{ name: 'get_positions', arguments: {} }],
      tokenMs: 0,
    });
    const c = conv();
    // The mock calls tools only when the last message is not a tool result: limit 1 stops after tools.
    await runTurn(c, {
      native,
      target: { configId: 'openai' },
      tools: TOOL_DEFS,
      maxSteps: 1,
      signal: { stopped: false },
      onChange: () => undefined,
      runTool: async () => ({ ok: true, result: {}, summary: 'ok' }),
    });
    expect(c.messages.at(-1)!.error).toMatch(/step/);
    const saved = forSave([c]);
    expect(JSON.stringify(saved)).not.toContain('AAAA');
    expect(saved[0]!.messages[0]!.hadImage).toBe(true);
    expect(toWire(saved[0]!.messages)[0]!.parts.some((p) => p.type === 'image')).toBe(false);
  });
});
