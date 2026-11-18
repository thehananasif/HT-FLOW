import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Chip, Input, toast } from '@htflow/ui-kit';
import { formatPrice, formatQty, type MarketStore } from '@htflow/market-data';
import {
  BigTradeDetector,
  categoryOf,
  DeltaSpikeDetector,
  filterNews,
  formatCountdown,
  headlineSentiment,
  instrumentRoot,
  LiquidityPullDetector,
  matchKeywords,
  mergeNews,
  normalizeKeywords,
  tagLabel,
  tagSymbols,
  type DetectorEvent,
  type NewsChip,
  type NewsItem,
} from '@htflow/info';
import { hub } from '../../state/market';
import { useWindows } from '../../state/windows';
import { registerModule, type ModuleViewProps } from '../registry';
import {
  fmtClock,
  instrumentForTag,
  openChartFor,
  openUrl,
  useStore,
  useTick,
  useCalendarTimezone,
} from '../rss/shared';
import { reader } from '../rss/store';
import { allEvents, calendar } from '../calendar/store';
import { Highlighted } from '../rss';
import '../rss/styles.css';

import { translateLiteral as tl, tt } from '@htflow/i18n';
// ------------------------------------------------ HT Flow generated events (ref-counted service)

const generated: NewsItem[] = [];
const genListeners = new Set<() => void>();
let users = 0;
let stop: (() => void) | null = null;

function emit(store: MarketStore, e: DetectorEvent) {
  const i = store.instrument;
  const root = instrumentRoot(i.symbol);
  const px = e.px !== undefined ? ` @ ${formatPrice(e.px, i)}` : '';
  const qty = formatQty(e.qty, i.qtyPrecision);
  const title =
    e.kind === 'big-trade'
      ? `Big ${e.side === 'buy' ? 'buy' : e.side === 'sell' ? 'sell' : ''} print ${qty}${px} on ${i.symbol} (${e.ratio.toFixed(0)}× avg)`
      : e.kind === 'delta-spike'
        ? `Delta spike ${e.side === 'buy' ? '+' : '−'}${qty} in 10 s on ${i.symbol} (${e.ratio.toFixed(1)}× normal)`
        : `Liquidity pulled: ${qty} ${e.side === 'buy' ? 'bid' : 'offer'}${px} on ${i.symbol}`;
  generated.unshift({
    id: `gen:${i.id}:${e.kind}:${e.t}:${e.px ?? ''}`,
    t: e.t,
    kind: e.kind,
    title,
    source: i.id.startsWith('mock:') ? 'HT Flow metrics · simulator' : 'HT Flow metrics',
    symbols: [i.symbol],
    roots: [root],
    category: i.assetClass === 'crypto' ? 'crypto' : 'futures',
    sentiment:
      e.kind === 'liquidity-pull'
        ? 'warning'
        : e.side === 'buy'
          ? 'bull'
          : e.side === 'sell'
            ? 'bear'
            : 'neutral',
  });
  if (generated.length > 300) generated.length = 300;
  genListeners.forEach((l) => l());
}

function watch(store: MarketStore): () => void {
  const big = new BigTradeDetector();
  const delta = new DeltaSpikeDetector();
  const pull = new LiquidityPullDetector();
  let lastDepth = store.depth.length ? store.depth[store.depth.length - 1]! : null;
  const u1 = store.onTrades((trades) => {
    for (const e of big.push(trades)) emit(store, e);
    for (const e of delta.push(trades)) emit(store, e);
  });
  const u2 = store.subscribe(() => {
    const col = store.depth[store.depth.length - 1];
    if (!col || col === lastDepth) return;
    const from = lastDepth?.t ?? col.t;
    lastDepth = col;
    const traded = new Map<number, number>();
    for (const t of store.tradesBetween(from, col.t))
      traded.set(t.px, (traded.get(t.px) ?? 0) + t.qty);
    for (const e of pull.push(col, (px) => traded.get(px) ?? 0)) emit(store, e);
  });
  return () => (u1(), u2());
}

function startService(): () => void {
  users++;
  if (users === 1) {
    const unsubs = new Map<string, () => void>();
    const add = (s: MarketStore) => {
      if (!unsubs.has(s.instrument.id)) unsubs.set(s.instrument.id, watch(s));
    };
    hub.stores().forEach(add);
    const off = hub.onStore(add);
    stop = () => {
      off();
      unsubs.forEach((u) => u());
    };
  }
  return () => {
    users--;
    if (users === 0) {
      stop?.();
      stop = null;
    }
  };
}

// ------------------------------------------------ window

const CHIPS: { id: NewsChip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'futures', label: 'Futures' },
  { id: 'macro', label: 'Macro' },
  { id: 'mine', label: 'My symbols' },
];

function News({ state: win, setParams }: ModuleViewProps) {
  const rs = useStore(reader);
  const cal = useStore(calendar);
  useTick(2000);
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((x) => x + 1);
    genListeners.add(l);
    const off = startService();
    return () => {
      genListeners.delete(l);
      off();
    };
  }, []);
  const tz = useCalendarTimezone();
  const chip = (win.params?.chip as NewsChip | undefined) ?? 'all';
  const followActive = win.params?.followActive === true;
  const alerts = (win.params?.alerts as string[] | undefined) ?? [];
  const [query, setQuery] = useState('');
  const windows = useWindows((s) => s.windows);
  const activeId = useWindows((s) => s.activeId);

  const now = Date.now();
  const feedById = new Map(rs.feeds.map((f) => [f.id, f]));
  const rssNews: NewsItem[] = rs.items.map((i) => {
    const tags = tagSymbols(`${i.title} ${i.summary}`);
    const folder = feedById.get(i.feedId)?.folder ?? '';
    return {
      id: `rss:${i.id}`,
      t: i.published ?? i.fetchedAt,
      kind: 'rss',
      title: i.title,
      source: `${feedById.get(i.feedId)?.title ?? 'RSS'}${i.sample ? ' · offline sample' : ''}`,
      symbols: tags.map(tagLabel),
      roots: tags.map((t) => t.root),
      category: categoryOf(
        tags.map((t) => t.cls),
        folder,
      ),
      sentiment:
        /exchange/i.test(folder) && /listing|launch/i.test(i.title)
          ? 'info'
          : headlineSentiment(i.title),
      link: i.link,
      sample: i.sample,
    };
  });
  const calNews: NewsItem[] = allEvents(cal, now)
    .filter((e) => e.impact === 'high' && e.t > now && e.t - now < 24 * 3_600_000)
    .map((e) => ({
      id: `cal:${e.uid}@${e.t}`,
      t: now - 1,
      kind: 'calendar',
      title: `${e.title} due in ${formatCountdown(e.t - now)} (${fmtClock(e.t, tz)})`,
      source: e.sample ? 'Calendar · sample' : 'Calendar',
      symbols: e.currency ? [e.currency] : [],
      roots: e.currency ? [e.currency] : [],
      category: 'macro',
      sentiment: 'warning',
      sample: e.sample,
    }));
  const merged = mergeNews([calNews, generated, rssNews]);

  // Open instruments = "my symbols"; the active window's instrument for the follow filter.
  const openRoots = [
    ...new Set(
      Object.values(windows)
        .filter((w) => w.kind !== 'module')
        .map((w) =>
          instrumentRoot((w as { instrumentId: string }).instrumentId.split(':').pop() ?? ''),
        ),
    ),
  ];
  const activeWin = activeId ? windows[activeId] : undefined;
  const lastInst =
    activeWin && activeWin.kind !== 'module'
      ? activeWin.instrumentId
      : (
          Object.values(windows).find((w) => w.kind !== 'module') as
            { instrumentId?: string } | undefined
        )?.instrumentId;
  const activeRoot = lastInst ? instrumentRoot(lastInst.split(':').pop() ?? '') : null;
  const list = filterNews(merged, {
    chip,
    mySymbols: openRoots,
    instrumentRoot: followActive ? activeRoot : null,
    query,
  });

  // Keyword alerts: toast for new items (after the first render) that match.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(merged.map((i) => i.id));
      return;
    }
    for (const i of merged) {
      if (seen.current.has(i.id)) continue;
      seen.current.add(i.id);
      const hit = matchKeywords([i.title], alerts);
      if (hit.length)
        toast('warning', tt`News alert: ${hit.join(', ')}`, `${i.title} — ${i.source}`, 8000);
    }
  });

  return (
    <div className="module-window" data-testid="news-window">
      <div className="info-toolbar">
        <Input
          style={{ flex: 1, minWidth: 140 }}
          placeholder={tl('Search or keyword alert…')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim()) {
              setParams({ alerts: normalizeKeywords([...alerts, query.trim()]) });
              toast('info', tt`Alert added: "${query.trim()}"`);
              setQuery('');
            }
          }}
          title={tl(
            'Type to filter; press Enter to add a keyword alert (toast when a new item matches)',
          )}
        />
        {CHIPS.map((c) => (
          <Chip key={c.id} selected={chip === c.id} onClick={() => setParams({ chip: c.id })}>
            {tl(c.label)}
          </Chip>
        ))}
        <Checkbox
          checked={followActive}
          onChange={(v) => setParams({ followActive: v })}
          label={tt`Active instrument${followActive && activeRoot ? ` (${activeRoot})` : ''}`}
        />
      </div>
      {alerts.length > 0 && (
        <div className="info-toolbar">
          <span className="muted">{tl('Alerts:')}</span>
          {alerts.map((a) => (
            <button
              key={a}
              className="ht-chip"
              title={tl('Remove alert')}
              onClick={() => setParams({ alerts: alerts.filter((x) => x !== a) })}
            >
              {a} ×
            </button>
          ))}
        </div>
      )}
      <div className="news-list">
        {list.length === 0 && <div className="tbl-empty">{tl('No news for this filter')}</div>}
        {list.slice(0, 300).map((i) => {
          const inst = i.symbols[0] ? instrumentForTag(i.symbols[0]) : null;
          return (
            <div key={i.id} className="news-row">
              <span className="t tnum">{fmtClock(i.t, tz)}</span>
              <span className="info-dot" data-tone={i.sentiment} aria-label={i.sentiment} />
              <span className="grow">
                {i.link ? (
                  <a
                    href={i.link}
                    onClick={(e) => {
                      e.preventDefault();
                      openUrl(i.link!);
                    }}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    <Highlighted text={i.title} keywords={[...alerts, ...rs.keywords]} />
                  </a>
                ) : (
                  <Highlighted text={i.title} keywords={[...alerts, ...rs.keywords]} />
                )}
                <span className="src"> — {i.source}</span>
              </span>
              {i.symbols.slice(0, 2).map((s) => (
                <button
                  key={s}
                  className="info-tag mono"
                  style={{ cursor: inst ? 'pointer' : 'default' }}
                  title={inst ? `Open chart ${s}` : s}
                  onClick={() => inst && openChartFor(inst)}
                >
                  {s}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="info-foot">
        {tl(
          'Sources: free public RSS you subscribe to, HT Flow metrics from open instruments (big prints, delta spikes, liquidity pulls), calendar. Funding flips, OI jumps and liquidation spikes need funding / OI / liquidation streams the connectors do not expose yet.',
        )}{' '}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setParams({ alerts: [] })}
          disabled={!alerts.length}
        >
          {tl('Clear alerts')}
        </Button>
      </div>
    </div>
  );
}

registerModule({ id: 'news', view: News });
