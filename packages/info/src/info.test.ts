import { describe, expect, it } from 'vitest';
import {
  BigTradeDetector,
  DeltaSpikeDetector,
  LiquidityPullDetector,
  currencyAffects,
  dueAlerts,
  emptyReaderState,
  exportOpml,
  filterNews,
  formatCountdown,
  groupByDay,
  highlightSegments,
  instrumentRoot,
  matchKeywords,
  mergeFeedItems,
  nextHighImpact,
  normalizeLink,
  normalizeReaderState,
  parseFeed,
  parseFeedDate,
  parseIcs,
  parseOpml,
  parseXml,
  sampleCalendarIcs,
  setRead,
  stripHtml,
  surprise,
  tagSymbols,
  textContent,
  unreadCounts,
  type NewsItem,
} from './index';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<!-- comment -->
<!DOCTYPE rss [ <!ENTITY foo "bar"> ]>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Example Exchange &amp; Co</title>
  <link>https://example.com/news/</link>
  <atom:link href="https://example.com/feed.xml" rel="self"/>
  <item>
    <title><![CDATA[Futures will launch NEWUSDT perpetual <b>contract</b>]]></title>
    <link>https://example.com/news/1?utm_source=rss&amp;id=7</link>
    <guid isPermaLink="false">ann-0001</guid>
    <pubDate>Wed, 04 Nov 2026 13:45:00 GMT</pubDate>
    <description>&lt;p&gt;Trading of &lt;a href="x"&gt;NEWUSDT&lt;/a&gt; starts.&lt;/p&gt;&lt;p&gt;Leverage 50x&amp;nbsp;&#8212; more.&lt;/p&gt;</description>
    <category>Futures</category><category>Listing</category>
    <dc:creator>Exchange Team</dc:creator>
  </item>
  <item>
    <title>Wallet maintenance for BTC network</title>
    <link>/news/2</link>
    <pubDate>Tue, 03 Nov 26 08:00:00 -0500</pubDate>
    <content:encoded><![CDATA[<div><p>Deposits of <strong>Bitcoin</strong> pause.</p><script>alert(1)</script></div>]]></content:encoded>
  </item>
  <item><title>Guid permalink</title><guid>https://example.com/news/3</guid><dc:date>2026-11-02T10:15:30+02:00</dc:date></item>
  <item><title>No date, no link</title><description>Plain</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://bank.example.org/">
  <title type="text">Central Bank Press</title>
  <link rel="self" href="https://bank.example.org/atom.xml"/>
  <link rel="alternate" href="https://bank.example.org/press/"/>
  <entry>
    <title type="html">Policy statement &lt;em&gt;release time&lt;/em&gt; confirmed</title>
    <link rel="alternate" href="press/2026/statement.htm"/>
    <id>tag:bank.example.org,2026:pr-1</id>
    <published>2026-11-04T18:30:00.000+05:00</published>
    <author><name>Press Office</name></author>
    <category term="Monetary Policy"/>
    <summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>The Committee <b>decided</b> to hold rates.</p></div></summary>
  </entry>
  <entry>
    <title>Speech</title><link href="https://bank.example.org/speeches/1"/>
    <id>sp-1</id><updated>2026-11-03T09:00:00Z</updated>
    <content type="html">&lt;p&gt;Inflation &amp;amp; growth.&lt;/p&gt;</content>
  </entry>
</feed>`;

const RDF = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel rdf:about="x"><title>Regulator</title><link>https://reg.example.gov/</link></channel>
<item rdf:about="y"><title>Weekly report</title><link>https://reg.example.gov/r/1</link><dc:date>2026-11-04T17:05:00Z</dc:date></item>
</rdf:RDF>`;

const OPML = `<?xml version="1.0"?><opml version="1.0"><head><title>My &amp; feeds</title></head><body>
<outline text="Crypto exchanges">
  <outline text="Exchange A" type="rss" xmlUrl="https://a.example.com/rss.xml" htmlUrl="https://a.example.com/"/>
  <outline text="Sub"><outline title="Exchange B" xmlUrl="https://b.example.com/feed"/></outline>
</outline>
<outline text="Loose" xmlUrl="https://loose.example.com/rss"/>
</body></opml>`;

const ICS = [
  'BEGIN:VCALENDAR',
  'X-WR-CALNAME:Fixture Econ',
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:STANDARD',
  'DTSTART:19701101T020000',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:cpi-1',
  'DTSTART;TZID=America/New_York:20261110T083000',
  'DURATION:PT30M',
  'SUMMARY:USD - CPI m/m',
  'X-IMPACT:High',
  'X-FORECAST:0.3%',
  'X-PREVIOUS:0.2%',
  'DESCRIPTION:Consumer prices\\, all items.\\nSource: BLS',
  'BEGIN:VALARM',
  'DESCRIPTION:Reminder',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:nfp-1',
  'DTSTART:20261106T133000Z',
  'DTEND:20261106T140000Z',
  'SUMMARY:Non-Farm Employment Change',
  'DESCRIPTION:Impact: High\\nCurrency: USD\\nActual: 175K\\nForecast: 160K\\nPrevious: 142K',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:ecb-1',
  'DTSTART;TZID=W. Europe Standard Time:20260705T144500',
  'SUMMARY:[EUR] ECB President Speaks ★★',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:hol-1',
  'DTSTART;VALUE=DATE:20261126',
  'SUMMARY:Thanksgiving',
  'X-COUNTRY:US',
  'PRIORITY:9',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:float-1',
  'DTSTART:20261107T090000',
  'SUMMARY:Floating event with a long title that is folded across',
  '  two lines',
  'PRIORITY:5',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:cx-1',
  'DTSTART:20261108T090000Z',
  'SUMMARY:Cancelled',
  'STATUS:CANCELLED',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:bad-tz',
  'DTSTART;TZID=Mars/Olympus:20261109T120000',
  'SUMMARY:GBP: BoE Gov Speaks',
  'X-HTFLOW-IMPACT:3',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('xml', () => {
  it('parses entities, CDATA, self-closing and recovers from bad nesting', () => {
    const r = parseXml('<a x="1 &amp; 2"><b>t&#65;&lt;</b><c/><d><![CDATA[<raw>]]></d></x></a>')!;
    expect(r.name).toBe('a');
    expect(r.attrs.x).toBe('1 & 2');
    expect(textContent(r)).toBe('tA<<raw>');
    expect(parseXml('just text')).toBeNull();
  });
});

describe('feeds', () => {
  it('parses RSS 2.0', () => {
    const f = parseFeed(RSS, 'https://example.com/feed.xml');
    expect(f.kind).toBe('rss');
    expect(f.title).toBe('Example Exchange & Co');
    expect(f.items).toHaveLength(4);
    const a = f.items[0]!;
    expect(a.title).toBe('Futures will launch NEWUSDT perpetual contract');
    expect(a.id).toBe('g:ann-0001');
    expect(a.published).toBe(Date.UTC(2026, 10, 4, 13, 45));
    expect(a.summary).toBe('Trading of NEWUSDT starts.\nLeverage 50x — more.');
    expect(a.categories).toEqual(['Futures', 'Listing']);
    expect(a.author).toBe('Exchange Team');
    const b = f.items[1]!;
    expect(b.link).toBe('https://example.com/news/2');
    expect(b.published).toBe(Date.UTC(2026, 10, 3, 13, 0));
    expect(b.summary).toBe('Deposits of Bitcoin pause.');
    expect(f.items[2]!.link).toBe('https://example.com/news/3');
    expect(f.items[2]!.published).toBe(Date.UTC(2026, 10, 2, 8, 15, 30));
    expect(f.items[3]!.published).toBeNull();
    expect(f.items[3]!.id.startsWith('h:')).toBe(true);
  });
  it('parses Atom and RDF', () => {
    const f = parseFeed(ATOM);
    expect(f.kind).toBe('atom');
    expect(f.link).toBe('https://bank.example.org/press/');
    expect(f.items[0]!.title).toBe('Policy statement release time confirmed');
    expect(f.items[0]!.link).toBe('https://bank.example.org/press/2026/statement.htm');
    expect(f.items[0]!.published).toBe(Date.UTC(2026, 10, 4, 13, 30));
    expect(f.items[0]!.summary).toBe('The Committee decided to hold rates.');
    expect(f.items[0]!.categories).toEqual(['Monetary Policy']);
    expect(f.items[1]!.summary).toBe('Inflation & growth.');
    const r = parseFeed(RDF);
    expect(r.kind).toBe('rdf');
    expect(r.items[0]!.published).toBe(Date.UTC(2026, 10, 4, 17, 5));
  });
  it('rejects non-feeds', () => {
    expect(() => parseFeed('<html><body>403</body></html>')).toThrow();
    expect(() => parseFeed('')).toThrow();
  });
  it('dates, links, html', () => {
    expect(parseFeedDate('Wed, 04 Nov 2026 13:45:00 EST')).toBe(Date.UTC(2026, 10, 4, 18, 45));
    expect(parseFeedDate('2026-11-04')).toBe(Date.UTC(2026, 10, 4));
    expect(parseFeedDate('garbage')).toBeNull();
    expect(normalizeLink('http://x.com/a/?utm_source=a&id=2#frag')).toBe('https://x.com/a?id=2');
    expect(stripHtml('<p>a<br/>b</p><style>x{}</style>c')).toBe('a\nb\nc');
  });
});

describe('opml', () => {
  it('imports and round-trips', () => {
    const d = parseOpml(OPML);
    expect(d.title).toBe('My & feeds');
    expect(d.feeds.map((f) => [f.title, f.folder])).toEqual([
      ['Exchange A', 'Crypto exchanges'],
      ['Exchange B', 'Crypto exchanges / Sub'],
      ['Loose', ''],
    ]);
    const again = parseOpml(exportOpml('T & "q"', d.feeds, 0));
    expect(again.title).toBe('T & "q"');
    expect(again.feeds).toEqual(d.feeds);
    expect(() => parseOpml('<rss/>')).toThrow();
  });
});

describe('keywords and symbols', () => {
  it('highlights whole words, longest first', () => {
    const s = highlightSegments('Rate cut: separate rates, RATE halt.', [
      'rate',
      'halt',
      'rate cut',
    ]);
    expect(s.filter((x) => x.keyword).map((x) => [x.text, x.keyword])).toEqual([
      ['Rate cut', 'rate cut'],
      ['RATE', 'rate'],
      ['halt', 'halt'],
    ]);
    expect(s.map((x) => x.text).join('')).toBe('Rate cut: separate rates, RATE halt.');
    expect(matchKeywords(['new listing'], ['Listing', ' '])).toEqual(['Listing']);
    expect(highlightSegments('abc', [])).toEqual([{ text: 'abc' }]);
  });
  it('tags symbols and roots', () => {
    expect(instrumentRoot('CLZ6')).toBe('CL');
    expect(instrumentRoot('6EZ26')).toBe('6E');
    expect(instrumentRoot('BTCUSDT')).toBe('BTC');
    expect(instrumentRoot('NEWUSDT.P')).toBe('NEW');
    const t = tagSymbols('Bitcoin slides as crude oil and NEWUSDT.P react to FOMC; solid data');
    expect(t.map((x) => x.ticker ?? x.root)).toEqual(['BTC', 'CL', 'NEWUSDT.P', 'USD']);
    expect(tagSymbols('The sol is out, eth-ics')).toEqual([]);
    expect(currencyAffects('USD', 'ES', 'future')).toBe(true);
    expect(currencyAffects('USD', 'XYZ', 'crypto')).toBe(true);
    expect(currencyAffects('EUR', 'ES', 'future')).toBe(false);
  });
});

describe('ics + calendar', () => {
  const r = parseIcs(ICS);
  const by = (uid: string) => r.events.find((e) => e.uid === uid)!;
  it('parses VEVENTs with zones and custom fields', () => {
    expect(r.calendarName).toBe('Fixture Econ');
    expect(r.events).toHaveLength(6);
    const cpi = by('cpi-1');
    // 08:30 New York in November (EST, UTC-5)
    expect(cpi.t).toBe(Date.UTC(2026, 10, 10, 13, 30));
    expect(cpi.end).toBe(cpi.t + 30 * 60_000);
    expect(cpi).toMatchObject({ currency: 'USD', title: 'CPI m/m', impact: 'high' });
    expect(cpi.forecast).toBe('0.3%');
    expect(cpi.actual).toBeUndefined();
    expect(cpi.description).toBe('Consumer prices, all items.\nSource: BLS');
    const nfp = by('nfp-1');
    expect(nfp).toMatchObject({
      impact: 'high',
      currency: 'USD',
      actual: '175K',
      previous: '142K',
    });
    // 14:45 Berlin in July (CEST, UTC+2), Windows zone name
    expect(by('ecb-1').t).toBe(Date.UTC(2026, 6, 5, 12, 45));
    expect(by('ecb-1')).toMatchObject({
      currency: 'EUR',
      impact: 'medium',
      title: 'ECB President Speaks',
    });
    expect(by('hol-1')).toMatchObject({ allDay: true, currency: 'USD', impact: 'low' });
    expect(by('float-1').title).toBe(
      'Floating event with a long title that is folded across two lines',
    );
    expect(by('float-1').impact).toBe('medium');
    expect(by('float-1').t).toBe(Date.UTC(2026, 10, 7, 9));
    expect(by('bad-tz')).toMatchObject({ currency: 'GBP', impact: 'high' });
    expect(r.warnings.some((w) => w.includes('Mars/Olympus'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('RRULE'))).toBe(true);
    expect(
      parseIcs(ICS, { defaultTz: 'Asia/Karachi' }).events.find((e) => e.uid === 'float-1')!.t,
    ).toBe(Date.UTC(2026, 10, 7, 4));
  });
  it('countdown, grouping, alerts, surprise', () => {
    const now = Date.UTC(2026, 10, 6, 12, 0);
    expect(nextHighImpact(r.events, now)!.uid).toBe('nfp-1');
    expect(formatCountdown(by('nfp-1').t - now)).toBe('1h 30m');
    expect(formatCountdown(74_644_000)).toBe('20h 44m');
    expect(formatCountdown(65_000)).toBe('1m 05s');
    expect(formatCountdown(-1)).toBe('now');
    const g = groupByDay(r.events, 'Asia/Karachi');
    expect(g.find((x) => x.events.some((e) => e.uid === 'nfp-1'))!.label).toBe('Fri 06 Nov');
    const fired = new Set<string>();
    expect(dueAlerts(r.events, by('nfp-1').t - 6 * 60_000, 5, 'all', fired)).toEqual([]);
    expect(
      dueAlerts(r.events, by('nfp-1').t - 4 * 60_000, 5, 'all', fired).map((e) => e.uid),
    ).toEqual(['nfp-1']);
    expect(dueAlerts(r.events, by('nfp-1').t - 3 * 60_000, 5, 'all', fired)).toEqual([]);
    expect(surprise(by('nfp-1'))).toBe('up');
    expect(surprise({ title: 'Unemployment Claims', actual: '230K', forecast: '221K' })).toBe(
      'down',
    );
    expect(surprise({ title: 'x', forecast: '1' })).toBeNull();
  });
  it('bundled sample calendar is labelled sample', () => {
    const now = Date.UTC(2026, 10, 10, 9, 10);
    const s = parseIcs(sampleCalendarIcs(now));
    expect(s.calendarName).toContain('sample');
    expect(s.events.length).toBeGreaterThan(10);
    expect(s.events.every((e) => e.title.endsWith('(sample)'))).toBe(true);
    expect(s.events.filter((e) => e.t > now).every((e) => e.actual === undefined)).toBe(true);
    expect(nextHighImpact(s.events, now)).not.toBeNull();
  });
});

describe('reader cache', () => {
  it('de-duplicates, keeps read state, caps and counts unread', () => {
    let st = normalizeReaderState({
      feeds: [
        { id: 'a', url: 'https://a.example.com/rss', title: 'A', folder: 'Crypto' },
        { id: 'b', url: 'ftp://bad', title: 'bad' },
        { id: 'c', url: 'https://c.example.com/rss', title: 'C', folder: 'Banks' },
      ],
      refreshMin: 99999,
      keywords: ['halt', 'Halt', ''],
    });
    expect(st.feeds.map((f) => f.id)).toEqual(['a', 'c']);
    expect(st.refreshMin).toBe(15);
    expect(st.keywords).toEqual(['halt']);
    const items = parseFeed(RSS, 'https://example.com/feed.xml').items;
    let m = mergeFeedItems(st, 'a', items.slice(0, 2), 1000, { sample: true });
    expect(m.added).toHaveLength(2);
    expect(m.state.items.every((i) => i.sample)).toBe(true);
    // Real fetch replaces the bundled sample.
    m = mergeFeedItems(m.state, 'a', items, 2000);
    st = m.state;
    expect(st.items).toHaveLength(4);
    expect(st.items.some((i) => i.sample)).toBe(false);
    st = setRead(st, [items[0]!.id], true);
    m = mergeFeedItems(st, 'a', items, 3000);
    expect(m.added).toHaveLength(0);
    expect(m.state.items.find((i) => i.id === items[0]!.id)!.read).toBe(true);
    // Same item from another feed is not duplicated.
    m = mergeFeedItems(m.state, 'c', [items[1]!], 4000);
    expect(m.added).toHaveLength(0);
    const u = unreadCounts(m.state);
    expect(u.total).toBe(3);
    expect(u.feeds.get('a')).toBe(3);
    expect(u.folders.get('Crypto')).toBe(3);
    const capped = mergeFeedItems(
      { ...emptyReaderState(), feeds: st.feeds, maxPerFeed: 2 },
      'a',
      items,
      1,
    );
    expect(capped.state.items).toHaveLength(2);
    expect(normalizeReaderState(JSON.parse(JSON.stringify(m.state)))).toEqual(m.state);
    expect(normalizeReaderState(null)).toEqual(emptyReaderState());
  });
});

describe('news', () => {
  it('filters by chip, instrument and query', () => {
    const mk = (id: string, category: NewsItem['category'], roots: string[]): NewsItem => ({
      id,
      t: 1,
      kind: 'rss',
      title: `t ${id}`,
      source: 's',
      symbols: roots,
      roots,
      category,
      sentiment: 'neutral',
    });
    const items = [
      mk('1', 'crypto', ['BTC']),
      mk('2', 'futures', ['CL']),
      mk('3', 'macro', ['USD']),
    ];
    const f = (chip: 'all' | 'crypto' | 'futures' | 'macro' | 'mine', extra = {}) =>
      filterNews(items, { chip, mySymbols: ['CL'], ...extra }).map((i) => i.id);
    expect(f('all')).toEqual(['1', '2', '3']);
    expect(f('crypto')).toEqual(['1']);
    expect(f('mine')).toEqual(['2']);
    expect(f('all', { instrumentRoot: 'btc' })).toEqual(['1']);
    expect(f('all', { query: 'T 3' })).toEqual(['3']);
  });
  it('detects big trades, delta spikes and liquidity pulls', () => {
    const big = new BigTradeDetector(25, 0, 0, 50);
    const base = Array.from({ length: 100 }, (_, i) => ({
      ts: i,
      px: 100,
      qty: 2,
      side: 'buy' as const,
    }));
    expect(big.push(base)).toEqual([]);
    const ev = big.push([{ ts: 200, px: 101, qty: 80, side: 'sell' }]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'big-trade', px: 101, qty: 80, side: 'sell' });
    expect(ev[0]!.ratio).toBeCloseTo(40);

    const ds = new DeltaSpikeDetector(1000, 5, 60, 5, 0);
    const calm = Array.from({ length: 40 }, (_, i) => ({
      ts: i * 250,
      px: 1,
      qty: 1,
      side: (i % 2 ? 'buy' : 'sell') as 'buy' | 'sell',
    }));
    calm.push(
      { ts: 9990, px: 1, qty: 3, side: 'buy' },
      { ts: 10_100, px: 1, qty: 200, side: 'sell' },
    );
    calm.push({ ts: 11_500, px: 1, qty: 1, side: 'buy' });
    const sp = ds.push(calm);
    expect(sp.filter((e) => e.side === 'sell' && e.qty === 200)).toHaveLength(1);

    const lp = new LiquidityPullDetector(5, 20, 0.7, 0);
    const pxs = Array.from({ length: 20 }, (_, i) => 90 + i); // bids 90..99, asks 100..109
    const col = (t: number, q95: number) => ({
      t,
      bestBid: 99,
      bestAsk: 100,
      pxs,
      qtys: pxs.map((p) => (p === 95 ? q95 : 10)),
    });
    expect(lp.push(col(0, 500))).toEqual([]);
    const pulled = lp.push(col(250, 20));
    expect(pulled).toHaveLength(1);
    expect(pulled[0]).toMatchObject({ kind: 'liquidity-pull', px: 95, side: 'buy', qty: 480 });
    // Filled (traded) size is not a pull.
    lp.push(col(500, 500));
    expect(lp.push(col(750, 20), () => 480)).toEqual([]);
  });
});
