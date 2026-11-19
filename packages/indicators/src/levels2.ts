import {
  HT,
  defineIndicator,
  highest,
  input,
  lowest,
  output,
  periodStart,
  type Marker,
  type Zone,
} from '@htflow/indicator-sdk';
import { pivotAt } from './trend2';
import { openFrom } from './common';

const lv = { category: 'technical' as const, group: 'Levels & structure' };
const NaN_ = Number.NaN;
const DAY = 86_400_000;

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

export const FibAuto = defineIndicator({
  id: 'fib-auto',
  name: 'Fibonacci Retracement (auto)',
  short: 'Fib',
  ...lv,
  pane: 'overlay',
  autoscale: false,
  description:
    'Retracement levels of the latest swing leg (last confirmed swing high ↔ swing low).',
  formula:
    'Last pivot a high: price = H − k·(H − L); last pivot a low: price = L + k·(H − L), k = 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1',
  inputs: {
    left: input.int('Pivot bars left', 5, { min: 1, max: 50 }),
    right: input.int('Pivot bars right', 5, { min: 1, max: 50 }),
  },
  outputs: Object.fromEntries(
    FIB.map((k, n) => [
      `f${n}`,
      output.step(String(k), k === 0.5 || k === 0.618 ? HT.warning : HT.grey, {
        unit: 'price' as const,
        width: 1,
        style: k === 0 || k === 1 ? ('solid' as const) : ('dashed' as const),
        legend: false,
      }),
    ]),
  ) as Record<`f${0 | 1 | 2 | 3 | 4 | 5 | 6}`, ReturnType<typeof output.step>>,
  title: (p) => `Fib auto ${p.left}/${p.right}`,
  calc(ctx) {
    const { left, right } = ctx.inputs;
    const i = ctx.i;
    const hi = ctx.src('high');
    const lo = ctx.src('low');
    const H = ctx.buf('H');
    const Hx = ctx.buf('Hx');
    const L = ctx.buf('L');
    const Lx = ctx.buf('Lx');
    for (const a of [H, Hx, L, Lx]) a[i] = i > 0 ? a[i - 1]! : NaN_;
    const j = i - right;
    if (j >= left) {
      const pv = pivotAt(hi, lo, j, left, right);
      if (pv.high) {
        H[i] = hi[j]!;
        Hx[i] = j;
      }
      if (pv.low) {
        L[i] = lo[j]!;
        Lx[i] = j;
      }
    }
    if (Number.isNaN(H[i]! + L[i]!)) return;
    const up = Lx[i]! < Hx[i]!; // last pivot is the high
    const o = ctx.out as unknown as Record<string, { v: Float64Array }>;
    FIB.forEach((k, n) => {
      o[`f${n}`]!.v[i] = up ? H[i]! - k * (H[i]! - L[i]!) : L[i]! + k * (H[i]! - L[i]!);
    });
  },
});

export const FVG = defineIndicator({
  id: 'fvg',
  name: 'Fair Value Gaps (FVG)',
  short: 'FVG',
  ...lv,
  pane: 'overlay',
  autoscale: false,
  description:
    'Three-candle imbalances: the gap between the first candle and the third that the middle candle left unfilled. Zones extend until price trades back into them.',
  formula:
    'Bullish: L[i] > H[i−2] → zone [H[i−2], L[i]]; bearish: H[i] < L[i−2] → zone [H[i], L[i−2]]',
  inputs: {
    minTicks: input.int('Minimum gap (ticks)', 1, { min: 0, max: 100000 }),
    fill: input.enum('Mitigated when', 'touch', [
      ['touch', 'Price touches the zone'],
      ['full', 'Price crosses the whole zone'],
    ]),
    maxBars: input.int('Max zone length (bars)', 300, { min: 1, max: 100000 }),
  },
  outputs: { zones: output.zones('FVG', HT.up, { color2: HT.down, opacity: 0.25 }) },
  title: (p) => `FVG ≥${p.minTicks}t`,
  calc(ctx) {
    const { minTicks, fill, maxBars } = ctx.inputs;
    const i = ctx.i;
    const b = ctx.bar;
    const zs = ctx.out.zones.items;
    for (let k = openFrom(zs, ctx.buf('open'), i); k < zs.length; k++) {
      const z = zs[k]!;
      if (z.to >= 0 && z.to < i) continue;
      if (z.bar >= i) continue;
      const bull = z.tone === 0;
      const hit = bull
        ? fill === 'touch'
          ? b.l <= z.top
          : b.l <= z.bottom
        : fill === 'touch'
          ? b.h >= z.bottom
          : b.h >= z.top;
      if (hit || i - z.bar >= maxBars) z.to = i;
      else z.to = -1;
    }
    if (i < 2) return;
    const p2 = ctx.bars[i - 2]!;
    if (b.l - p2.h >= Math.max(minTicks, 1e-9))
      ctx.out.zones.add({ bar: i - 1, to: -1, top: b.l, bottom: p2.h, tone: 0 } satisfies Zone);
    else if (p2.l - b.h >= Math.max(minTicks, 1e-9))
      ctx.out.zones.add({ bar: i - 1, to: -1, top: p2.l, bottom: b.h, tone: 1 } satisfies Zone);
  },
});

export const OrderBlocks = defineIndicator({
  id: 'order-blocks',
  name: 'Order Blocks',
  short: 'OB',
  ...lv,
  pane: 'overlay',
  autoscale: false,
  description:
    'The last opposite candle before an impulsive break of the recent range: demand block (last down candle before a break up) and supply block (last up candle before a break down). Zones extend until price closes through them.',
  formula:
    'Break up: C > HH(n)₋₁ (first such bar) → block = last candle with C < O in the previous k bars; mirrored for supply',
  inputs: {
    n: input.int('Range bars', 10, { min: 2, max: 500 }),
    lookback: input.int('Search bars', 10, { min: 1, max: 100 }),
    maxBars: input.int('Max zone length (bars)', 300, { min: 1, max: 100000 }),
  },
  outputs: { zones: output.zones('Order blocks', HT.up, { color2: HT.down, opacity: 0.25 }) },
  title: (p) => `Order Blocks ${p.n}`,
  calc(ctx) {
    const { n, lookback, maxBars } = ctx.inputs;
    const i = ctx.i;
    const b = ctx.bar;
    const zs = ctx.out.zones.items;
    for (let k = openFrom(zs, ctx.buf('open'), i); k < zs.length; k++) {
      const z = zs[k]!;
      if (z.to >= 0 && z.to < i) continue;
      if (z.bar >= i) continue;
      const hit = z.tone === 0 ? b.c < z.bottom : b.c > z.top;
      if (hit || i - z.bar >= maxBars) z.to = i;
      else z.to = -1;
    }
    if (i < n + 1) return;
    const hi = ctx.src('high');
    const lo = ctx.src('low');
    const brokeUp = b.c > highest(hi, i - 1, n) && ctx.bars[i - 1]!.c <= highest(hi, i - 2, n);
    const brokeDn = b.c < lowest(lo, i - 1, n) && ctx.bars[i - 1]!.c >= lowest(lo, i - 2, n);
    if (!brokeUp && !brokeDn) return;
    for (let k = i - 1; k >= Math.max(0, i - lookback); k--) {
      const c = ctx.bars[k]!;
      if (brokeUp ? c.c < c.o : c.c > c.o) {
        ctx.out.zones.add({
          bar: k,
          to: -1,
          top: c.h,
          bottom: c.l,
          tone: brokeUp ? 0 : 1,
        } satisfies Zone);
        break;
      }
    }
  },
});

export const LiquiditySweeps = defineIndicator({
  id: 'liquidity-sweeps',
  name: 'Liquidity Sweeps',
  short: 'Sweeps',
  ...lv,
  pane: 'overlay',
  autoscale: false,
  description:
    'A wick that takes out the last swing high / low and closes back inside the range: stops were run and price rejected.',
  formula:
    'Bearish sweep: H > swing high and C < swing high; bullish sweep: L < swing low and C > swing low (swing = n bars each side)',
  inputs: { n: input.int('Swing bars each side', 5, { min: 1, max: 50 }) },
  outputs: {
    sweeps: output.markers('Sweeps', HT.up, { color2: HT.down }),
    levels: output.levels('Swept level', HT.grey, { style: 'dotted' }),
  },
  title: (p) => `Liquidity Sweeps ${p.n}`,
  calc(ctx) {
    const n = ctx.inputs.n;
    const i = ctx.i;
    const hi = ctx.src('high');
    const lo = ctx.src('low');
    const sh = ctx.buf('sh');
    const shx = ctx.buf('shx');
    const sl = ctx.buf('sl');
    const slx = ctx.buf('slx');
    const ok = ctx.buf('hok');
    const ok2 = ctx.buf('lok');
    for (const a of [sh, shx, sl, slx, ok, ok2]) a[i] = i > 0 ? a[i - 1]! : NaN_;
    const j = i - n;
    if (j >= n) {
      const pv = pivotAt(hi, lo, j, n, n);
      if (pv.high) {
        sh[i] = hi[j]!;
        shx[i] = j;
        ok[i] = 1;
      }
      if (pv.low) {
        sl[i] = lo[j]!;
        slx[i] = j;
        ok2[i] = 1;
      }
    }
    const b = ctx.bar;
    if (ok[i] === 1 && b.h > sh[i]!) {
      ok[i] = 0;
      if (b.c < sh[i]!) {
        ctx.out.sweeps.add({
          bar: i,
          value: b.h,
          shape: 'triangleDown',
          size: 5,
          tone: 1,
          textPos: 'above',
        } satisfies Marker);
        ctx.out.levels.add({ bar: shx[i]!, to: i, value: sh[i]!, tone: 0 });
      }
    }
    if (ok2[i] === 1 && b.l < sl[i]!) {
      ok2[i] = 0;
      if (b.c > sl[i]!) {
        ctx.out.sweeps.add({
          bar: i,
          value: b.l,
          shape: 'triangleUp',
          size: 5,
          tone: 0,
          textPos: 'below',
        } satisfies Marker);
        ctx.out.levels.add({ bar: slx[i]!, to: i, value: sl[i]!, tone: 0 });
      }
    }
  },
});

export const DailyLines = defineIndicator({
  id: 'daily-lines',
  name: 'Daily Lines',
  short: 'Daily',
  ...lv,
  pane: 'overlay',
  autoscale: false,
  description: "Today's open, the developing high / low and the previous day's close as lines.",
  formula:
    'Open = first print of the UTC day; High / Low = running extremes of the day; Prev C = last close of the previous day',
  inputs: {},
  outputs: {
    open: output.step('Open', HT.warning, { unit: 'price', width: 1 }),
    high: output.step('Day high', HT.down, { unit: 'price', width: 1, style: 'dashed' }),
    low: output.step('Day low', HT.up, { unit: 'price', width: 1, style: 'dashed' }),
    prevClose: output.step('Prev close', HT.soft, { unit: 'price', width: 1, style: 'dotted' }),
  },
  title: () => 'Daily lines',
  calc(ctx) {
    const { i, bar } = ctx;
    const o = ctx.buf('o');
    const h = ctx.buf('h');
    const l = ctx.buf('l');
    const pc = ctx.buf('pc');
    const fresh = i === 0 || periodStart(ctx.bars[i - 1]!.t, 'D') !== periodStart(bar.t, 'D');
    if (fresh) {
      o[i] = bar.o;
      h[i] = bar.h;
      l[i] = bar.l;
      pc[i] = i > 0 ? ctx.bars[i - 1]!.c : NaN_;
    } else {
      o[i] = o[i - 1]!;
      h[i] = Math.max(h[i - 1]!, bar.h);
      l[i] = Math.min(l[i - 1]!, bar.l);
      pc[i] = pc[i - 1]!;
    }
    ctx.out.open.set(i, o[i]!);
    ctx.out.high.set(i, h[i]!);
    ctx.out.low.set(i, l[i]!);
    ctx.out.prevClose.set(i, pc[i]!);
  },
});

const PERIOD_TFS = ['D', 'W', 'MN'] as const;

export const PeriodHighLow = defineIndicator({
  id: 'period-high-low',
  name: 'Daily / Weekly / Monthly High-Low',
  short: 'D/W/M H-L',
  ...lv,
  pane: 'overlay',
  autoscale: false,
  description:
    'High and low of the previous day, week and month as horizontal levels (each can be switched off).',
  formula: 'PDH / PDL, PWH / PWL, PMH / PML = extremes of the previous completed period',
  inputs: {
    day: input.bool('Previous day', true),
    week: input.bool('Previous week', true),
    month: input.bool('Previous month', false),
  },
  outputs: {
    pdh: output.step('PDH', HT.down, { unit: 'price', width: 1 }),
    pdl: output.step('PDL', HT.up, { unit: 'price', width: 1 }),
    pwh: output.step('PWH', HT.down, { unit: 'price', width: 1, style: 'dashed' }),
    pwl: output.step('PWL', HT.up, { unit: 'price', width: 1, style: 'dashed' }),
    pmh: output.step('PMH', HT.down, { unit: 'price', width: 1, style: 'dotted' }),
    pml: output.step('PML', HT.up, { unit: 'price', width: 1, style: 'dotted' }),
  },
  title: () => 'Prev D/W/M high-low',
  calc(ctx) {
    const { i, bar } = ctx;
    const o = ctx.out as unknown as Record<string, { v: Float64Array }>;
    PERIOD_TFS.forEach((tf, k) => {
      const on = [ctx.inputs.day, ctx.inputs.week, ctx.inputs.month][k]!;
      const ch = ctx.buf('ch' + k);
      const cl = ctx.buf('cl' + k);
      const ph = ctx.buf('ph' + k);
      const pl = ctx.buf('pl' + k);
      const fresh = i === 0 || periodStart(ctx.bars[i - 1]!.t, tf) !== periodStart(bar.t, tf);
      if (fresh) {
        ch[i] = bar.h;
        cl[i] = bar.l;
        ph[i] = i > 0 ? ch[i - 1]! : NaN_;
        pl[i] = i > 0 ? cl[i - 1]! : NaN_;
      } else {
        ch[i] = Math.max(ch[i - 1]!, bar.h);
        cl[i] = Math.min(cl[i - 1]!, bar.l);
        ph[i] = ph[i - 1]!;
        pl[i] = pl[i - 1]!;
      }
      if (!on) return;
      const [hn, ln] = [
        ['pdh', 'pdl'],
        ['pwh', 'pwl'],
        ['pmh', 'pml'],
      ][k]!;
      o[hn!]!.v[i] = ph[i]!;
      o[ln!]!.v[i] = pl[i]!;
    });
  },
});

function rangeWindow(id: string, name: string, short: string, minutes: number) {
  return defineIndicator({
    id,
    name,
    short,
    ...lv,
    pane: 'overlay' as const,
    autoscale: false,
    description: `High, low and midpoint of the first ${minutes} minutes of each UTC session; held for the rest of the day.`,
    formula:
      'High / Low = extremes of bars opening in [session start + offset, + minutes); Mid = (High + Low)/2',
    inputs: {
      minutes: input.int('Window (minutes)', minutes, { min: 1, max: 1440 }),
      offset: input.int('Start offset (minutes after 00:00 UTC)', 0, { min: 0, max: 1439 }),
    },
    outputs: {
      high: output.step('High', HT.down, { unit: 'price', width: 1 }),
      mid: output.step('Mid', HT.grey, { unit: 'price', width: 1, style: 'dotted' }),
      low: output.step('Low', HT.up, { unit: 'price', width: 1 }),
    },
    title: (p) => `${short} ${p.minutes}m`,
    calc(ctx) {
      const { i, bar } = ctx;
      const hb = ctx.buf('h');
      const lb = ctx.buf('l');
      const day = periodStart(bar.t, 'D');
      const start = day + ctx.inputs.offset * 60_000;
      const inWin = bar.t >= start && bar.t < start + ctx.inputs.minutes * 60_000;
      const fresh = i === 0 || periodStart(ctx.bars[i - 1]!.t, 'D') !== day;
      const ph = fresh ? NaN_ : hb[i - 1]!;
      const pl = fresh ? NaN_ : lb[i - 1]!;
      if (inWin) {
        hb[i] = Number.isNaN(ph) ? bar.h : Math.max(ph, bar.h);
        lb[i] = Number.isNaN(pl) ? bar.l : Math.min(pl, bar.l);
      } else {
        hb[i] = ph;
        lb[i] = pl;
      }
      ctx.out.high.set(i, hb[i]!);
      ctx.out.low.set(i, lb[i]!);
      ctx.out.mid.set(i, (hb[i]! + lb[i]!) / 2);
    },
  });
}

export const OpeningRange = rangeWindow('opening-range', 'Opening Range', 'OR', 30);
export const InitialBalance = rangeWindow('initial-balance', 'Initial Balance', 'IB', 60);

export const Gaps = defineIndicator({
  id: 'gaps',
  name: 'Gaps',
  short: 'Gaps',
  ...lv,
  pane: 'overlay',
  autoscale: false,
  description:
    'Price gaps between the previous close and the next open, extended until price trades back to the previous close.',
  formula:
    'Gap = O − C₋ (|Gap| ≥ minimum); zone = [min(O, C₋), max(O, C₋)]; filled when price touches C₋',
  inputs: {
    scope: input.enum('Gaps between', 'session', [
      ['session', 'Sessions (first bar of the UTC day)'],
      ['bar', 'Any two consecutive bars'],
    ]),
    minTicks: input.int('Minimum gap (ticks)', 1, { min: 1, max: 1_000_000 }),
    maxBars: input.int('Max zone length (bars)', 1000, { min: 1, max: 1_000_000 }),
  },
  outputs: { zones: output.zones('Gaps', HT.up, { color2: HT.down, opacity: 0.25 }) },
  title: (p) => `Gaps ${p.scope}`,
  calc(ctx) {
    const { scope, minTicks, maxBars } = ctx.inputs;
    const i = ctx.i;
    const b = ctx.bar;
    for (const z of ctx.out.zones.items) {
      if (z.to >= 0 && z.to < i) continue;
      if (z.bar >= i) continue;
      const hit = z.tone === 0 ? b.l <= z.bottom : b.h >= z.top;
      if (hit || i - z.bar >= maxBars) z.to = i;
      else z.to = -1;
    }
    if (i === 0) return;
    const p = ctx.bars[i - 1]!;
    if (scope === 'session' && periodStart(p.t, 'D') === periodStart(b.t, 'D')) return;
    const gap = b.o - p.c;
    if (Math.abs(gap) < minTicks) return;
    if (gap > 0 ? b.l <= p.c : b.h >= p.c) return; // already filled inside the same bar
    ctx.out.zones.add({
      bar: i,
      to: -1,
      top: Math.max(b.o, p.c),
      bottom: Math.min(b.o, p.c),
      tone: gap > 0 ? 0 : 1,
    } satisfies Zone);
  },
});

export const SessionHighLow = defineIndicator({
  id: 'session-high-low',
  name: 'Session Highs/Lows',
  short: 'Session H/L',
  ...lv,
  pane: 'overlay',
  autoscale: false,
  description:
    'Developing high and low of a trading session (UTC hours, wraps midnight), held after the session ends until the next one starts.',
  formula:
    'High / Low = extremes of bars opening inside [start, end) hours UTC since the session began',
  inputs: {
    start: input.float('Session start (hour UTC)', 7, { min: 0, max: 24, step: 0.5 }),
    end: input.float('Session end (hour UTC)', 16, { min: 0, max: 24, step: 0.5 }),
  },
  outputs: {
    high: output.step('Session high', HT.down, { unit: 'price', width: 1 }),
    low: output.step('Session low', HT.up, { unit: 'price', width: 1 }),
  },
  title: (p) => `Session ${p.start}–${p.end} UTC`,
  calc(ctx) {
    const { i, bar } = ctx;
    const { start, end } = ctx.inputs;
    const hod = (t: number) => (((t % DAY) + DAY) % DAY) / 3_600_000;
    const inS = (t: number) => {
      const h = hod(t);
      return start <= end ? h >= start && h < end : h >= start || h < end;
    };
    const hb = ctx.buf('h');
    const lb = ctx.buf('l');
    const now = inS(bar.t);
    const was = i > 0 && inS(ctx.bars[i - 1]!.t);
    const ph = i > 0 ? hb[i - 1]! : NaN_;
    const pl = i > 0 ? lb[i - 1]! : NaN_;
    if (now) {
      const fresh = !was || Number.isNaN(ph);
      hb[i] = fresh ? bar.h : Math.max(ph, bar.h);
      lb[i] = fresh ? bar.l : Math.min(pl, bar.l);
    } else {
      hb[i] = ph;
      lb[i] = pl;
    }
    ctx.out.high.set(i, hb[i]!);
    ctx.out.low.set(i, lb[i]!);
  },
});

interface SeasState {
  sum: Float64Array;
  cnt: Float64Array;
}

export const Seasonality = defineIndicator({
  id: 'seasonality',
  name: 'Seasonality',
  short: 'Seasonality',
  ...lv,
  pane: 'new',
  description:
    'Average return of all previous bars that opened in the same hour of the day (or day of the week) as the current bar.',
  formula:
    'Return = 100·(C − O)/O; Seasonality(i) = mean of Return over earlier bars with the same bucket',
  zeroLine: true,
  inputs: {
    bucket: input.enum('Bucket', 'hour', [
      ['hour', 'Hour of day (UTC)'],
      ['dow', 'Day of week (UTC)'],
    ]),
  },
  outputs: {
    avg: output.histogram('Avg return', HT.up, { color2: HT.down, opacity: 0.75, unit: 'percent' }),
  },
  title: (p) => `Seasonality ${p.bucket}`,
  init: (): SeasState => ({ sum: new Float64Array(24 * 7), cnt: new Float64Array(24 * 7) }),
  calc(ctx) {
    const s = ctx.state as SeasState;
    const t = ctx.bar.t;
    const k =
      ctx.inputs.bucket === 'hour'
        ? Math.floor((((t % DAY) + DAY) % DAY) / 3_600_000)
        : (new Date(t).getUTCDay() + 6) % 7;
    if (s.cnt[k]! > 0) ctx.out.avg.set(ctx.i, s.sum[k]! / s.cnt[k]!, s.sum[k]! >= 0 ? 0 : 1);
    if (ctx.final && ctx.bar.o !== 0) {
      s.sum[k] = s.sum[k]! + (100 * (ctx.bar.c - ctx.bar.o)) / ctx.bar.o;
      s.cnt[k] = s.cnt[k]! + 1;
    }
  },
});
