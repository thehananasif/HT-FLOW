import { useEffect, useRef, useState } from 'react';
import { Badge, Chip, SegmentedControl } from '@htflow/ui-kit';
import { catalog } from '@htflow/market-catalog';
import { hub } from '../../state/market';
import { registerModule, type ModuleViewProps } from '../registry';
import {
  basis,
  calendarSpreads,
  CURVE_ROOTS,
  curveContracts,
  curveProviderFor,
  curveShape,
  nextRollInfo,
  simSpotAgo,
  type CurvePoint,
  type CurveRoot,
} from './curve';
import './styles.css';

const AGO = ['1', '7', '30'] as const;
type Ago = (typeof AGO)[number];

function readParams(p: Record<string, unknown> | undefined): { root: string; ago: Ago } {
  const root = CURVE_ROOTS.some((r) => r.key === p?.root) ? (p!.root as string) : 'CL';
  const ago = AGO.includes(p?.ago as Ago) ? (p!.ago as Ago) : '7';
  return { root, ago };
}

/** Spot reference: the streaming feed's last price, else the root's reference price. */
function spotOf(root: CurveRoot): { spot: number; streaming: boolean } {
  const st = root.spotFeed ? hub.peek(root.spotFeed) : undefined;
  const t = st?.lastTrade;
  if (st && t) return { spot: t.px * st.instrument.tickSize, streaming: true };
  return { spot: root.refPrice, streaming: false };
}

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 600, h: 300 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function CurveChart({
  now,
  ago,
  precision,
}: {
  now: CurvePoint[];
  ago: CurvePoint[];
  precision: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(ref);
  const pad = { l: 56, r: 16, t: 14, b: 26 };
  const all = [...now, ...ago].map((p) => p.price);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || Math.abs(hi) * 0.01 || 1;
  const y0 = lo - span * 0.08;
  const y1 = hi + span * 0.08;
  const n = Math.max(1, now.length - 1);
  const x = (i: number) => pad.l + (i / n) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * (h - pad.t - pad.b);
  const path = (pts: CurvePoint[]) =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join('');
  const ticks = [0, 1, 2, 3].map((k) => y0 + ((y1 - y0) * (k + 0.5)) / 4);
  const every = Math.max(1, Math.ceil(now.length / Math.max(1, Math.floor((w - 80) / 64))));
  return (
    <div className="fc-chart" ref={ref}>
      {w > 0 && now.length > 0 && (
        <svg width={w} height={h} role="img" aria-label="Forward curve chart">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} className="fc-grid" />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="fc-axis tnum">
                {t.toFixed(precision)}
              </text>
            </g>
          ))}
          {now.map((p, i) =>
            i % every === 0 ? (
              <text key={p.code} x={x(i)} y={h - 8} textAnchor="middle" className="fc-axis mono">
                {p.code.replace(/^BTCUSDT_/, '')}
              </text>
            ) : null,
          )}
          <path d={path(ago)} className="fc-line-ago" />
          <path d={path(now)} className="fc-line" />
          {now.map((p, i) => (
            <circle key={p.code} cx={x(i)} cy={y(p.price)} r={2.5} className="fc-dot">
              <title>{`${p.code}: ${p.price.toFixed(precision)}`}</title>
            </circle>
          ))}
        </svg>
      )}
    </div>
  );
}

function ForwardCurve({ state, setParams }: ModuleViewProps) {
  const { root: rootKey, ago } = readParams(state.params);
  const root = CURVE_ROOTS.find((r) => r.key === rootKey)!;
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(i);
  }, []);
  // Keep the spot reference streaming while the window shows this root.
  useEffect(() => {
    if (!root.spotFeed) return;
    hub.retain(root.spotFeed);
    return () => hub.release(root.spotFeed!);
  }, [root.spotFeed]);

  const t = Date.now();
  const days = Number(ago);
  const provider = curveProviderFor(root)!;
  const contracts = curveContracts(root, t);
  const { spot, streaming } = spotOf(root);
  const px = provider.prices(root, contracts, t, spot) ?? [];
  const points: CurvePoint[] = contracts.map((c, i) => ({ ...c, price: px[i] ?? Number.NaN }));
  const agoT = t - days * 86_400_000;
  const agoSpot = provider.kind === 'sim' ? simSpotAgo(root, spot, days, t) : spot;
  const agoPx = provider.prices(root, contracts, agoT, agoSpot) ?? [];
  const agoPoints: CurvePoint[] = contracts.map((c, i) => ({
    ...c,
    price: agoPx[i] ?? Number.NaN,
  }));
  const shape = curveShape(points);
  const spreads = calendarSpreads(points);
  const roll = nextRollInfo(root, t);
  const name = catalog().get(root.catalogId)?.name ?? root.label;
  const prec = root.precision;

  return (
    <div className="module-window fc" data-testid="forward-curve">
      <div className="fc-top">
        <span className="fc-title">
          Forward curve{' '}
          <span className="muted">
            · {root.label} ({name})
          </span>
        </span>
        <div className="grow" />
        {provider.kind === 'sim' ? (
          <Badge kind="replay">Sim</Badge>
        ) : provider.kind === 'delayed' ? (
          <Badge kind="delayed">Delayed</Badge>
        ) : (
          <Badge kind="live">Live</Badge>
        )}
        <span data-testid="fc-shape">
          {shape === 'contango' ? (
            <Badge kind="live">Contango</Badge>
          ) : shape === 'backwardation' ? (
            <Badge kind="error">Backwardation</Badge>
          ) : (
            <Badge>Flat</Badge>
          )}
        </span>
      </div>
      <div className="fc-chips">
        {CURVE_ROOTS.map((r) => (
          <Chip
            key={r.key}
            selected={r.key === root.key}
            onClick={() => setParams({ root: r.key })}
          >
            {r.label}
          </Chip>
        ))}
        <div className="grow" />
        <span className="muted">Compare with</span>
        <SegmentedControl
          aria-label="Days ago"
          value={ago}
          onChange={(v) => setParams({ ago: v })}
          options={AGO.map((a) => ({ value: a, label: `${a}d` }))}
        />
      </div>
      {provider.kind === 'sim' && (
        <div className="fc-note" role="note">
          Simulated term structure — no free futures-curve data. Anchored on{' '}
          {streaming ? `the Sim feed's last price (${root.spotFeed})` : 'a reference price'};
          expiries from the catalog roll rules. Connect a futures feed for real quotes.
        </div>
      )}
      <div className="fc-body">
        <CurveChart now={points} ago={agoPoints} precision={prec} />
        <div className="fc-table-wrap">
          <table className="tbl tnum fc-table">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Expiry</th>
                <th className="r">Days</th>
                <th className="r">Last</th>
                <th className="r">Spread</th>
                {root.crypto && <th className="r">Basis</th>}
                {root.crypto && <th className="r">Ann.</th>}
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => {
                const s = spreads[i];
                const b = basis(p.price, spot, p.days);
                return (
                  <tr key={p.code}>
                    <td className="mono">{p.code}</td>
                    <td className="muted">{p.expiry.toISOString().slice(0, 10)}</td>
                    <td className="r">{Math.ceil(p.days)}</td>
                    <td className="r">{p.price.toFixed(prec)}</td>
                    <td className={`r ${s == null ? 'muted' : s >= 0 ? 'up' : 'down'}`}>
                      {s == null ? '—' : `${s >= 0 ? '+' : ''}${s.toFixed(prec)}`}
                    </td>
                    {root.crypto && (
                      <td className={`r ${b.abs >= 0 ? 'up' : 'down'}`}>{b.abs.toFixed(prec)}</td>
                    )}
                    {root.crypto && (
                      <td className="r">
                        {Number.isFinite(b.annPct) ? `${b.annPct.toFixed(2)}%` : '—'}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="fc-foot">
        <span className="fc-legend">
          <i className="fc-key" /> Now
        </span>
        <span className="fc-legend">
          <i className="fc-key fc-key-ago" /> {days} day{days > 1 ? 's' : ''} ago
        </span>
        {root.crypto && <span className="muted tnum">Spot {spot.toFixed(prec)}</span>}
        <span className="muted" data-testid="fc-roll">
          {roll
            ? `Next roll: ${roll.from.code} → ${roll.to.code} in ${roll.days} day${roll.days === 1 ? '' : 's'} (${roll.date.toISOString().slice(0, 10)})`
            : 'No roll scheduled'}
        </span>
      </div>
    </div>
  );
}

registerModule({ id: 'forward-curve', view: ForwardCurve });
