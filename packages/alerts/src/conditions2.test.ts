import { describe, expect, it } from 'vitest';
import {
  AlertEngine,
  DeliveryThrottle,
  describeCondition,
  discordBody,
  isDiscordWebhook,
  isTelegramChatId,
  isTelegramToken,
  newAlert,
  normalizeAlert,
  normalizeAlerts,
  redactSecrets,
  telegramSendUrl,
  validateCondition,
  type AlertCondition,
  type AlertFire,
} from './index';

function setup(condition: AlertCondition, patch = {}) {
  let now = 1_000_000;
  const eng = new AlertEngine(() => now);
  const fires: AlertFire[] = [];
  eng.onFire((f) => fires.push(f));
  eng.add(newAlert(condition, { cooldownMs: 0, ...patch }, now));
  return { eng, fires, tick: (ms: number) => (now += ms) };
}

describe('funding alerts', () => {
  it('fires when the rate enters the condition (percent units), once per entry', () => {
    const a = setup({ kind: 'funding', instrumentId: 'X', op: 'gte', value: 0.05 });
    a.eng.onFunding('X', { ts: 1, rate: 0.0001 }); // 0.01 %
    expect(a.fires).toHaveLength(0);
    a.eng.onFunding('X', { ts: 2, rate: 0.0006 }); // 0.06 %
    a.eng.onFunding('X', { ts: 3, rate: 0.0007 });
    expect(a.fires).toHaveLength(1);
    expect(a.fires[0]!.message).toContain('0.06%');
    a.eng.onFunding('X', { ts: 4, rate: 0.0001 });
    a.eng.onFunding('X', { ts: 5, rate: 0.001 });
    expect(a.fires).toHaveLength(2);
    a.eng.onFunding('Y', { ts: 6, rate: 1 });
    expect(a.fires).toHaveLength(2);
  });

  it('|rate| ≥ value catches negative funding', () => {
    const a = setup({ kind: 'funding', instrumentId: 'X', op: 'abs-gte', value: 0.03 });
    a.eng.onFunding('X', { ts: 1, rate: -0.0005 });
    expect(a.fires).toHaveLength(1);
    const b = setup({ kind: 'funding', instrumentId: 'X', op: 'lte', value: -0.01 });
    b.eng.onFunding('X', { ts: 1, rate: 0.0001 });
    b.eng.onFunding('X', { ts: 1, rate: -0.0002 });
    expect(b.fires).toHaveLength(1);
  });
});

describe('liquidation alerts', () => {
  const liq = (ts: number, qty: number, side: 'buy' | 'sell' = 'sell') => ({
    ts,
    qty,
    side,
    px: 100,
  });
  it('single liquidation ≥ size with a side filter', () => {
    const a = setup({
      kind: 'liquidation',
      instrumentId: 'X',
      side: 'sell',
      minQty: 10,
      windowMs: 0,
    });
    a.eng.onLiquidations('X', [liq(1, 5), liq(2, 20, 'buy'), liq(3, 12)]);
    expect(a.fires).toHaveLength(1);
    expect(a.fires[0]!.message).toBe('Long liquidation 12');
  });

  it('rolling window sum fires on entry and re-arms after it drops below', () => {
    const a = setup({
      kind: 'liquidation',
      instrumentId: 'X',
      side: 'any',
      minQty: 10,
      windowMs: 60_000,
    });
    a.eng.onLiquidations('X', [liq(0, 4), liq(10_000, 4)]);
    expect(a.fires).toHaveLength(0);
    a.eng.onLiquidations('X', [liq(20_000, 4, 'buy'), liq(21_000, 1)]);
    expect(a.fires).toHaveLength(1);
    a.eng.onLiquidations('X', [liq(200_000, 1)]); // window emptied → re-armed
    a.eng.onLiquidations('X', [liq(201_000, 9.5)]);
    expect(a.fires).toHaveLength(2);
  });
});

describe('drawing alerts (unified with the engine)', () => {
  it('uses the installed detector on consecutive trades', () => {
    const a = setup({
      kind: 'drawing',
      instrumentId: 'X',
      windowId: 'w1',
      drawingId: 'd1',
      label: 'Horizontal line',
    });
    const t = (ts: number, px: number) => ({ ts, px, qty: 1, side: 'buy' });
    a.eng.onTrades('X', [t(1, 99), t(2, 101)]);
    expect(a.fires).toHaveLength(0); // no detector yet
    a.eng.setDrawingDetector((c, prev, cur) =>
      c.drawingId === 'd1' && prev.px < 100 && cur.px >= 100
        ? { message: 'crossed above Horizontal line', px: 100 }
        : null,
    );
    a.eng.onTrades('X', [t(3, 99), t(4, 99), t(5, 100)]);
    expect(a.fires).toHaveLength(1);
    expect(a.fires[0]!.px).toBe(100);
    expect(describeCondition(a.eng.list()[0]!.condition)).toBe('X Horizontal line (drawing)');
  });
});

describe('indicator value alerts', () => {
  it('cross-up / gte on pushed values', () => {
    const a = setup({
      kind: 'indicator',
      instrumentId: 'X',
      key: 'rsi14',
      label: 'RSI (14)',
      op: 'cross-up',
      value: 70,
    });
    a.eng.onValue('X', 'rsi14', 60);
    a.eng.onValue('X', 'other', 90);
    a.eng.onValue('X', 'rsi14', 71);
    a.eng.onValue('X', 'rsi14', 65);
    expect(a.fires.map((f) => f.message)).toEqual(['RSI (14) crossed above 70']);
    const b = setup({
      kind: 'indicator',
      instrumentId: 'X',
      key: 'k',
      label: 'K',
      op: 'lte',
      value: 20,
    });
    b.eng.onValue('X', 'k', 10);
    b.eng.onValue('X', 'k', 5);
    expect(b.fires).toHaveLength(1);
  });
});

describe('validation and normalisation', () => {
  it('validates new kinds', () => {
    expect(
      validateCondition({ kind: 'funding', instrumentId: 'X', op: 'abs-gte', value: 0 }),
    ).not.toEqual([]);
    expect(
      validateCondition({
        kind: 'liquidation',
        instrumentId: 'X',
        side: 'any',
        minQty: 1,
        windowMs: -1,
      }),
    ).toEqual(['Window must be 0 or more']);
    expect(
      validateCondition({
        kind: 'indicator',
        instrumentId: 'X',
        key: '',
        label: '',
        op: 'gte',
        value: 1,
      }),
    ).toEqual(['Choose an indicator']);
  });

  it('normalizes saved alerts: defaults for new action flags, bad rows dropped', () => {
    const old = {
      id: 'a1',
      condition: { kind: 'price-cross', instrumentId: 'X', px: 10, direction: 'any' },
      actions: { popup: true, sound: false, desktop: false, log: true },
      enabled: true,
      maxTriggers: 0,
      fired: 2,
      lastFiredAt: null,
      expiresAt: null,
      cooldownMs: 0,
      createdAt: 5,
    };
    const a = normalizeAlert(old)!;
    expect(a.actions).toMatchObject({ sound: false, flash: false, telegram: false });
    expect(a.fired).toBe(2);
    expect(normalizeAlert({ id: 'x', condition: { kind: 'nope' } })).toBeNull();
    expect(normalizeAlerts([old, old, null, { id: 3 }])).toHaveLength(1);
  });
});

describe('delivery helpers', () => {
  it('validates Telegram and Discord settings', () => {
    expect(isTelegramToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')).toBe(true);
    expect(isTelegramToken('abc')).toBe(false);
    expect(isTelegramChatId('-1001234567890')).toBe(true);
    expect(isTelegramChatId('@my_channel')).toBe(true);
    expect(isTelegramChatId('hello')).toBe(false);
    expect(isDiscordWebhook('https://discord.com/api/webhooks/123456/abc-DEF_9')).toBe(true);
    expect(isDiscordWebhook('http://discord.com/api/webhooks/123456/abc')).toBe(false);
    expect(isDiscordWebhook('https://evil.example/api/webhooks/1/abc')).toBe(false);
  });

  it('builds the Telegram GET url and Discord body', () => {
    const u = new URL(telegramSendUrl(' 1:tok ', '42', 'hi & bye'));
    expect(u.origin + u.pathname).toBe('https://api.telegram.org/bot1:tok/sendMessage');
    expect(u.searchParams.get('chat_id')).toBe('42');
    expect(u.searchParams.get('text')).toBe('hi & bye');
    const body = JSON.parse(discordBody('x'.repeat(3000))) as { content: string };
    expect(body.content).toHaveLength(2000);
    expect(redactSecrets('url bot123456:secret here', ['123456:secret'])).toBe('url bot••• here');
  });

  it('throttles remote sends', () => {
    const t = new DeliveryThrottle(2, 1000);
    expect([t.take(0), t.take(1), t.take(2), t.take(1001), t.take(1002)]).toEqual([
      true,
      true,
      false,
      true,
      true,
    ]);
  });
});
