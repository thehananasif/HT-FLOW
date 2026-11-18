import { useCallback, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import {
  Badge,
  Button,
  DropdownMenu,
  MenuTrigger,
  NumberInput,
  Select,
  Slider,
  Tabs,
  toast,
  type MenuEntry,
} from '@htflow/ui-kit';
import { t, translateLiteral as tl, tt } from '@htflow/i18n';
import {
  analyzeStrategy,
  buildTemplate,
  chainMark,
  DAY_MS,
  daysToExpiry,
  expiryLabel,
  expiryLongLabel,
  greeks,
  markPnl,
  optionsPositionPayoff,
  paperOptionLeg,
  strikesAround,
  TEMPLATES,
  yearFrac,
  type ChainExpiry,
  type Leg,
  type OptionContract,
  type OptionsChain,
  type SeriesType,
  type StrategyEnv,
  type TemplateId,
} from '@htflow/options';
import type { OptionPosition } from '@htflow/trading';
import { paper, PAPER_ACCOUNT, hub } from '../../state/market';
import { optionSpot, setOptionSpot } from '../../trading/optionsModel';
import { usePaperTick } from '../../trading/TradingPanel';
import { activityLog } from '../activity/log';
import { legToTrade } from './trade';
import { registerModule, type ModuleViewProps } from '../registry';
import { PayoffChart } from './PayoffChart';
import { fmtIv, fmtMoney, fmtNum, fmtPx, greekDecimals } from './format';
import { useOptionsPositions } from './positions';
import { isDeribit, UNDERLYINGS, useChain } from './useChain';
import './styles.css';

type OptCol = 'gamma' | 'vega' | 'rho' | 'oi' | 'volume' | 'change';
const OPT_COLS: { id: OptCol; label: string }[] = [
  { id: 'gamma', label: 'Gamma' },
  { id: 'vega', label: 'Vega' },
  { id: 'rho', label: 'Rho' },
  { id: 'oi', label: 'OI' },
  { id: 'volume', label: 'Volume' },
  { id: 'change', label: 'Change' },
];
type SeriesFilter = 'all' | SeriesType;

interface Params {
  underlying: string;
  series: SeriesFilter;
  expiries: number[];
  qty: number;
  strikes: number;
  cols: OptCol[];
  ratePct: number;
  collapsed: number[];
  tab: 'chain' | 'positions';
  legs: Leg[];
  tPlus: number;
  account: string;
  /** What a click on a bid / ask does: add a leg to the builder, or trade it on paper at once. */
  click: 'build' | 'trade';
}

const DEFAULTS: Params = {
  underlying: 'mock:BTCUSDT',
  series: 'all',
  expiries: [],
  qty: 1,
  strikes: 5,
  cols: [],
  ratePct: 4,
  collapsed: [],
  tab: 'chain',
  legs: [],
  tPlus: 0,
  account: PAPER_ACCOUNT,
  click: 'build',
};

const clamp = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

/** Validated params with defaults (every setting has a default and a range). */
function readParams(p: Record<string, unknown> | undefined): Params {
  const s = p ?? {};
  const arr = <T,>(v: unknown, ok: (x: unknown) => boolean): T[] =>
    Array.isArray(v) ? (v.filter(ok) as T[]) : [];
  return {
    underlying: UNDERLYINGS.some((u) => u.id === s.underlying)
      ? (s.underlying as string)
      : DEFAULTS.underlying,
    series: ['all', 'regular', 'weekly', 'eom', 'daily'].includes(s.series as string)
      ? (s.series as SeriesFilter)
      : 'all',
    expiries: arr<number>(s.expiries, (x) => typeof x === 'number'),
    qty: clamp(s.qty, 0.1, 10_000, DEFAULTS.qty),
    strikes: Math.round(clamp(s.strikes, 1, 40, DEFAULTS.strikes)),
    cols: arr<OptCol>(s.cols, (x) => OPT_COLS.some((c) => c.id === x)),
    ratePct: clamp(s.ratePct, 0, 25, DEFAULTS.ratePct),
    collapsed: arr<number>(s.collapsed, (x) => typeof x === 'number'),
    tab: s.tab === 'positions' ? 'positions' : 'chain',
    legs: arr<Leg>(
      s.legs,
      (x) => !!x && typeof x === 'object' && typeof (x as Leg).strike === 'number',
    ),
    tPlus: clamp(s.tPlus, 0, 3650, 0),
    account: typeof s.account === 'string' ? s.account : PAPER_ACCOUNT,
    click: s.click === 'trade' ? 'trade' : 'build',
  };
}

/** Price the payoff axis is drawn against (spot for Black-Scholes, nearest forward for Black-76). */
const axisPrice = (c: OptionsChain) =>
  c.model === 'b76' ? (c.expiries[0]?.forward ?? c.spot) : c.spot;
/** Price an expiry's options are valued off. */
const underOf = (c: OptionsChain, e: ChainExpiry) => (c.model === 'b76' ? e.forward : c.spot);

let legSeq = 0;

/**
 * Sends legs to the paper engine as options trades (P18). Returns how many were booked; each
 * rejection is reported. Fills go to Trading Activity.
 */
function tradeLegs(legs: readonly Leg[], chain: OptionsChain, account: string, underlying: string) {
  let ok = 0;
  for (const l of legs) {
    const req = legToTrade(l, chain, account, underlying);
    if (!req) continue;
    const r = paper.tradeOption(req);
    if (typeof r === 'string') {
      toast('error', tl('Options order rejected'), `${l.name ?? ''}: ${r}`);
      continue;
    }
    ok++;
    const flow = req.side === 'buy' ? 'debit' : 'credit';
    activityLog.add({
      type: 'fill',
      account: paper.accounts.get(account)?.name ?? account,
      message: `${req.side.toUpperCase()} ${req.qty} ${req.name ?? `${req.strike} ${req.right}`} @ ${req.premium} (${flow} ${fmtMoney(req.premium * req.qty * (req.multiplier ?? 1))})`,
    });
  }
  return ok;
}

function OptionsBoard({ state, setParams }: ModuleViewProps) {
  const p = readParams(state.params);
  const set = useCallback((patch: Partial<Params>) => setParams(patch), [setParams]);
  const r = p.ratePct / 100;

  // Expiries shown: selected ones that still exist, else the first two of the series filter.
  const pick = useCallback(
    (c: OptionsChain) => {
      const pool = c.expiries.filter((e) => p.series === 'all' || e.series === p.series);
      const chosen = pool.filter((e) => p.expiries.includes(e.expiry));
      return chosen.length ? chosen : pool.slice(0, 2);
    },
    [p.series, p.expiries],
  );
  const visibleNames = useCallback(
    (c: OptionsChain) =>
      pick(c).flatMap((e) =>
        strikesAround(e.strikes, underOf(c, e), p.strikes).flatMap((s) =>
          [s.call?.name, s.put?.name].filter((x): x is string => !!x),
        ),
      ),
    [pick, p.strikes],
  );
  const { chain, error, loading } = useChain(p.underlying, r, visibleNames);
  const shown = chain ? pick(chain) : [];
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (chain) setOptionSpot(p.underlying, chain.spot);
  }, [chain, p.underlying]);

  const env: StrategyEnv | null = chain
    ? { model: chain.model, r: chain.r, q: chain.q, multiplier: chain.multiplier, now }
    : null;

  const addLeg = (c: OptionContract, e: ChainExpiry, side: 'buy' | 'sell') => {
    if (!chain) return;
    const q = c.quote;
    const price = side === 'buy' ? (q.ask ?? q.mark) : (q.bid ?? q.mark);
    if (price === null) return;
    const iv = (side === 'buy' ? q.askIv : q.bidIv) ?? q.markIv ?? 0.3;
    const leg: Leg = {
      id: `leg-${Date.now().toString(36)}-${legSeq++}`,
      kind: c.kind,
      strike: c.strike,
      expiry: c.expiry,
      qty: side === 'buy' ? p.qty : -p.qty,
      premium: price,
      iv,
      name: c.name,
      basis: underOf(chain, e) / axisPrice(chain),
    };
    if (p.click === 'trade') {
      // Quick trade: buy at the ask / sell at the bid on paper right away.
      if (tradeLegs([leg], chain, p.account, p.underlying))
        toast(
          'success',
          `${side === 'buy' ? 'Bought' : 'Sold'} ${p.qty} ${c.name}`,
          t('options.paperNote'),
        );
      return;
    }
    set({ legs: [...p.legs, leg] });
  };

  const applyTemplate = (id: TemplateId) => {
    if (!chain) return;
    const exps = shown.length ? shown : chain.expiries.slice(0, 2);
    const e0 = exps[0];
    if (!e0) return;
    const specs = buildTemplate(id, {
      strikes: e0.strikes.map((s) => s.strike),
      spot: underOf(chain, e0),
      expiries: exps.map((e) => e.expiry),
      qty: p.qty,
    });
    const legs: Leg[] = [];
    for (const s of specs) {
      const e = chain.expiries.find((x) => x.expiry === s.expiry)!;
      const row = e.strikes.find((x) => x.strike === s.strike);
      const c = row?.[s.kind];
      if (!c) continue;
      const buy = s.qty > 0;
      const price = (buy ? c.quote.ask : c.quote.bid) ?? c.quote.mark ?? 0;
      legs.push({
        id: `leg-${Date.now().toString(36)}-${legSeq++}`,
        kind: s.kind,
        strike: s.strike,
        expiry: s.expiry,
        qty: s.qty,
        premium: price,
        iv: (buy ? c.quote.askIv : c.quote.bidIv) ?? c.quote.markIv ?? 0.3,
        name: c.name,
        basis: underOf(chain, e) / axisPrice(chain),
      });
    }
    set({ legs });
  };

  const accounts = [...paper.accounts.values()].map((a) => ({ value: a.id, label: a.name }));
  const filteredExpiries = chain
    ? chain.expiries.filter((e) => p.series === 'all' || e.series === p.series)
    : [];
  const seriesItems: MenuEntry[] = filteredExpiries.map((e) => ({
    id: String(e.expiry),
    label: `${expiryLabel(e.expiry)} · ${e.series} · ${daysToExpiry(e.expiry, now)}d`,
    checked: shown.includes(e),
    onSelect: () => {
      const cur = shown.map((x) => x.expiry);
      const next = cur.includes(e.expiry) ? cur.filter((x) => x !== e.expiry) : [...cur, e.expiry];
      set({ expiries: next.sort((a, b) => a - b) });
    },
  }));
  const colItems: MenuEntry[] = OPT_COLS.map((c) => ({
    id: c.id,
    label: c.label,
    checked: p.cols.includes(c.id),
    onSelect: () =>
      set({ cols: p.cols.includes(c.id) ? p.cols.filter((x) => x !== c.id) : [...p.cols, c.id] }),
  }));

  return (
    <div className="module-window ob" data-testid="options-board">
      <div className="ob-title">
        <span className="ob-root">#{chain?.root ?? '—'}</span>
        <b>{t('options.title')}</b>
        <Select
          small
          aria-label={tl('Underlying')}
          value={p.underlying}
          options={UNDERLYINGS.map((u) => ({ value: u.id, label: u.label }))}
          onChange={(v) => set({ underlying: v, expiries: [], legs: [] })}
        />
        {chain && <Badge kind={chain.simulated ? 'replay' : 'live'}>{chain.sourceLabel}</Badge>}
        <span className="grow" />
        <Tabs
          tabs={[
            { value: 'chain', label: 'Chain' },
            {
              value: 'positions',
              label: `${t('options.positions')} (${paper.optionPositions().length + useOptionsPositions.getState().positions.length})`,
            },
          ]}
          value={p.tab}
          onChange={(v) => set({ tab: v })}
        />
      </div>
      <div className="ob-body">
        <div className="ob-main">
          {p.tab === 'positions' ? (
            <PositionsTab
              chain={chain}
              underlying={p.underlying}
              onAnalyse={(legs) => set({ legs, tab: 'chain', tPlus: 0 })}
            />
          ) : (
            <>
              <div className="ob-controls">
                <span className="muted">{t('options.accountSeries')}</span>
                <Select
                  small
                  aria-label={tl('Account')}
                  value={p.account}
                  options={accounts.length ? accounts : [{ value: PAPER_ACCOUNT, label: 'Paper' }]}
                  onChange={(v) => set({ account: v })}
                />
                <DropdownMenu
                  items={
                    seriesItems.length
                      ? seriesItems
                      : [{ kind: 'label', id: 'n', label: 'No series' }]
                  }
                  trigger={
                    <MenuTrigger aria-label={tl('Series')}>
                      {shown.length} {tl('series')}
                    </MenuTrigger>
                  }
                />
                <span className="grow" />
                <span className="muted">{tl('Series type')}</span>
                <Select
                  small
                  aria-label={tl('Series type')}
                  value={p.series}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'regular', label: 'Regular' },
                    { value: 'weekly', label: 'Weekly' },
                    { value: 'eom', label: 'EOM' },
                    { value: 'daily', label: 'Daily' },
                  ]}
                  onChange={(v) => set({ series: v, expiries: [] })}
                />
                <span className="muted">{t('options.clickMode')}</span>
                <Select
                  small
                  aria-label={tl('Click a quote')}
                  value={p.click}
                  options={[
                    { value: 'build', label: 'Add leg' },
                    { value: 'trade', label: 'Trade now' },
                  ]}
                  onChange={(v) => set({ click: v })}
                />
                <span className="muted">{tl('Contracts')}</span>
                <NumberInput
                  aria-label={tl('Contracts')}
                  className="ob-num"
                  value={p.qty}
                  step={isDeribit(p.underlying) ? 0.1 : 1}
                  min={isDeribit(p.underlying) ? 0.1 : 1}
                  max={10000}
                  onChange={(v) => set({ qty: v })}
                />
                <span className="muted">{tl('Strikes')}</span>
                <NumberInput
                  aria-label={tl('Strikes')}
                  className="ob-num"
                  value={p.strikes}
                  min={1}
                  max={40}
                  onChange={(v) => set({ strikes: v })}
                />
                <DropdownMenu
                  items={colItems}
                  align="end"
                  trigger={<MenuTrigger aria-label={tl('Columns')}>{tl('Columns')}</MenuTrigger>}
                />
              </div>
              {error && (
                <div className="ob-error">
                  {tl('Could not load')} {p.underlying.replace('deribit:', 'Deribit ')}: {error}
                </div>
              )}
              {!chain && loading && <div className="ob-empty">{tl('Loading option chain…')}</div>}
              {chain && (
                <div className="ob-scroll">
                  <UnderlyingTable chain={chain} expiries={shown} />
                  {shown.map((e) => (
                    <ExpiryBlock
                      key={e.expiry}
                      chain={chain}
                      e={e}
                      now={now}
                      n={p.strikes}
                      cols={p.cols}
                      collapsed={p.collapsed.includes(e.expiry)}
                      onToggle={() =>
                        set({
                          collapsed: p.collapsed.includes(e.expiry)
                            ? p.collapsed.filter((x) => x !== e.expiry)
                            : [...p.collapsed, e.expiry],
                        })
                      }
                      onPick={(c, side) => addLeg(c, e, side)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <Builder chain={chain} env={env} p={p} set={set} onTemplate={applyTemplate} />
      </div>
    </div>
  );
}

function UnderlyingTable({ chain, expiries }: { chain: OptionsChain; expiries: ChainExpiry[] }) {
  const d = chain.priceDecimals;
  return (
    <div className="ob-und">
      <div className="ob-section">{t('options.underlyingQuotes')}</div>
      <table className="ob-tbl tnum">
        <thead>
          <tr>
            <th className="l">{tl('Symbol')}</th>
            <th className="l">{tl('Expiration')}</th>
            <th>{tl('Bid')}</th>
            <th>{tl('BidSz')}</th>
            <th>{tl('Ask')}</th>
            <th>{tl('AskSz')}</th>
            <th>{tl('Last')}</th>
          </tr>
        </thead>
        <tbody>
          {expiries.map((e) => {
            const u = e.underlying;
            return (
              <tr key={e.expiry}>
                <td className="l mono">{u.symbol}</td>
                <td className="l">{expiryLongLabel(e.expiry)}</td>
                <td>{fmtPx(u.bid, Math.max(1, d))}</td>
                <td className="up">{fmtNum(u.bidSize, u.bidSize && u.bidSize % 1 ? 1 : 0)}</td>
                <td className="up">{fmtPx(u.ask, Math.max(1, d))}</td>
                <td>{fmtNum(u.askSize, u.askSize && u.askSize % 1 ? 1 : 0)}</td>
                <td className="down">{fmtPx(u.last, Math.max(1, d))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ExpiryBlock({
  chain,
  e,
  now,
  n,
  cols,
  collapsed,
  onToggle,
  onPick,
}: {
  chain: OptionsChain;
  e: ChainExpiry;
  now: number;
  n: number;
  cols: OptCol[];
  collapsed: boolean;
  onToggle: () => void;
  onPick: (c: OptionContract, side: 'buy' | 'sell') => void;
}) {
  const S = underOf(chain, e);
  const rows = strikesAround(e.strikes, S, n).slice().reverse();
  const atm = rows.reduce<number | null>(
    (best, r) => (best === null || Math.abs(r.strike - S) < Math.abs(best - S) ? r.strike : best),
    null,
  );
  const d = chain.priceDecimals;
  const gd = greekDecimals(d);
  const T = yearFrac(now, e.expiry);
  const optional = OPT_COLS.filter((c) => cols.includes(c.id));
  const cells = (c: OptionContract | undefined, isCall: boolean) => {
    if (!c) return Array.from({ length: 7 + optional.length }, (_, i) => <td key={i}>—</td>);
    const q = c.quote;
    const g = greeks({
      kind: c.kind,
      S,
      K: c.strike,
      T,
      r: chain.r,
      q: chain.q,
      sigma: q.markIv ?? q.askIv ?? 0.3,
      model: chain.model,
    });
    const extra: Record<OptCol, string> = {
      gamma: fmtNum(g.gamma, 6),
      vega: fmtNum(g.vega, gd),
      rho: fmtNum(g.rho, gd + 1),
      oi: fmtNum(q.openInterest, q.openInterest && q.openInterest % 1 ? 1 : 0),
      volume: fmtNum(q.volume, q.volume && q.volume % 1 ? 1 : 0),
      change: q.change === null ? '—' : `${q.change > 0 ? '+' : ''}${q.change.toFixed(1)}%`,
    };
    const head = [
      <td key="last">{fmtPx(q.last, d)}</td>,
      <td key="delta">{fmtNum(g.delta, 2)}</td>,
      <td key="theta">{fmtNum(g.theta, gd)}</td>,
      ...optional.map((o) => <td key={o.id}>{extra[o.id]}</td>),
    ];
    const quotes = [
      <td
        key="bid"
        className="up ob-click"
        title={tt`Sell ${c.name} at the bid`}
        data-testid={`bid-${c.name}`}
        onClick={() => onPick(c, 'sell')}
      >
        {fmtPx(q.bid, d)}
      </td>,
      <td key="bidiv" className="up">
        {fmtIv(q.bidIv)}
      </td>,
      <td
        key="ask"
        className="down ob-click"
        title={tt`Buy ${c.name} at the ask`}
        data-testid={`ask-${c.name}`}
        onClick={() => onPick(c, 'buy')}
      >
        {fmtPx(q.ask, d)}
      </td>,
      <td key="askiv" className="down">
        {fmtIv(q.askIv)}
      </td>,
    ];
    return isCall ? [...head, ...quotes] : [...quotes, ...head.reverse()];
  };
  const sideCells = (c: OptionContract | undefined, isCall: boolean) =>
    cells(c, isCall).map((td, k) => (
      <td
        key={k}
        {...td.props}
        className={`${td.props.className ?? ''} ${isCall ? 'ob-c' : 'ob-p'}`}
      />
    ));
  const callHead = [
    'Last',
    'Delta',
    'Theta',
    ...optional.map((o) => o.label),
    'Bid',
    'Bid IV',
    'Ask',
    'Ask IV',
  ];
  const putHead = [
    'Bid',
    'Bid IV',
    'Ask',
    'Ask IV',
    ...optional.map((o) => o.label).reverse(),
    'Theta',
    'Delta',
    'Last',
  ];
  return (
    <div className="ob-exp" data-testid="options-expiry">
      <button className="ob-exp-head" onClick={onToggle} aria-expanded={!collapsed}>
        <span className="ob-exp-calls">{tl('Calls')}</span>
        <span className="ob-exp-title tnum">
          {expiryLabel(e.expiry)} · {e.underlying.symbol} · {fmtPx(S, Math.max(0, d))}
          <span className="ob-days">{daysToExpiry(e.expiry, now)}d</span>
        </span>
        <span className="ob-exp-puts">{tl('Puts')}</span>
      </button>
      {!collapsed && (
        <table className="ob-tbl ob-chain tnum">
          <thead>
            <tr>
              {callHead.map((h) => (
                <th key={'c' + h}>{h}</th>
              ))}
              <th className="ob-strike">{tl('Strike')}</th>
              <th className="ob-strike">{tl('IV')}</th>
              {putHead.map((h) => (
                <th key={'p' + h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const next = rows[i + 1];
              const spotLine = row.strike >= S && next !== undefined && next.strike < S;
              const iv = row.strike < S ? row.put?.quote.markIv : row.call?.quote.markIv;
              return (
                <tr
                  key={row.strike}
                  className={[
                    spotLine && 'ob-spotline',
                    row.strike < S && 'ob-itm-c',
                    row.strike > S && 'ob-itm-p',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {sideCells(row.call, true)}
                  <td className="ob-strike">
                    {fmtPx(row.strike, row.strike % 1 ? Math.max(1, d) : 0)}
                    {row.strike === atm && <span className="ob-atm" title={tl('At the money')} />}
                  </td>
                  <td className="ob-strike ob-iv">{fmtIv(iv)}</td>
                  {sideCells(row.put, false)}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Builder({
  chain,
  env,
  p,
  set,
  onTemplate,
}: {
  chain: OptionsChain | null;
  env: StrategyEnv | null;
  p: Params;
  set: (patch: Partial<Params>) => void;
  onTemplate: (id: TemplateId) => void;
}) {
  const legs = p.legs;
  const spot = chain ? axisPrice(chain) : 0;
  const d = chain?.priceDecimals ?? 2;
  const horizon = legs.length ? Math.min(...legs.map((l) => l.expiry)) : 0;
  const maxDays = env && legs.length ? Math.max(0, Math.floor((horizon - env.now) / DAY_MS)) : 0;
  const tPlus = Math.min(p.tPlus, maxDays);
  const analysis = useMemo(
    () => (env && legs.length && spot > 0 ? analyzeStrategy(legs, spot, env) : null),
    [env, legs, spot],
  );
  const curve = useMemo(
    () =>
      env && legs.length && spot > 0
        ? optionsPositionPayoff(legs, spot, env, { at: env.now + tPlus * DAY_MS })
        : null,
    [env, legs, spot, tPlus],
  );
  const patchLeg = (id: string, patch: Partial<Leg>) =>
    set({ legs: legs.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  const send = () => {
    if (!chain || !legs.length || !analysis) return;
    const n = tradeLegs(legs, chain, p.account, p.underlying);
    if (!n) return;
    toast(
      'success',
      tt`Paper options order: ${n} leg${n === 1 ? '' : 's'} filled`,
      `${analysis.netPremium >= 0 ? 'Net credit' : 'Net debit'} ${fmtMoney(Math.abs(analysis.netPremium))}. ${t('options.paperNote')}`,
    );
    set({ legs: [], tab: 'positions' });
  };
  const g = analysis?.greeks;
  const stat = (label: string, value: string, cls?: string, testId?: string) => (
    <div className="ob-stat">
      <span>{label}</span>
      <b className={cls} data-testid={testId}>
        {value}
      </b>
    </div>
  );
  const net = analysis?.netPremium ?? 0;
  return (
    <aside className="ob-builder" data-testid="strategy-builder">
      <div className="ob-builder-head">
        <b>{t('options.builder')}</b>
        <span className="grow" />
        <Select<TemplateId | ''>
          small
          aria-label={tl('Template')}
          value=""
          options={[
            { value: '', label: 'Template…' },
            ...TEMPLATES.map((x) => ({ value: x.id, label: x.label })),
          ]}
          onChange={(v) => v && onTemplate(v)}
        />
      </div>
      <div className="ob-legs">
        {!legs.length && <div className="ob-hint">{t('options.noLegs')}</div>}
        {legs.map((l) => (
          <div className="ob-leg" key={l.id} data-testid="strategy-leg">
            <button
              className={l.qty > 0 ? 'ob-side up' : 'ob-side down'}
              title={tl('Switch buy / sell')}
              onClick={() => patchLeg(l.id, { qty: -l.qty })}
            >
              {l.qty > 0 ? 'BUY' : 'SELL'}
            </button>
            <NumberInput
              aria-label={tl('Leg quantity')}
              className="ob-leg-qty"
              value={Math.abs(l.qty)}
              step={isDeribit(p.underlying) ? 0.1 : 1}
              min={isDeribit(p.underlying) ? 0.1 : 1}
              onChange={(v) => patchLeg(l.id, { qty: Math.sign(l.qty) * v })}
            />
            <span className="mono ob-leg-name" title={tt`IV ${fmtIv(l.iv)}`}>
              {l.name}
            </span>
            <NumberInput
              aria-label={tl('Leg price')}
              className="ob-leg-px"
              value={l.premium}
              step={10 ** -Math.max(0, d)}
              min={0}
              onChange={(v) => patchLeg(l.id, { premium: v })}
            />
            <button
              className="ht-icon-btn"
              aria-label={tl('Remove leg')}
              onClick={() => set({ legs: legs.filter((x) => x.id !== l.id) })}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="ob-chart">
        <PayoffChart
          curve={curve}
          spot={spot}
          decimals={spot >= 1000 ? 0 : d}
          todayLabel={tPlus ? `T+${tPlus}` : 'today'}
        />
      </div>
      <div className="ob-row">
        <span className="muted">
          {tl('Valuation T+')}
          {tPlus}d
        </span>
        <Slider
          label={tl('Days forward')}
          value={tPlus}
          min={0}
          max={Math.max(0, maxDays)}
          onChange={(v) => set({ tPlus: v })}
        />
      </div>
      <div className="ob-stats" data-testid="strategy-stats">
        {stat(
          net >= 0 ? 'Net credit' : 'Net debit',
          fmtMoney(Math.abs(net)),
          net >= 0 ? 'up' : 'down',
        )}
        {stat('Max profit', analysis ? fmtMoney(analysis.maxProfit) : '—', 'up')}
        {stat('Max loss', analysis ? fmtMoney(analysis.maxLoss) : '—', 'down')}
        {stat('Prob. of profit', analysis ? `${(analysis.pop * 100).toFixed(0)}%` : '—')}
        <div className="ob-stat ob-wide">
          <span>{tl('Breakevens')}</span>
          <b data-testid="breakevens">
            {analysis
              ? analysis.breakevens.length
                ? analysis.breakevens.map((b) => fmtPx(b, spot >= 1000 ? 0 : d)).join(' / ')
                : 'None'
              : '—'}
          </b>
        </div>
        {stat('Δ Delta', g ? fmtNum(g.delta, 3) : '—')}
        {stat('Θ Theta', g ? `${fmtMoney(g.theta)} / day` : '—', g && g.theta >= 0 ? 'up' : 'down')}
        {stat('Γ Gamma', g ? fmtNum(g.gamma, 5) : '—')}
        {stat('V Vega', g ? `${fmtMoney(g.vega)} / 1%` : '—', g && g.vega >= 0 ? 'up' : 'down')}
        {stat('ρ Rho', g ? `${fmtMoney(g.rho)} / 1%` : '—')}
        <div className="ob-stat">
          <span>{tl('Risk-free rate %')}</span>
          <NumberInput
            aria-label={tl('Risk-free rate')}
            value={p.ratePct}
            step={0.25}
            min={0}
            max={25}
            onChange={(v) => set({ ratePct: v })}
          />
        </div>
      </div>
      <div className="row gap6">
        <Button
          variant="primary"
          block
          disabled={!legs.length || !analysis}
          onClick={send}
          data-testid="send-options"
        >
          {t('options.send')}
        </Button>
        <Button size="md" disabled={!legs.length} onClick={() => set({ legs: [] })}>
          {tl('Clear')}
        </Button>
      </div>
      <p className="ob-note">
        {chain?.simulated
          ? 'Sim: simulated chain (smile, term structure, spreads) on the MockFeed underlying. '
          : 'Data: Deribit public options (free). '}
        {tl('Model')} {chain?.model === 'b76' ? 'Black-76' : 'Black-Scholes'}
        {isDeribit(p.underlying) ? ' at the venue rate' : ` · r ${p.ratePct}%`}
        {tl('. CME options appear when a broker feed is connected.')} {t('options.paperNote')}
      </p>
    </aside>
  );
}

/** Name shown for a paper options position (contract name, else underlying / strike / right). */
const optName = (o: OptionPosition) =>
  o.name ??
  `${o.underlyingId.replace(/^\w+:/, '')}-${o.expiry}-${o.strike}-${o.right === 'call' ? 'C' : 'P'}`;

function PositionsTab({
  chain,
  underlying,
  onAnalyse,
}: {
  chain: OptionsChain | null;
  underlying: string;
  onAnalyse: (legs: Leg[]) => void;
}) {
  usePaperTick();
  const { positions: legacy, remove } = useOptionsPositions();
  const open = paper.optionPositions();
  const now = Date.now();
  const analyse = (list: OptionPosition[]) => {
    const spot = chain && list[0]?.underlyingId === underlying ? chain.spot : undefined;
    const axis = chain && spot ? axisPrice(chain) : undefined;
    onAnalyse(
      list.map((o) => ({
        ...paperOptionLeg(o, spot, axis),
        id: `leg-${Date.now().toString(36)}-${legSeq++}`,
      })),
    );
  };
  if (!open.length && !legacy.length)
    return (
      <div className="ob-empty">
        {tl(
          'No options positions. Click a quote or build a strategy and send it as a paper order.',
        )}
      </div>
    );
  const byUnderlying = new Map<string, OptionPosition[]>();
  for (const o of open) {
    const k = `${o.accountId}|${o.underlyingId}`;
    byUnderlying.set(k, [...(byUnderlying.get(k) ?? []), o]);
  }
  return (
    <div className="ob-scroll">
      {open.length > 0 && (
        <table className="ob-tbl tnum ob-pos" data-testid="paper-options-positions">
          <thead>
            <tr>
              <th className="l">{tl('Contract')}</th>
              <th className="l">{tl('Account')}</th>
              <th>{tl('Qty')}</th>
              <th>{tl('Avg premium')}</th>
              <th>{tl('Premium')}</th>
              <th>{tl('Mark')}</th>
              <th>Open P&amp;L</th>
              <th>{tl('Expires')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {open.map((o) => {
              const m = paper.optionMark(o);
              const pnl = paper.optionPnl(o);
              const flow = paper.premiumFlow(o);
              const exp = o.expiryTs ?? Date.parse(`${o.expiry}T08:00:00Z`);
              return (
                <tr key={o.id} data-testid="options-position">
                  <td className="l mono">{optName(o)}</td>
                  <td className="l">{paper.accounts.get(o.accountId)?.name ?? o.accountId}</td>
                  <td className={o.qty > 0 ? 'up' : 'down'}>
                    {o.qty > 0 ? '+' : ''}
                    {o.qty}
                  </td>
                  <td>{fmtNum(o.avgPremium, 2)}</td>
                  <td
                    className={flow > 0 ? 'down' : 'up'}
                    title={flow > 0 ? 'Premium paid (debit)' : 'Premium received (credit)'}
                  >
                    {flow > 0 ? 'Debit ' : 'Credit '}
                    {fmtMoney(Math.abs(flow))}
                  </td>
                  <td>{m === undefined ? '—' : fmtNum(m, 2)}</td>
                  <td className={pnl >= 0 ? 'up' : 'down'} data-testid="options-position-pnl">
                    {m === undefined && optionSpot(o.underlyingId) === undefined
                      ? 'open the underlying to mark'
                      : fmtMoney(pnl)}
                  </td>
                  <td>{Math.max(0, Math.ceil((exp - now) / DAY_MS))}d</td>
                  <td className="ob-pos-actions">
                    <Button
                      size="xs"
                      title={tl(
                        "Load the account's positions on this underlying into the strategy builder",
                      )}
                      onClick={() =>
                        analyse(byUnderlying.get(`${o.accountId}|${o.underlyingId}`) ?? [o])
                      }
                    >
                      {tl('Analyse')}
                    </Button>
                    <Button
                      size="xs"
                      data-testid="close-option"
                      onClick={() => {
                        const r = paper.closeOption(o.id);
                        if (typeof r === 'string') toast('error', tl('Could not close'), r);
                      }}
                    >
                      {tl('Close')}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {legacy.length > 0 && (
        <>
          <div className="ob-section">{tl('Saved strategies (before paper options)')}</div>
          <table className="ob-tbl tnum ob-pos">
            <thead>
              <tr>
                <th className="l">{tl('Opened')}</th>
                <th className="l">{tl('Underlying')}</th>
                <th className="l">{tl('Legs')}</th>
                <th>{tl('Entry')}</th>
                <th>Open P&amp;L</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {legacy.map((pos) => {
                let pnl: number | null = null;
                const env: StrategyEnv = {
                  model: pos.model,
                  r: pos.r,
                  q: pos.q,
                  multiplier: pos.multiplier,
                  now,
                };
                if (pos.underlying === underlying && chain) {
                  pnl = markPnl(pos.legs, axisPrice(chain), env, (l) => chainMark(chain, l.name));
                } else if (!isDeribit(pos.underlying)) {
                  const s = hub.peek(pos.underlying);
                  const last = s?.lastTrade?.px;
                  if (s && last !== undefined)
                    pnl = markPnl(pos.legs, last * s.instrument.tickSize, env);
                }
                return (
                  <tr key={pos.id} data-testid="legacy-options-position">
                    <td className="l">
                      {new Date(pos.createdAt).toLocaleString('en-GB', { hour12: false })}
                    </td>
                    <td className="l">
                      {pos.root} {pos.simulated && <Badge kind="replay">{tl('Sim')}</Badge>}
                    </td>
                    <td className="l mono">
                      {pos.legs
                        .map((l) => `${l.qty > 0 ? '+' : ''}${l.qty} ${l.name ?? ''}`)
                        .join('  ')}
                    </td>
                    <td className={pos.entryNet >= 0 ? 'up' : 'down'}>{fmtMoney(pos.entryNet)}</td>
                    <td className={pnl === null ? '' : pnl >= 0 ? 'up' : 'down'}>
                      {pnl === null ? 'open the underlying to mark' : fmtMoney(pnl)}
                    </td>
                    <td>
                      <Button size="xs" onClick={() => remove(pos.id)}>
                        {tl('Remove')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function OptionsBoardWindow(props: ModuleViewProps) {
  const load = useOptionsPositions((s) => s.load);
  useEffect(() => void load(), [load]);
  return <OptionsBoard {...props} />;
}

registerModule({ id: 'options-board', view: OptionsBoardWindow });
