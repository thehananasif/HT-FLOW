import { describe, expect, it } from 'vitest';
import {
  catalog,
  contractCode,
  editDistance,
  expiryDate,
  frontContract,
  inSession,
  listContracts,
  matchFeedInstrument,
  nextRoll,
  normalizeCryptoSymbol,
  parseContractCode,
  pushRecent,
  sanitizePrefs,
  SearchIndex,
  sessionAt,
  SESSIONS,
  toggleFavourite,
  type CatalogInstrument,
} from './index';

const cat = catalog();
const d = (s: string) => new Date(s + 'T00:00:00Z');
const iso = (x: Date | null) => x?.toISOString().slice(0, 10);

describe('Appendix A seed', () => {
  // Every root named with a [ROOT] in Appendix A.
  const ROOTS =
    'ZC ZO ZR ZM ZL ZS ZW DC CC KC CT HE LE XC XW ZN ZT ZQ ZB ZF SR1 SR3 10Y 2YY 5YY 30Y TN UB FGBM FGBL FGBX FGBS QM QG HO CL MCL NG RB FDAX FESX NQ ES EMD FDXS MYM MNQ M2K MES FSXE FDXM RTY YM NKD FVS 6A BTC 6L 6B 6C E7 ETH 6E RP RY 6J 6M M6A MBT MCD MET M6E M6B MJY 6N 6R 6Z 6S DX 1OZ HG MGC GC SI QC QI MHG SIL YI YG PA VX VXM HHI HSI HTI MCH MHI CUS'.split(
      ' ',
    );
  it('contains every Appendix A futures root', () => {
    const missing = ROOTS.filter((r) => !cat.byRoot(r));
    expect(missing).toEqual([]);
  });
  it('contains the unrooted Appendix A names', () => {
    for (const n of [
      'E-nano DJIA',
      'E-nano Nasdaq-100',
      'E-nano Russell 2000',
      'E-nano S&P 500',
      'MSCI China A 50 Connect',
      'MSCI Taiwan Index',
      'Space Exploration Technologies',
      'Walt Disney',
      'Tesla (Micro)',
    ])
      expect(cat.instruments.some((i) => i.name === n)).toBe(true);
  });
  it('has every crypto venue group and the dxFeed groups', () => {
    const tree = cat.tree();
    expect(tree.map((g) => g.name)).toEqual([
      'US and EU Futures',
      'Crypto',
      'US Stocks & Other',
      'Single Stock Futures',
      'dxFeed',
    ]);
    const crypto = tree.find((g) => g.name === 'Crypto')!.subGroups.map((s) => s.name);
    expect(crypto).toHaveLength(17);
    expect(crypto).toContain('Bybit Inverse');
    expect(crypto).toContain('Deribit (options & futures)');
    const dx = tree.find((g) => g.name === 'dxFeed')!.subGroups;
    expect(dx.map((s) => s.name)).toEqual([
      'CBOT',
      'CME',
      'COMEX',
      'EUREX',
      'IFUS (ICE US)',
      'NYBOT',
      'NYMEX',
    ]);
    expect(dx.every((s) => s.ids.length > 0)).toBe(true);
    const sub = tree[0]!.subGroups.map((s) => s.name);
    expect(sub).toEqual([
      'Agricultural',
      'Interest Rates',
      'Energy',
      'Equity Index',
      'FX',
      'Metals',
    ]);
  });
  it('every instrument is well formed', () => {
    for (const i of cat.instruments) {
      expect(i.tickSize, i.id).toBeGreaterThan(0);
      expect(i.sessions.length, i.id).toBeGreaterThan(0);
      expect(i.spec_source_url, i.id).toMatch(/^https:\/\//);
      if (i.assetClass === 'future' && i.contract) {
        expect(Math.abs(i.pointValue * i.tickSize - i.tickValue), i.id).toBeLessThan(1e-9);
        expect(listContracts(i.root, i.contract, d('2026-11-04')).length, i.id).toBeGreaterThan(0);
      }
    }
  });
  it('maps CL, GC, ES, NQ and BTCUSDT to the built-in simulator', () => {
    const sim = (id: string) =>
      cat.instruments.filter((i) =>
        i.providers.some((p) => p.provider === 'sim' && p.symbol === id),
      );
    expect(sim('mock:CLZ6').map((i) => i.root)).toEqual(['CL']);
    expect(sim('mock:GCZ6').map((i) => i.root)).toEqual(['GC']);
    expect(sim('mock:ESZ6').map((i) => i.root)).toEqual(['ES']);
    expect(sim('mock:NQZ6').map((i) => i.root)).toEqual(['NQ']);
    expect(sim('mock:BTCUSDT').map((i) => i.symbol)).toEqual(['BTCUSDT']);
  });
  it('core contract economics', () => {
    const es = cat.byRoot('ES')!;
    expect([es.tickSize, es.tickValue, es.pointValue, es.verified]).toEqual([0.25, 12.5, 50, true]);
    const cl = cat.byRoot('CL')!;
    expect([cl.tickSize, cl.tickValue, cl.pointValue, cl.multiplier]).toEqual([
      0.01, 10, 1000, 1000,
    ]);
    expect(cl.name).toBe('Light Sweet Crude');
    expect(cat.byRoot('ZN')!.pointValue).toBe(1000);
  });
});

describe('expiry and roll', () => {
  it('generates contract codes', () => {
    expect(contractCode('CL', 2026, 11)).toBe('CLZ6');
    expect(contractCode('CL', 2027, 0, 2)).toBe('CLF27');
    expect(parseContractCode('CLZ6', d('2026-11-04'))).toEqual({
      root: 'CL',
      month: 11,
      year: 2026,
    });
    expect(parseContractCode('ESH27', d('2026-11-04'))).toEqual({
      root: 'ES',
      month: 2,
      year: 2027,
    });
    expect(parseContractCode('BTCUSDT')).toBeNull();
  });
  it('equity index: third Friday', () => {
    expect(iso(expiryDate({ kind: 'nthWeekday', n: 3, weekday: 5 }, 2026, 11))).toBe('2026-12-18');
    expect(iso(expiryDate({ kind: 'nthWeekday', n: 3, weekday: 5 }, 2027, 2))).toBe('2027-03-19');
  });
  it('CL: 3 business days before the 25th of the prior month', () => {
    const cl = cat.byRoot('CL')!.contract!;
    // CLF7: 25 Dec 2026 is a Friday (holiday ignored) → 22 Dec 2026.
    expect(iso(expiryDate(cl.expiry, 2027, 0))).toBe('2026-12-22');
    // CLZ6: 25 Nov 2026 is a Wednesday → 20 Nov 2026.
    expect(iso(expiryDate(cl.expiry, 2026, 11))).toBe('2026-11-20');
    // CLX6 (Nov): 25 Oct 2026 is a Sunday → Fri 23 Oct → 20 Oct.
    expect(iso(expiryDate(cl.expiry, 2026, 10))).toBe('2026-10-20');
  });
  it('NG, metals, grains, FX, VIX, CME bitcoin', () => {
    expect(iso(expiryDate(cat.byRoot('NG')!.contract!.expiry, 2026, 11))).toBe('2026-11-26');
    expect(iso(expiryDate(cat.byRoot('GC')!.contract!.expiry, 2026, 11))).toBe('2026-12-29');
    expect(iso(expiryDate(cat.byRoot('ZC')!.contract!.expiry, 2026, 11))).toBe('2026-12-14');
    expect(iso(expiryDate(cat.byRoot('6E')!.contract!.expiry, 2026, 11))).toBe('2026-12-14');
    expect(iso(expiryDate(cat.byRoot('VX')!.contract!.expiry, 2026, 11))).toBe('2026-12-16');
    expect(iso(expiryDate(cat.byRoot('BTC')!.contract!.expiry, 2026, 11))).toBe('2026-12-25');
  });
  it('lists contracts and rolls the front month by date', () => {
    const es = cat.byRoot('ES')!;
    const list = listContracts('ES', es.contract!, d('2026-11-04'), 3).map((c) => c.code);
    expect(list).toEqual(['ESZ6', 'ESH7', 'ESM7']);
    expect(frontContract('ES', es.contract!, d('2026-12-09'))!.code).toBe('ESZ6');
    expect(frontContract('ES', es.contract!, d('2026-12-11'))!.code).toBe('ESH7');
    const roll = nextRoll('ES', es.contract!, d('2026-11-04'))!;
    expect([roll.from.code, roll.to.code, iso(roll.date), roll.days]).toEqual([
      'ESZ6',
      'ESH7',
      '2026-12-10',
      36,
    ]);
    const cl = cat.byRoot('CL')!;
    expect(cat.frontCode(cl, d('2026-11-04'))).toBe('CLZ6');
    expect(cat.frontCode(cl, d('2026-11-18'))).toBe('CLF7');
  });
});

describe('sessions', () => {
  it('CME Globex ETH vs RTH (Chicago time, DST aware)', () => {
    const s = SESSIONS.cmeEquity;
    // Wed 4 Nov 2026 15:00 UTC = 09:00 CST → RTH
    expect(sessionAt(s, Date.parse('2026-11-04T15:00:00Z'))).toBe('RTH');
    // Wed 4 Nov 2026 03:00 UTC = Tue 21:00 CST → ETH
    expect(sessionAt(s, Date.parse('2026-11-04T03:00:00Z'))).toBe('ETH');
    // Wed 22:30 UTC = 16:30 CST → maintenance break
    expect(sessionAt(s, Date.parse('2026-11-04T22:30:00Z'))).toBeNull();
    // Saturday closed
    expect(sessionAt(s, Date.parse('2026-11-07T15:00:00Z'))).toBeNull();
    // Sunday 18:00 CST opens
    expect(sessionAt(s, Date.parse('2026-11-09T00:30:00Z'))).toBe('ETH');
  });
  it('HKEX lunch break and crypto 24/7', () => {
    const rth = SESSIONS.hkex[0]!;
    expect(inSession(rth, Date.parse('2026-11-04T02:00:00Z'))).toBe(true); // 10:00 HKT
    expect(inSession(rth, Date.parse('2026-11-04T04:30:00Z'))).toBe(false); // 12:30 HKT
    expect(sessionAt(SESSIONS.crypto, Date.parse('2026-11-07T12:00:00Z'))).toBe('ETH');
  });
});

describe('roll by volume', () => {
  const now = d('2026-12-01');
  const es = cat.byRoot('ES')!.contract!;
  const volSpec = { ...es, roll: { kind: 'volume' as const, fallbackDaysBefore: 8 } };
  it('falls back to the date rule without volume data', () => {
    expect(frontContract('ES', volSpec, now)!.code).toBe(frontContract('ES', es, now)!.code);
    expect(frontContract('ES', volSpec, now, 1, {})!.code).toBe('ESZ6');
    expect(frontContract('ES', volSpec, now, 1, { ESZ6: 100 })!.code).toBe('ESZ6');
  });
  it('rolls as soon as the next contract trades more', () => {
    expect(frontContract('ES', volSpec, now, 1, { ESZ6: 100, ESH7: 90 })!.code).toBe('ESZ6');
    expect(frontContract('ES', volSpec, now, 1, { ESZ6: 100, ESH7: 150 })!.code).toBe('ESH7');
    const r = nextRoll('ES', volSpec, now, 1, { ESZ6: 100, ESH7: 150 })!;
    expect([r.from.code, r.to.code]).toEqual(['ESH7', 'ESM7']);
  });
  it('date rule still applies after the date-rule roll, and date specs ignore volume', () => {
    expect(frontContract('ES', volSpec, d('2026-12-11'), 1, { ESZ6: 500, ESH7: 1 })!.code).toBe(
      'ESH7',
    );
    expect(frontContract('ES', es, now, 1, { ESZ6: 100, ESH7: 150 })!.code).toBe('ESZ6');
  });
});

describe('search', () => {
  const top = (q: string) => cat.index.search(q, { limit: 5 }).map((h) => h.doc.symbol);
  it('finds by symbol, root, name and exchange', () => {
    expect(top('CL')[0]).toBe('CL');
    expect(top('crude')).toContain('CL');
    expect(top('crude')).toContain('MCL');
    expect(top('light sweet')[0]).toBe('CL');
    expect(top('es')[0]).toBe('ES');
    expect(cat.index.search('eurex').length).toBeGreaterThanOrEqual(10);
    expect(top('apple')).toContain('AAPL');
    expect(top('btc-usdt-swap')[0]).toBe('BTC-USDT-SWAP');
  });
  it('is typo tolerant', () => {
    expect(top('crdue')).toContain('CL');
    expect(top('natral gas')[0]).toBe('NG');
    expect(top('nasdq')).toContain('NQ');
  });
  it('boosts and filters', () => {
    const hits = cat.index.search('crude', {
      boost: (d) => (d.root === 'QM' ? 5000 : 0),
      filter: (d) => d.exchange === 'NYMEX',
    });
    expect(hits[0]!.doc.root).toBe('QM');
    expect(hits.every((h) => h.doc.exchange === 'NYMEX')).toBe(true);
  });
  it('edit distance', () => {
    expect(editDistance('crdue', 'crude', 2)).toBe(1);
    expect(editDistance('abc', 'xyz', 1)).toBe(2);
  });
  it('searches 10,000+ entries in under 50 ms', () => {
    const words = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'nova', 'terra', 'solar', 'quant'];
    const docs: CatalogInstrument[] = [...cat.instruments];
    const base = cat.instruments[0]!;
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let n = 0; docs.length < 12_000; n++) {
      let sym = '';
      for (let k = 0; k < 3 + (n % 3); k++) sym += String.fromCharCode(65 + Math.floor(rnd() * 26));
      docs.push({
        ...base,
        id: `bench:${n}`,
        symbol: sym,
        root: sym,
        name: `${words[n % words.length]} ${words[(n * 7) % words.length]} holdings ${n}`,
        exchange: n % 2 ? 'NYSE' : 'NASDAQ',
        aliases: undefined,
      });
    }
    const idx = new SearchIndex(docs);
    expect(idx.size).toBeGreaterThanOrEqual(10_000);
    for (const q of ['crude', 'crdue', 'es', 'btc', 'apple', 'gamma holdings', 'nyse', 'xq']) {
      idx.search(q); // warm-up
      const times: number[] = [];
      for (let r = 0; r < 5; r++) {
        const t0 = performance.now();
        idx.search(q);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      expect(times[2], q).toBeLessThan(50);
    }
    expect(idx.search('crude')[0]!.doc.root).toBe('CL');
  });
});

describe('prefs and feed matching', () => {
  it('favourites and recent', () => {
    let p = sanitizePrefs({ favourites: ['a', 'a', 3], recent: 'x' });
    expect(p).toEqual({ favourites: ['a'], recent: [] });
    p = toggleFavourite(p, 'b');
    p = toggleFavourite(p, 'a');
    expect(p.favourites).toEqual(['b']);
    for (let i = 0; i < 25; i++) p = pushRecent(p, `i${i}`);
    p = pushRecent(p, 'i10');
    expect(p.recent.length).toBe(20);
    expect(p.recent[0]).toBe('i10');
    expect(p.recent.filter((x) => x === 'i10').length).toBe(1);
  });
  it('matches feed instruments to catalog entries', () => {
    const m = (id: string, symbol: string, exchange: string, assetClass: string, label = '') =>
      matchFeedInstrument(cat, { id, symbol, exchange, assetClass }, label)?.id;
    expect(m('mock:CLZ6', 'CLZ6', 'NYMEX', 'future')).toBe('cat:NYMEX:CL');
    expect(m('replay:mock:ESZ6', 'ESZ6', 'CME', 'future')).toBe('cat:CME:ES');
    expect(m('binance-futures:ETHUSDT', 'ETHUSDT', 'Binance Futures', 'crypto')).toBe(
      'cat:BINANCE-FUTURES:ETHUSDT',
    );
    expect(m('bybit:SOLUSDT', 'SOLUSDT', 'Bybit Linear', 'crypto', 'Bybit (live)')).toBe(
      'cat:BYBIT:SOLUSDT',
    );
    expect(m('okx:BTC-USDT-SWAP', 'BTC-USDT-SWAP', 'OKX', 'crypto')).toBe('cat:OKX:BTC-USDT-SWAP');
    expect(m('x:FOO', 'FOO', 'Nowhere', 'crypto')).toBeUndefined();
    expect(normalizeCryptoSymbol('PF_XBTUSD')).toBe('XBTUSD');
  });
});
