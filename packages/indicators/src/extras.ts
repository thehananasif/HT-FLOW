import {
  HT,
  defineIndicator,
  ema,
  input,
  output,
  periodStart,
  sum,
  type Level,
  type Zone,
} from '@htflow/indicator-sdk';
import { buildTpo, type Bar } from '@htflow/market-data';

/* ------------------------------------------------------------------ CMS */

/**
 * CMS: Cumulative Market Sentiment. Original definition (the catalog lists the abbreviation
 * without a formula): the share of traded volume that was aggressive buying minus aggressive
 * selling over a rolling window, smoothed.
 */
export const CMS = defineIndicator({
  id: 'cms',
  name: 'CMS (Cumulative Market Sentiment)',
  short: 'CMS',
  category: 'technical',
  group: 'Momentum & oscillators',
  pane: 'new',
  range: [-100, 100],
  zeroLine: true,
  description:
    'Cumulative Market Sentiment: net aggressive volume (buy minus sell) over the last N bars as a percentage of all volume, then smoothed. +100 = every contract traded at the ask, -100 = at the bid. Needs a feed with buy / sell volume.',
  formula: 'raw = 100 · Σ(delta, N) / Σ(volume, N); CMS = EMA(raw, smooth)',
  inputs: {
    period: input.int('Window (bars)', 20, { min: 1, max: 500 }),
    smooth: input.int('Smoothing (EMA)', 3, { min: 1, max: 100 }),
  },
  outputs: {
    cms: output.line('CMS', HT.info, { width: 1.6 }),
    raw: output.histogram('Raw', HT.up, { color2: HT.down, opacity: 0.3, legend: false }),
  },
  title: (p) => `CMS ${p.period}/${p.smooth}`,
  calc(ctx) {
    const { i, bar } = ctx;
    const d = ctx.buf('d');
    const v = ctx.buf('v');
    const raw = ctx.buf('raw');
    const sm = ctx.buf('sm');
    d[i] = bar.delta;
    v[i] = bar.vol;
    const sd = sum(d, i, ctx.inputs.period);
    const sv = sum(v, i, ctx.inputs.period);
    raw[i] = Number.isNaN(sd) || Number.isNaN(sv) ? Number.NaN : sv > 0 ? (100 * sd) / sv : 0;
    sm[i] = ema(sm, raw, i, ctx.inputs.smooth);
    ctx.out.cms.set(i, sm[i]!);
    ctx.out.raw.set(i, raw[i]!, raw[i]! >= 0 ? 0 : 1);
  },
});

/* ------------------------------------------------------------------ Margin Zones */

export interface MarginBand {
  /** Leverage of the tightest tier whose positions are liquidated inside this band. */
  leverage: number;
  /** Price span of the band. */
  from: number;
  to: number;
  side: 'long' | 'short';
}

/** Parses "5, 10, 25" into positive leverage tiers (ascending, unique). */
export function parseTiers(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(/[\s,;]+/)) {
    const n = Number(part.replace(/x$/i, ''));
    if (Number.isFinite(n) && n >= 1 && n <= 1000) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Price bands where leveraged positions opened at `ref` run out of margin. A position of leverage
 * L is liquidated once price moves against it by 1/L minus the maintenance margin rate `mmr`
 * (long: ref·(1 - 1/L + mmr), short: ref·(1 + 1/L - mmr)). Tiers whose 1/L <= mmr are dropped.
 * Higher leverage dies closer to `ref`, so the bands nest outwards: the band of tier L spans from
 * the liquidation price of the next higher leverage to that of L (the first from `ref` itself).
 */
export function marginBands(ref: number, tiers: readonly number[], mmr: number): MarginBand[] {
  const valid = [...tiers].filter((l) => l > 0 && 1 / l > mmr).sort((a, b) => b - a);
  const out: MarginBand[] = [];
  for (const side of ['long', 'short'] as const) {
    const sign = side === 'long' ? -1 : 1;
    let prev = ref;
    for (const l of valid) {
      const px = ref * (1 + sign * (1 / l - mmr));
      out.push({
        leverage: l,
        from: Math.min(prev, px),
        to: Math.max(prev, px),
        side,
      });
      prev = px;
    }
  }
  return out;
}

/** Price the margin zones are anchored to. */
export function marginReference(
  bars: readonly Bar[],
  anchor: 'day-open' | 'week-open' | 'last-close',
): number {
  const last = bars[bars.length - 1]!;
  if (anchor === 'last-close') return last.c;
  const tf = anchor === 'day-open' ? 'D' : 'W';
  const key = periodStart(last.t, tf);
  let k = bars.length - 1;
  while (k > 0 && periodStart(bars[k - 1]!.t, tf) === key) k--;
  return bars[k]!.o;
}

/**
 * Margin Zones: where leveraged longs and shorts opened at a reference price would hit their
 * (maintenance) margin, per leverage tier. Original definition, see docs/INDICATORS.md.
 */
export const MarginZones = defineIndicator({
  id: 'margin-zones',
  name: 'Margin Zones',
  short: 'Margin',
  category: 'technical',
  group: 'Levels & structure',
  pane: 'overlay',
  autoscale: false,
  description:
    'Price zones where leveraged positions opened at a reference price (day open, week open or last close) would be liquidated, one band per leverage tier: shorts above, longs below. Higher leverage sits closer to the reference. Liquidation distance = 1 / leverage - maintenance margin rate.',
  formula:
    'long liq = ref·(1 − 1/L + mmr); short liq = ref·(1 + 1/L − mmr); band(L) = [liq(next higher tier), liq(L)]',
  inputs: {
    anchor: input.enum('Reference price', 'day-open', [
      ['day-open', 'Day open (UTC)'],
      ['week-open', 'Week open (UTC)'],
      ['last-close', 'Last close'],
    ]),
    tiers: input.string('Leverage tiers', '3, 5, 10, 25, 50, 100', {
      maxLength: 60,
      help: 'Comma separated, e.g. 5, 10, 20.',
    }),
    mmr: input.float('Maintenance margin', 0.5, { min: 0, max: 20, step: 0.1, unit: '%' }),
    width: input.int('Zone width', 60, { min: 5, max: 1000, unit: 'bars' }),
    labels: input.bool('Label tiers', true),
  },
  outputs: {
    zones: output.zones('Zones', HT.up, { color2: HT.down, opacity: 0.14 }),
    ref: output.levels('Reference', HT.warning),
  },
  title: (p) => `Margin zones (${p.tiers})`,
  calc(ctx) {
    if (ctx.i !== ctx.count - 1) return;
    const ref = marginReference(ctx.bars.slice(0, ctx.count), ctx.inputs.anchor);
    const tiers = parseTiers(ctx.inputs.tiers);
    if (!tiers.length) {
      ctx.notice('no valid leverage tiers');
      return;
    }
    const from = Math.max(0, ctx.i - ctx.inputs.width);
    ctx.out.ref.add({
      bar: from,
      to: -1,
      value: ref,
      label: 'Margin ref',
      tone: 0,
    } satisfies Level);
    for (const b of marginBands(ref, tiers, ctx.inputs.mmr / 100))
      ctx.out.zones.add({
        bar: from,
        to: -1,
        top: b.to,
        bottom: b.from,
        // Shorts get squeezed up (tone 0 = up colour), longs flushed down (tone 1).
        tone: b.side === 'short' ? 0 : 1,
        label: ctx.inputs.labels ? `${b.leverage}x ${b.side}s` : undefined,
      } satisfies Zone);
    ctx.notice(`ref ${+(ref * ctx.tickSize).toFixed(6)} · tiers ${tiers.join('/')}x`);
  },
});

/* ------------------------------------------------------------------ Market Profile & TPO */

export interface ProfileSession {
  /** First / last bar index of the session. */
  from: number;
  to: number;
  /** Prices in ticks. */
  poc: number;
  vah: number;
  val: number;
  ibHigh: number;
  ibLow: number;
  high: number;
  low: number;
  /** Contiguous single-print spans (price ticks, bottom < top). */
  singles: { bottom: number; top: number }[];
  /** Flat extremes (two or more TPOs on the top / bottom row): unfinished auction. */
  poorHigh: boolean;
  poorLow: boolean;
}

/**
 * TPO profiles of the last `sessions` sessions (UTC day or week) built from the chart bars (each
 * bar is one TPO period; 30-minute bars give the classic profile). Pure and deterministic.
 */
export function profileSessions(
  bars: readonly Bar[],
  o: {
    session: 'D' | 'W';
    sessions: number;
    rowTicks: number;
    valueAreaPct: number;
    ibPeriods: number;
  },
): ProfileSession[] {
  const key = (t: number) => periodStart(t, o.session);
  // Bar range of each session key, newest sessions last.
  const ranges = new Map<number, [number, number]>();
  for (let i = 0; i < bars.length; i++) {
    const k = key(bars[i]!.t);
    const r = ranges.get(k);
    if (r) r[1] = i;
    else ranges.set(k, [i, i]);
  }
  const keep = [...ranges.keys()].slice(-Math.max(1, o.sessions));
  const first = ranges.get(keep[0]!)![0];
  const profiles = buildTpo(bars.slice(first), {
    rowTicks: o.rowTicks,
    valueAreaPct: o.valueAreaPct / 100,
    ibPeriods: o.ibPeriods,
    profileKey: key,
  });
  const rt = Math.max(1, Math.floor(o.rowTicks));
  return profiles.flatMap((p) => {
    const r = ranges.get(p.start);
    if (!r) return [];
    const runs: { bottom: number; top: number }[] = [];
    for (const row of p.singles) {
      const last = runs[runs.length - 1];
      if (last && last.top === row * rt) last.top = (row + 1) * rt;
      else runs.push({ bottom: row * rt, top: (row + 1) * rt });
    }
    const count = (row: number) => p.rows.get(row)?.length ?? 0;
    return [
      {
        from: r[0],
        to: r[1],
        poc: (p.poc + 0.5) * rt,
        vah: (p.vah + 1) * rt,
        val: p.val * rt,
        ibHigh: (p.ibHi + 1) * rt,
        ibLow: p.ibLo * rt,
        high: (p.hi + 1) * rt,
        low: p.lo * rt,
        singles: runs,
        poorHigh: p.periods.length > 1 && count(p.hi) >= 2,
        poorLow: p.periods.length > 1 && count(p.lo) >= 2,
      },
    ];
  });
}

/**
 * Market Profile & TPO as a chart overlay: per session the value area, point of control, initial
 * balance, single prints and poor highs / lows computed from time-price opportunities. For the
 * full letter view use the TPO chart type; this overlay puts the same structure on any chart.
 */
export const MarketProfile = defineIndicator({
  id: 'market-profile',
  name: 'Market Profile & TPO',
  short: 'Profile',
  category: 'volume-orderflow',
  pane: 'overlay',
  autoscale: false,
  description:
    'Market Profile structure per session from time-price opportunities (each chart bar is one TPO period; use 30-minute bars for the classic profile): value area, point of control, initial balance, single prints and poor highs / lows. The letter view is the TPO chart type.',
  formula:
    'TPO count per price row = periods that traded through it; POC = row with most TPOs; value area = the rows around the POC holding VA % of all TPOs; IB = range of the first N periods; single print = row with one TPO; poor high / low = two or more TPOs on the extreme row',
  inputs: {
    session: input.enum('Profile per', 'D', [
      ['D', 'Day (UTC)'],
      ['W', 'Week (UTC)'],
    ]),
    sessions: input.int('Sessions shown', 3, { min: 1, max: 30 }),
    rowTicks: input.int('Row size', 4, { min: 1, max: 10_000, unit: 'ticks' }),
    valueArea: input.float('Value area', 70, { min: 10, max: 100, step: 1, unit: '%' }),
    ib: input.int('Initial balance periods', 2, { min: 1, max: 24 }),
    singles: input.bool('Single prints', true),
    poor: input.bool('Poor highs / lows', true),
    initialBalance: input.bool('Initial balance', true),
  },
  outputs: {
    zones: output.zones('Value area / singles', HT.info, {
      color2: HT.warning,
      opacity: 0.12,
    }),
    levels: output.levels('POC / VAH / VAL', HT.warning, {
      color2: HT.info,
      color3: HT.grey,
    }),
  },
  title: (p) => `Market profile ${p.session === 'D' ? 'day' : 'week'} ${p.rowTicks}t`,
  calc(ctx) {
    if (ctx.i !== ctx.count - 1) return;
    const sessions = profileSessions(ctx.bars.slice(0, ctx.count), {
      session: ctx.inputs.session,
      sessions: ctx.inputs.sessions,
      rowTicks: ctx.inputs.rowTicks,
      valueAreaPct: ctx.inputs.valueArea,
      ibPeriods: ctx.inputs.ib,
    });
    if (!sessions.length) {
      ctx.notice('no volume to profile');
      return;
    }
    sessions.forEach((s, k) => {
      const to = k === sessions.length - 1 ? -1 : s.to;
      const lv = (value: number, label: string, tone: number) =>
        ctx.out.levels.add({ bar: s.from, to, value, label, tone } satisfies Level);
      ctx.out.zones.add({
        bar: s.from,
        to,
        top: s.vah,
        bottom: s.val,
        tone: 0,
        label: 'VA',
      } satisfies Zone);
      lv(s.poc, 'POC', 0);
      lv(s.vah, 'VAH', 1);
      lv(s.val, 'VAL', 1);
      if (ctx.inputs.initialBalance) {
        lv(s.ibHigh, 'IB high', 2);
        lv(s.ibLow, 'IB low', 2);
      }
      if (ctx.inputs.singles)
        for (const g of s.singles)
          ctx.out.zones.add({
            bar: s.from,
            to,
            top: g.top,
            bottom: g.bottom,
            tone: 1,
            label: 'single',
          } satisfies Zone);
      if (ctx.inputs.poor) {
        if (s.poorHigh) lv(s.high, 'poor high', 2);
        if (s.poorLow) lv(s.low, 'poor low', 2);
      }
    });
    const last = sessions[sessions.length - 1]!;
    ctx.notice(
      `POC ${+(last.poc * ctx.tickSize).toFixed(6)} · VA ${+(last.val * ctx.tickSize).toFixed(6)}–${+(last.vah * ctx.tickSize).toFixed(6)}`,
    );
  },
});
