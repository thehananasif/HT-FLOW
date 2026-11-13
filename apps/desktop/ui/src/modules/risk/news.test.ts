import { describe, expect, it } from 'vitest';
import { OrderBook } from '@htflow/market-data';
import { PaperEngine, RiskEngine, defaultRiskRules } from '@htflow/trading';
import { newsFromCalendar, type NewsSourceEvent } from './news';

const ev = (p: Partial<NewsSourceEvent>): NewsSourceEvent => ({
  t: 0,
  title: 'CPI',
  currency: 'USD',
  impact: 'high',
  allDay: false,
  sample: false,
  ...p,
});

describe('news-flatten feed from the Economic Calendar', () => {
  const now = 1_700_000_000_000;
  it('keeps upcoming high-impact, timed, real events', () => {
    const out = newsFromCalendar(
      [
        ev({ t: now + 60_000, title: 'NFP' }),
        ev({ t: now + 30_000, impact: 'medium' }),
        ev({ t: now + 30_000, allDay: true }),
        ev({ t: now + 20_000, sample: true, title: 'Sample CPI' }),
        ev({ t: now - 2 * 3_600_000 }),
        ev({ t: now + 30 * 86_400_000 }),
        ev({ t: now + 10_000, currency: '', title: 'FOMC' }),
      ],
      now,
      { includeSample: false },
    );
    expect(out).toEqual([
      { ts: now + 10_000, title: 'FOMC' },
      { ts: now + 60_000, title: 'USD NFP' },
    ]);
    const withSample = newsFromCalendar([ev({ t: now + 5, sample: true })], now, {
      includeSample: true,
    });
    expect(withSample[0]!.title).toBe('USD CPI (SAMPLE)');
  });

  it('flattens and blocks a non-default paper account before the event', () => {
    let t = now;
    const book = new OrderBook();
    book.applySnapshot({ ts: 0, bids: [[99, 100]], asks: [[100, 100]] });
    const paper = new PaperEngine({
      book: () => book,
      economics: () => ({ tickSize: 1, tickValue: 1 }),
      now: () => t,
    });
    paper.createAccount({ id: 'second', name: 'Second', startingBalance: 10_000 });
    const rules = defaultRiskRules('UTC');
    rules.newsFlatten = { enabled: true, value: 2 };
    // Default rules (no per-account entry) apply to every paper account.
    const risk = new RiskEngine(paper, { now: () => t, mark: () => 100 }, rules);
    risk.setNewsEvents(
      newsFromCalendar([ev({ t: now + 5 * 60_000 })], now, { includeSample: false }),
    );
    const buy = () =>
      paper.place({ accountId: 'second', instrumentId: 'X', side: 'buy', type: 'market', qty: 1 });
    expect(buy().status).toBe('filled');
    expect(paper.position('second', 'X').qty).toBe(1);
    t = now + 4 * 60_000; // 1 minute before the event, inside the 2-minute window
    risk.tick();
    expect(paper.position('second', 'X').qty).toBe(0);
    expect(buy().status).toBe('rejected');
  });
});
