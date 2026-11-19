import {
  COT_RELEASE_LAG_MS,
  HT,
  NO_FEED_NOTICE,
  defineIndicator,
  input,
  output,
  type CotWeekData,
} from '@htflow/indicator-sdk';

/**
 * CFTC Commitments of Traders (weekly, free public data). Positions are as of Tuesday and become
 * public on Friday 20:30 UTC: a bar only sees a week once it was published (no look-ahead), and
 * the value then holds until the next report (step lines). Needs a COT-capable instrument; others
 * report "no data from this feed".
 */
const cot = { category: 'cot' as const };

/** Trader categories by role, across the three reports (first match in each list wins). */
const HEDGERS = ['commercial', 'producer', 'dealer'];
const SPECS = ['noncommercial', 'managed', 'levmoney'];
const INSTITUTIONAL = ['assetmgr', 'managed', 'noncommercial'];
const SMALL = ['nonreportable'];

/** The week published at or before the end of bar i's open (undefined before the first one). */
export function weekFor(
  weeks: readonly CotWeekData[],
  barT: number,
): { week: CotWeekData; idx: number } | undefined {
  let lo = 0;
  let hi = weeks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (weeks[mid]!.t + COT_RELEASE_LAG_MS <= barT) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? { week: weeks[lo - 1]!, idx: lo - 1 } : undefined;
}

export function groupOf(w: CotWeekData, keys: readonly string[]) {
  for (const k of keys) {
    const g = w.groups.find((x) => x.key === k);
    if (g) return g;
  }
  return undefined;
}

const pct = (net: number, oi: number) => (oi ? (net / oi) * 100 : Number.NaN);

export const CotNetPositions = defineIndicator({
  id: 'cot',
  name: 'COT',
  short: 'COT',
  ...cot,
  pane: 'new',
  zeroLine: true,
  description:
    'CFTC Commitments of Traders: weekly net positions (long - short) of hedgers, speculators and small traders. Shown from the Friday the report was published.',
  formula:
    'net = long - short per trader category; hedgers = commercials / producers / dealers; speculators = non-commercials / managed money / leveraged funds',
  inputs: {
    asPct: input.bool('As % of open interest', false),
  },
  outputs: {
    hedgers: output.step('Hedgers net', HT.info, { legend: true }),
    specs: output.step('Speculators net', HT.warning, { legend: true }),
    small: output.step('Small traders net', HT.grey, { legend: true }),
  },
  title: (p) => `COT net${p.asPct ? ' %OI' : ''}`,
  calc(ctx) {
    const weeks = ctx.cot?.weeks ?? [];
    if (!weeks.length) {
      ctx.notice(NO_FEED_NOTICE);
      return;
    }
    const f = weekFor(weeks, ctx.bar.t);
    if (!f) return;
    const v = (keys: string[]) => {
      const g = groupOf(f.week, keys);
      return g ? (ctx.inputs.asPct ? pct(g.net, f.week.openInterest) : g.net) : Number.NaN;
    };
    ctx.out.hedgers.set(ctx.i, v(HEDGERS));
    ctx.out.specs.set(ctx.i, v(SPECS));
    ctx.out.small.set(ctx.i, v(SMALL));
  },
});

export const CotCommNonComm = defineIndicator({
  id: 'cot-comm-noncomm',
  name: 'COT Commercials / Non-Commercials',
  short: 'COT C/NC',
  ...cot,
  pane: 'new',
  zeroLine: true,
  description:
    'Net position of commercial hedgers against non-commercial speculators (Legacy report; the closest categories are used for Disaggregated and TFF). Commercials usually trade against the trend.',
  formula:
    'commercials net = long - short; non-commercials net = long - short; spread = difference',
  inputs: {
    asPct: input.bool('As % of open interest', false),
  },
  outputs: {
    comm: output.line('Commercials net', HT.info, { width: 1.5 }),
    noncomm: output.line('Non-commercials net', HT.warning, { width: 1.5 }),
    diff: output.histogram('Non-comm minus comm', HT.up, { color2: HT.down, opacity: 0.35 }),
  },
  title: (p) => `COT Comm / Non-comm${p.asPct ? ' %OI' : ''}`,
  calc(ctx) {
    const weeks = ctx.cot?.weeks ?? [];
    if (!weeks.length) {
      ctx.notice(NO_FEED_NOTICE);
      return;
    }
    const f = weekFor(weeks, ctx.bar.t);
    if (!f) return;
    const h = groupOf(f.week, HEDGERS);
    const s = groupOf(f.week, SPECS);
    if (!h || !s) return;
    const k = (n: number) => (ctx.inputs.asPct ? pct(n, f.week.openInterest) : n);
    ctx.out.comm.set(ctx.i, k(h.net));
    ctx.out.noncomm.set(ctx.i, k(s.net));
    const d = k(s.net) - k(h.net);
    ctx.out.diff.set(ctx.i, d, d >= 0 ? 0 : 1);
  },
});

export const CotInstitutional = defineIndicator({
  id: 'cot-institutional',
  name: 'COT Institutional Net Positions',
  short: 'COT Inst',
  ...cot,
  pane: 'new',
  zeroLine: true,
  description:
    'Net position of institutional money: asset managers (TFF), managed money (Disaggregated) or non-commercials (Legacy), with the week-over-week change as histogram.',
  formula: 'net = long - short; change = net - net of the previous report',
  inputs: {
    asPct: input.bool('As % of open interest', false),
  },
  outputs: {
    net: output.step('Institutional net', HT.special, { width: 1.8 }),
    chg: output.histogram('Weekly change', HT.up, { color2: HT.down, opacity: 0.5 }),
  },
  title: (p) => `COT institutional${p.asPct ? ' %OI' : ''}`,
  calc(ctx) {
    const weeks = ctx.cot?.weeks ?? [];
    if (!weeks.length) {
      ctx.notice(NO_FEED_NOTICE);
      return;
    }
    const f = weekFor(weeks, ctx.bar.t);
    if (!f) return;
    const g = groupOf(f.week, INSTITUTIONAL);
    if (!g) return;
    const k = (n: number) => (ctx.inputs.asPct ? pct(n, f.week.openInterest) : n);
    ctx.out.net.set(ctx.i, k(g.net));
    const c = k(g.netChange);
    ctx.out.chg.set(ctx.i, c, c >= 0 ? 0 : 1);
  },
});

export const CotHighLow = defineIndicator({
  id: 'cot-high-low',
  name: 'COT High/Low',
  short: 'COT H/L',
  ...cot,
  pane: 'new',
  zeroLine: true,
  description:
    'Speculators net position against its highest and lowest value of the last N weekly reports, plus the COT index (0 = lowest, 100 = highest of the window).',
  formula: 'index = 100 × (net - low) / (high - low) over the last N reports',
  inputs: {
    weeks: input.int('Window (weeks)', 52, { min: 4, max: 520, help: '52 = one year.' }),
    showIndex: input.bool('Show COT index (0-100) instead of the net', false),
  },
  outputs: {
    net: output.step('Speculators net', HT.warning, { width: 1.8 }),
    high: output.step('Window high', HT.up, { style: 'dashed', width: 1 }),
    low: output.step('Window low', HT.down, { style: 'dashed', width: 1 }),
  },
  title: (p) => `COT ${p.weeks}w high/low${p.showIndex ? ' index' : ''}`,
  calc(ctx) {
    const weeks = ctx.cot?.weeks ?? [];
    if (!weeks.length) {
      ctx.notice(NO_FEED_NOTICE);
      return;
    }
    const f = weekFor(weeks, ctx.bar.t);
    if (!f) return;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = Math.max(0, f.idx - ctx.inputs.weeks + 1); j <= f.idx; j++) {
      const g = groupOf(weeks[j]!, SPECS);
      if (!g) continue;
      hi = Math.max(hi, g.net);
      lo = Math.min(lo, g.net);
    }
    const cur = groupOf(f.week, SPECS);
    if (!cur || !Number.isFinite(hi)) return;
    if (ctx.inputs.showIndex) {
      ctx.out.net.set(ctx.i, hi === lo ? 50 : (100 * (cur.net - lo)) / (hi - lo));
      ctx.out.high.set(ctx.i, 100);
      ctx.out.low.set(ctx.i, 0);
    } else {
      ctx.out.net.set(ctx.i, cur.net);
      ctx.out.high.set(ctx.i, hi);
      ctx.out.low.set(ctx.i, lo);
    }
  },
});
