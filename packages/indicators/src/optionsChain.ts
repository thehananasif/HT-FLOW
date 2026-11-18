import {
  HT,
  defineIndicator,
  input,
  output,
  type Level,
  type Marker,
  type OptionExpiryData,
  type OptionStrikeData,
  type OptionsData,
} from '@htflow/indicator-sdk';
import { expiryLabel, type OptionsChain } from '@htflow/options';

/* ------------------------------------------------------------------ pure maths */

const sideIv = (q?: { bidIv: number | null; askIv: number | null; markIv: number | null }) => {
  if (!q) return null;
  if (q.bidIv !== null && q.askIv !== null) return (q.bidIv + q.askIv) / 2;
  return q.markIv ?? q.askIv ?? q.bidIv;
};

/** Normalises a host chain (`@htflow/options`) into the compact shape indicators read. */
export function chainToData(chain: OptionsChain, version: number): OptionsData {
  return {
    version,
    root: chain.root,
    sourceLabel: chain.sourceLabel,
    simulated: chain.simulated,
    spot: chain.spot,
    updatedAt: chain.updatedAt,
    expiries: chain.expiries.map((e) => ({
      expiry: e.expiry,
      forward: e.forward,
      strikes: e.strikes.map((s) => ({
        strike: s.strike,
        callOi: s.call?.quote.openInterest ?? 0,
        putOi: s.put?.quote.openInterest ?? 0,
        callVolume: s.call?.quote.volume ?? 0,
        putVolume: s.put?.quote.volume ?? 0,
        callIv: sideIv(s.call?.quote),
        putIv: sideIv(s.put?.quote),
      })),
    })),
  };
}

/** The n-th (1 = soonest) expiry that has not expired at `now` (clamped to the last one). */
export function pickExpiry(
  data: OptionsData,
  n: number,
  now: number,
): OptionExpiryData | undefined {
  const live = data.expiries.filter((e) => e.expiry > now);
  const list = live.length ? live : data.expiries;
  return list[Math.min(list.length, Math.max(1, Math.floor(n))) - 1];
}

/**
 * Max pain: the strike at which option holders lose the most at expiry, i.e. the settlement price
 * that minimises the total intrinsic value payable on all open interest. Ties go to the lower strike.
 */
export function maxPainStrike(strikes: readonly OptionStrikeData[]): number | null {
  let best: number | null = null;
  let bestPay = Infinity;
  for (const s of strikes) {
    let pay = 0;
    for (const o of strikes) {
      pay += o.callOi * Math.max(0, s.strike - o.strike);
      pay += o.putOi * Math.max(0, o.strike - s.strike);
    }
    if (pay < bestPay - 1e-9) {
      bestPay = pay;
      best = s.strike;
    }
  }
  return best;
}

export interface BoardRow {
  strike: number;
  callOi: number;
  putOi: number;
  oi: number;
  volume: number;
  /** Mean of the call and put IV (decimal), null when neither is quoted. */
  iv: number | null;
  /** Put OI / call OI (null without call OI). */
  pcr: number | null;
}

/** The `count` strikes closest to `spot` (ascending by strike) as board rows. */
export function boardRows(
  strikes: readonly OptionStrikeData[],
  spot: number,
  count: number,
): BoardRow[] {
  const near = [...strikes]
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot) || a.strike - b.strike)
    .slice(0, Math.max(1, Math.floor(count)))
    .sort((a, b) => a.strike - b.strike);
  return near.map((s) => {
    const ivs = [s.callIv, s.putIv].filter((v): v is number => v !== null);
    return {
      strike: s.strike,
      callOi: s.callOi,
      putOi: s.putOi,
      oi: s.callOi + s.putOi,
      volume: s.callVolume + s.putVolume,
      iv: ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null,
      pcr: s.callOi > 0 ? s.putOi / s.callOi : null,
    };
  });
}

/** Compact count: 950, 1.2k, 3.4M. */
export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

/** Strike with thousands separators and no float noise. */
export const strikeText = (k: number) =>
  (+k.toFixed(6)).toLocaleString('en-US', { maximumFractionDigits: 6 });

export interface SmilePt {
  strike: number;
  /** Out-of-the-money IV (puts below the forward, calls above), decimal. */
  iv: number;
}

/** IV vs strike of one expiry on the OTM side, within ±`rangePct` % of the forward. */
export function smilePoints(e: OptionExpiryData, rangePct: number): SmilePt[] {
  const out: SmilePt[] = [];
  const lim = rangePct / 100;
  for (const s of e.strikes) {
    if (Math.abs(s.strike / e.forward - 1) > lim) continue;
    const iv = s.strike < e.forward ? (s.putIv ?? s.callIv) : (s.callIv ?? s.putIv);
    if (iv !== null && Number.isFinite(iv) && iv > 0) out.push({ strike: s.strike, iv });
  }
  return out;
}

/** ATM IV: the smile point closest to the forward. */
export function atmIv(pts: readonly SmilePt[], forward: number): number | null {
  let best: SmilePt | null = null;
  for (const p of pts)
    if (!best || Math.abs(p.strike - forward) < Math.abs(best.strike - forward)) best = p;
  return best ? best.iv : null;
}

/**
 * Maps the smile curves onto chart bars: strike stays on the price axis, IV runs along the time
 * axis from `last - width` (lowest IV of all curves) to `last` (highest), so the smile is drawn
 * sideways, in the price scale the strikes belong to.
 */
export function smileLayout(
  curves: readonly (readonly SmilePt[])[],
  last: number,
  width: number,
): { min: number; max: number; bars: number[][] } {
  let min = Infinity;
  let max = -Infinity;
  for (const c of curves)
    for (const p of c) {
      min = Math.min(min, p.iv);
      max = Math.max(max, p.iv);
    }
  const w = Math.max(1, Math.floor(width));
  const base = Math.max(0, last - w);
  const span = max - min;
  const bars = curves.map((c) =>
    c.map((p) => (span > 0 ? base + Math.round(((p.iv - min) / span) * (last - base)) : last)),
  );
  return { min, max, bars };
}

/* ------------------------------------------------------------------ indicators */

const opt = { category: 'options' as const, pane: 'overlay' as const };
const NO_CHAIN = 'options chain loading or not available for this instrument';
const srcTag = (d: OptionsData) => (d.simulated ? `${d.sourceLabel} (simulated)` : d.sourceLabel);

/**
 * Options Board (on-chart strikes / open interest): the nearest strikes of one expiry as price
 * levels with open interest, volume and IV, plus the max-pain strike.
 */
export const OptionsBoard = defineIndicator({
  id: 'options-board',
  name: 'Options Board (on-chart strikes/OI)',
  short: 'Opt board',
  ...opt,
  needsHost: true,
  needsOptions: true,
  autoscale: false,
  description:
    'Strikes of one option expiry drawn on the price axis with call/put open interest, volume and implied volatility, and the max-pain strike. Crypto underlyings (BTC, ETH) use the Deribit public chain; other symbols a simulated chain, always labelled "simulated".',
  formula:
    'Row = strike with OI calls/puts, volume, IV = mean of call and put mid IV; max pain = strike minimising Σ OI·intrinsic value at expiry',
  inputs: {
    expiry: input.int('Expiry (1 = soonest)', 1, { min: 1, max: 30 }),
    strikes: input.int('Strikes shown', 15, {
      min: 3,
      max: 60,
      help: 'Closest to the underlying price.',
    }),
    maxPain: input.bool('Show max pain', true),
    width: input.int('Level width', 40, { min: 5, max: 500, unit: 'bars' }),
  },
  outputs: {
    levels: output.levels('Strikes', HT.up, { color2: HT.down, color3: HT.warning }),
  },
  title: (p) => `Options board #${p.expiry}`,
  calc(ctx) {
    if (ctx.i !== ctx.count - 1) return;
    const d = ctx.options;
    if (!d) {
      ctx.notice(NO_CHAIN);
      return;
    }
    const e = pickExpiry(d, ctx.inputs.expiry, ctx.bar.tEnd);
    if (!e) {
      ctx.notice('no listed expiries');
      return;
    }
    const spot = d.spot > 0 ? d.spot : ctx.bar.c * ctx.tickSize;
    const rows = boardRows(e.strikes, spot, ctx.inputs.strikes);
    const from = Math.max(0, ctx.i - ctx.inputs.width);
    for (const r of rows)
      ctx.out.levels.add({
        bar: from,
        to: -1,
        value: r.strike / ctx.tickSize,
        label:
          `${strikeText(r.strike)}  OI ${compact(r.callOi)}/${compact(r.putOi)}` +
          `  Vol ${compact(r.volume)}${r.iv === null ? '' : `  IV ${(r.iv * 100).toFixed(1)}%`}`,
        tone: r.callOi >= r.putOi ? 0 : 1,
      } satisfies Level);
    const mp = ctx.inputs.maxPain ? maxPainStrike(e.strikes) : null;
    if (mp !== null)
      ctx.out.levels.add({
        bar: from,
        to: -1,
        value: mp / ctx.tickSize,
        label: `Max pain ${strikeText(mp)}`,
        tone: 2,
      } satisfies Level);
    ctx.notice(
      `${srcTag(d)} · ${expiryLabel(e.expiry)}${mp === null ? '' : ` · max pain ${strikeText(mp)}`}`,
    );
  },
});

/**
 * Volatility Smile: implied volatility against strike for the soonest expiries, drawn sideways in
 * the price scale (strike on the price axis, IV along the bars).
 */
export const VolatilitySmile = defineIndicator({
  id: 'volatility-smile',
  name: 'Volatility Smile',
  short: 'Vol smile',
  ...opt,
  needsHost: true,
  needsOptions: true,
  autoscale: false,
  description:
    'Implied volatility against strike (out-of-the-money side) for up to three expiries. Strikes sit on the price axis; higher IV is further to the right. Crypto underlyings (BTC, ETH) use the Deribit public chain; other symbols a simulated chain, always labelled "simulated".',
  formula:
    'IV(K) = put IV for K < forward, call IV otherwise (mid of bid/ask IV, else mark); x = last bar - width + width·(IV - IVmin)/(IVmax - IVmin)',
  inputs: {
    first: input.int('First expiry (1 = soonest)', 1, { min: 1, max: 30 }),
    count: input.int('Expiries', 2, { min: 1, max: 3 }),
    range: input.float('Strike range', 25, {
      min: 2,
      max: 100,
      step: 1,
      unit: '%',
      help: 'Strikes within ± this share of the forward.',
    }),
    width: input.int('Smile width', 40, { min: 10, max: 500, unit: 'bars' }),
  },
  outputs: {
    points: output.markers('Smile', HT.info, { color2: HT.warning, color3: HT.special }),
  },
  title: (p) => `Vol smile #${p.first}`,
  calc(ctx) {
    if (ctx.i !== ctx.count - 1) return;
    const d = ctx.options;
    if (!d) {
      ctx.notice(NO_CHAIN);
      return;
    }
    const exps: OptionExpiryData[] = [];
    for (let k = 0; k < ctx.inputs.count; k++) {
      const e = pickExpiry(d, ctx.inputs.first + k, ctx.bar.tEnd);
      if (e && !exps.includes(e)) exps.push(e);
    }
    const curves = exps.map((e) => smilePoints(e, ctx.inputs.range));
    if (!curves.some((c) => c.length)) {
      ctx.notice('no implied volatilities in range');
      return;
    }
    const lay = smileLayout(curves, ctx.i, ctx.inputs.width);
    const notes: string[] = [];
    curves.forEach((c, k) => {
      c.forEach((p, j) =>
        ctx.out.points.add({
          bar: lay.bars[k]![j]!,
          value: p.strike / ctx.tickSize,
          shape: 'circle',
          size: 2,
          tone: k,
        } satisfies Marker),
      );
      const a = atmIv(c, exps[k]!.forward);
      const label = `${expiryLabel(exps[k]!.expiry)}${a === null ? '' : ` ATM ${(a * 100).toFixed(1)}%`}`;
      notes.push(label);
      if (c.length)
        ctx.out.points.add({
          bar: ctx.i,
          value: exps[k]!.forward / ctx.tickSize,
          shape: 'text',
          size: 0,
          text: label,
          tone: k,
          textPos: 'right',
        } satisfies Marker);
    });
    ctx.notice(
      `${srcTag(d)} · IV ${(lay.min * 100).toFixed(0)}–${(lay.max * 100).toFixed(0)}% · ${notes.join(' · ')}`,
    );
  },
});
