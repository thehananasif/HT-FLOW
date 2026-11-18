import { describe, expect, it } from 'vitest';
import { nativeEventsToCalendar, nativeItemsToFeedItems } from './native';

describe('native feed / calendar normalisation', () => {
  it('validates items and drops unsafe links', () => {
    const items = nativeItemsToFeedItems([
      {
        guid: 'g1',
        link: 'https://a.com/x',
        title: 'Hello',
        summary: 's',
        published: 5,
        categories: ['a', 3],
      },
      { guid: 'g2', link: 'javascript:alert(1)', title: 'Bad link', summary: '', published: null },
      { link: '', title: '' },
      'junk',
    ]);
    expect(items.map((i) => i.id)).toEqual(['g:g1', 'g:g2']);
    expect(items[0]!.categories).toEqual(['a']);
    expect(items[1]!.link).toBe('');
    expect(nativeItemsToFeedItems(null)).toEqual([]);
  });

  it('normalises calendar events', () => {
    const ev = nativeEventsToCalendar([
      {
        t: 2000,
        currency: 'usd',
        title: 'CPI',
        impact: 'high',
        forecast: '0.3%',
        previous: '',
        actual: '0.4%',
      },
      { t: 1000, currency: 'EUROPE', title: 'X', impact: 'weird' },
      { t: 'bad', title: 'Y' },
      { t: 3000, title: '' },
    ]);
    expect(ev.map((e) => e.t)).toEqual([1000, 2000]);
    expect(ev[0]!.currency).toBe('');
    expect(ev[0]!.impact).toBe('low');
    expect(ev[1]).toMatchObject({
      currency: 'USD',
      impact: 'high',
      actual: '0.4%',
      forecast: '0.3%',
    });
    expect(ev[1]!.previous).toBeUndefined();
    const again = nativeEventsToCalendar([{ t: 2000, currency: 'USD', title: 'CPI' }]);
    expect(again[0]!.uid).toBe(ev[1]!.uid);
  });
});
