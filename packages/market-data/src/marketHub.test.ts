import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketHub } from './marketStore';
import { MockFeed } from './mockFeed';

describe('MarketHub', () => {
  afterEach(() => vi.useRealTimers());

  it('shares one store per instrument and stops unused feeds after the grace period', async () => {
    vi.useFakeTimers();
    const feeds: MockFeed[] = [];
    const hub = new MarketHub((id) => {
      const f = new MockFeed(id.replace('mock:', ''), {
        historyHours: 0.02,
        depthMinutes: 0.5,
        now: 1_700_000_000_000,
      });
      feeds.push(f);
      return f;
    }, 1000);
    const a = hub.retain('mock:CLZ6');
    const b = hub.retain('mock:CLZ6');
    expect(a).toBe(b);
    expect(feeds).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(a.ready).toBe(true);
    hub.release('mock:CLZ6');
    hub.release('mock:CLZ6');
    // Re-retained within the grace period: same store, feed keeps running.
    await vi.advanceTimersByTimeAsync(500);
    expect(hub.retain('mock:CLZ6')).toBe(a);
    hub.release('mock:CLZ6');
    await vi.advanceTimersByTimeAsync(1500);
    expect(hub.peek('mock:CLZ6')).toBeUndefined();
  });
});
