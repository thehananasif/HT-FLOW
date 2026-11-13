import { describe, expect, it } from 'vitest';
import { SearchIndex, type SearchDoc } from './search';

/** Deterministic generator of `n` instruments that look like a real stock / crypto symbol list. */
function generate(n: number): SearchDoc[] {
  const words = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'nova', 'terra', 'solar', 'quant'];
  const venues = ['NYSE', 'NASDAQ', 'BINANCE', 'OKX', 'EUREX', 'CME'];
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const docs: SearchDoc[] = [];
  const used = new Set<string>();
  for (let k = 0; docs.length < n; k++) {
    let sym = '';
    for (let c = 0; c < 3 + (k % 3); c++) sym += String.fromCharCode(65 + Math.floor(rnd() * 26));
    if (used.has(sym)) continue;
    used.add(sym);
    docs.push({
      id: `gen:${k}`,
      symbol: sym,
      root: sym,
      name: `${words[k % words.length]} ${words[(k * 7) % words.length]} holdings ${k}`,
      exchange: venues[k % venues.length]!,
    });
  }
  docs.push({
    id: 'gen:needle',
    symbol: 'ZZNEEDLE',
    root: 'ZZNEEDLE',
    name: 'Needle Industries',
    exchange: 'NYSE',
  });
  return docs;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('search benchmark (10k generated instruments)', () => {
  const docs = generate(10_000);
  const idx = new SearchIndex(docs);

  it('indexes at least 10,000 entries', () => {
    expect(idx.size).toBeGreaterThanOrEqual(10_000);
  });

  it('answers every query in under 50 ms (median of 7 runs)', () => {
    const queries = [
      'a',
      'ab',
      'nee',
      'needle',
      'nedle', // typo
      'gamma holdings',
      'nyse',
      'binance omega',
      'quantt', // typo, no real match shape
      'holdings 9999',
      'zzzzzz', // matches nothing
    ];
    for (const q of queries) {
      idx.search(q); // warm-up
      const times: number[] = [];
      for (let r = 0; r < 7; r++) {
        const t0 = performance.now();
        idx.search(q);
        times.push(performance.now() - t0);
      }
      expect(median(times), `query "${q}"`).toBeLessThan(50);
    }
  });

  it('still ranks exact and typo-tolerant hits first', () => {
    expect(idx.search('zzneedle')[0]!.doc.id).toBe('gen:needle');
    expect(idx.search('needle')[0]!.doc.id).toBe('gen:needle');
    expect(idx.search('nedle')[0]!.doc.id).toBe('gen:needle');
    expect(idx.search('zzzzzzzzzz')).toEqual([]);
  });

  it('honours limit and filter', () => {
    expect(idx.search('holdings', { limit: 25 })).toHaveLength(25);
    const nyse = idx.search('holdings', { filter: (d) => d.exchange === 'NYSE', limit: 500 });
    expect(nyse.length).toBeGreaterThan(0);
    expect(nyse.every((h) => h.doc.exchange === 'NYSE')).toBe(true);
  });
});
