import {
  HT,
  NO_FEED_NOTICE,
  defineIndicator,
  highest,
  input,
  lowest,
  lowerBoundBy,
  output,
  sma,
  type Level,
  type Marker,
} from '@htflow/indicator-sdk';
import { formatCompact, type DepthColumn } from '@htflow/market-data';

const ob = { category: 'order-book' as const };

/** Depth columns sampled inside bar i (up to the next bar's open; the last bar is open-ended). */
function barColumns(
  columns: readonly DepthColumn[],
  bars: readonly { t: number }[],
  i: number,
): DepthColumn[] {
  const t0 = bars[i]!.t;
  const t1 = bars[i + 1]?.t ?? Infinity;
  const out: DepthColumn[] = [];
  for (let k = lowerBoundBy(columns, t0, (c) => c.t); k < columns.length && columns[k]!.t < t1; k++)
    out.push(columns[k]!);
  return out;
}

/** Resting size within `ticks` of the touch: [bids, asks]. */
function depthWithin(c: DepthColumn, ticks: number): [number, number] {
  let bid = 0;
  let ask = 0;
  for (let k = 0; k < c.pxs.length; k++) {
    const px = c.pxs[k]!;
    const q = c.qtys[k]!;
    if (px <= c.bestBid) {
      if (c.bestBid - px <= ticks) bid += q;
    } else if (px - c.bestAsk <= ticks) ask += q;
  }
  return [bid, ask];
}

const ticksIn = () =>
  input.int('Depth range (ticks from the touch)', 10, {
    min: 1,
    max: 1000,
    help: 'Levels farther than this from the best bid / ask are ignored.',
  });

export const DepthOnChart = defineIndicator({
  id: 'dom-depth',
  name: 'Depth of Market (on chart)',
  short: 'DOM Depth',
  ...ob,
  pane: 'new',
  zeroLine: true,
  description:
    'Resting bid size (up) and ask size (down, mirrored) within N ticks of the touch, sampled over each bar (average) from the order-book history.',
  formula:
    "Bid = mean over the bar's depth snapshots of Σ resting bids within N ticks; Ask likewise (shown negative)",
  inputs: { ticks: ticksIn() },
  outputs: {
    bid: output.histogram('Bid depth', HT.up, { unit: 'volume', opacity: 0.7 }),
    ask: output.histogram('Ask depth', HT.down, { unit: 'volume', opacity: 0.7 }),
  },
  title: (p) => `DOM Depth ±${p.ticks}t`,
  calc(ctx) {
    const cols = ctx.depth ? barColumns(ctx.depth.columns, ctx.bars, ctx.i) : [];
    if (!ctx.depth || ctx.depth.columns.length === 0) {
      ctx.notice(NO_FEED_NOTICE);
      return;
    }
    if (cols.length === 0) return;
    let b = 0;
    let a = 0;
    for (const c of cols) {
      const [x, y] = depthWithin(c, ctx.inputs.ticks);
      b += x;
      a += y;
    }
    ctx.out.bid.set(ctx.i, b / cols.length);
    ctx.out.ask.set(ctx.i, -a / cols.length, 1);
  },
});

export const DOMPower = defineIndicator({
  id: 'dom-power',
  name: 'DOM Power',
  short: 'DOM Power',
  ...ob,
  pane: 'new',
  range: [-1, 1],
  zeroLine: true,
  description:
    'Bid versus ask depth within N ticks of the touch as an imbalance from −1 (all asks) to +1 (all bids), averaged over the bar.',
  formula:
    "Power = (Bid − Ask)/(Bid + Ask) of the resting size within N ticks, mean over the bar's snapshots",
  inputs: { ticks: ticksIn(), smooth: input.int('Smoothing (bars)', 1, { min: 1, max: 200 }) },
  outputs: {
    power: output.histogram('Power', HT.up, { color2: HT.down, opacity: 0.8 }),
    avg: output.line('Average', HT.white, { width: 1, legend: false }),
  },
  title: (p) => `DOM Power ±${p.ticks}t`,
  calc(ctx) {
    if (!ctx.depth || ctx.depth.columns.length === 0) {
      ctx.notice(NO_FEED_NOTICE);
      return;
    }
    const cols = barColumns(ctx.depth.columns, ctx.bars, ctx.i);
    if (cols.length === 0) return;
    let r = 0;
    let n = 0;
    for (const c of cols) {
      const [b, a] = depthWithin(c, ctx.inputs.ticks);
      if (b + a > 0) {
        r += (b - a) / (b + a);
        n++;
      }
    }
    if (n === 0) return;
    const v = r / n;
    ctx.out.power.set(ctx.i, v, v >= 0 ? 0 : 1);
    if (ctx.inputs.smooth > 1) {
      const raw = ctx.buf('raw');
      raw[ctx.i] = v;
      ctx.out.avg.set(ctx.i, sma(raw, ctx.i, ctx.inputs.smooth));
    }
  },
});

export const DOMLevels = defineIndicator({
  id: 'dom-levels',
  name: 'DOM Levels',
  short: 'DOM Levels',
  ...ob,
  pane: 'overlay',
  autoscale: false,
  description:
    'Big resting orders from the order-book history drawn as lines (green bids, red asks) at the bars where they were displayed.',
  formula:
    'Level shown when its resting size ≥ the minimum size and ≥ k × the mean level size of that snapshot',
  inputs: {
    ticks: ticksIn(),
    min: input.float('Minimum size', 0, { min: 0, max: 1e12, step: 1 }),
    k: input.float('× mean level size', 5, { min: 1, max: 100, step: 0.5 }),
    cap: input.int('Max levels per bar', 6, { min: 1, max: 50 }),
  },
  outputs: { levels: output.levels('Resting orders', HT.up, { color2: HT.down, width: 2 }) },
  title: (p) => `DOM Levels ≥${p.k}×`,
  calc(ctx) {
    if (!ctx.depth || ctx.depth.columns.length === 0) {
      ctx.notice(NO_FEED_NOTICE);
      return;
    }
    const cols = barColumns(ctx.depth.columns, ctx.bars, ctx.i);
    const c = cols[cols.length - 1];
    if (!c) return;
    const { ticks, min, k, cap } = ctx.inputs;
    let sum = 0;
    let n = 0;
    for (let x = 0; x < c.pxs.length; x++) {
      sum += c.qtys[x]!;
      n++;
    }
    const mean = n ? sum / n : 0;
    const found: { px: number; q: number; bid: boolean }[] = [];
    for (let x = 0; x < c.pxs.length; x++) {
      const px = c.pxs[x]!;
      const q = c.qtys[x]!;
      const bid = px <= c.bestBid;
      const dist = bid ? c.bestBid - px : px - c.bestAsk;
      if (dist > ticks || q < min || q < k * mean) continue;
      found.push({ px, q, bid });
    }
    found.sort((a, b) => b.q - a.q);
    for (const f of found.slice(0, cap))
      ctx.out.levels.add({
        bar: ctx.i,
        to: ctx.i,
        value: f.px,
        label: formatCompact(f.q),
        tone: f.bid ? 0 : 1,
      } satisfies Level);
  },
});

export const IcebergTracker = defineIndicator({
  id: 'iceberg-tracker',
  name: 'Iceberg Tracker',
  short: 'Icebergs',
  ...ob,
  pane: 'overlay',
  autoscale: false,
  description:
    'Prices where much more volume traded than the order book ever displayed there during the bar: a hidden order that kept refilling.',
  formula:
    'Bid iceberg at p: sell-aggressor volume(p) ≥ ratio × max displayed bid size(p) and ≥ min volume; ask iceberg likewise with buy-aggressor volume',
  inputs: {
    ratio: input.float('Traded ÷ displayed', 3, { min: 1, max: 100, step: 0.5 }),
    min: input.float('Minimum traded volume', 10, { min: 0, max: 1e12, step: 1 }),
    cap: input.int('Max marks per bar', 4, { min: 1, max: 50 }),
  },
  outputs: { hits: output.markers('Icebergs', HT.up, { color2: HT.down }) },
  title: (p) => `Icebergs ≥${p.ratio}×`,
  calc(ctx) {
    if (!ctx.depth || ctx.depth.columns.length === 0) {
      ctx.notice(NO_FEED_NOTICE);
      return;
    }
    const cols = barColumns(ctx.depth.columns, ctx.bars, ctx.i);
    if (cols.length === 0) return;
    const bidSize = new Map<number, number>();
    const askSize = new Map<number, number>();
    for (const c of cols)
      for (let x = 0; x < c.pxs.length; x++) {
        const px = c.pxs[x]!;
        const m = px <= c.bestBid ? bidSize : askSize;
        m.set(px, Math.max(m.get(px) ?? 0, c.qtys[x]!));
      }
    const found: { px: number; q: number; bid: boolean; shown: number }[] = [];
    for (const [px, cl] of ctx.bar.clusters) {
      const bs = bidSize.get(px);
      const as = askSize.get(px);
      if (bs !== undefined && cl.bid >= ctx.inputs.min && cl.bid >= ctx.inputs.ratio * bs)
        found.push({ px, q: cl.bid, bid: true, shown: bs });
      if (as !== undefined && cl.ask >= ctx.inputs.min && cl.ask >= ctx.inputs.ratio * as)
        found.push({ px, q: cl.ask, bid: false, shown: as });
    }
    found.sort((a, b) => b.q - a.q);
    for (const f of found.slice(0, ctx.inputs.cap))
      ctx.out.hits.add({
        bar: ctx.i,
        value: f.px,
        shape: 'diamond',
        size: 5,
        tone: f.bid ? 0 : 1,
        text: `${formatCompact(f.q)}/${formatCompact(f.shown)}`,
        textPos: 'right',
      } satisfies Marker);
  },
});

export const StopRunsTracker = defineIndicator({
  id: 'stop-runs',
  name: 'Stop Runs Tracker',
  short: 'Stop Runs',
  ...ob,
  pane: 'overlay',
  autoscale: false,
  description:
    'Fast pushes through the recent high / low that are immediately rejected: the bar breaks the n-bar extreme with a burst of tape activity and closes back inside.',
  formula: 'Up run: H > HH(n)₋₁ + x, C < HH(n)₋₁ and trades/s ≥ k·SMA(trades/s); down run mirrored',
  inputs: {
    n: input.int('Extreme bars', 20, { min: 2, max: 500 }),
    minTicks: input.int('Break by at least (ticks)', 1, { min: 0, max: 10000 }),
    speed: input.float('Tape speed ×', 1.5, {
      min: 0,
      max: 50,
      step: 0.1,
      help: 'Bar trades/second relative to its average; 0 = ignore speed.',
    }),
    period: input.int('Speed average bars', 20, { min: 2, max: 500 }),
  },
  outputs: { runs: output.markers('Stop runs', HT.up, { color2: HT.down }) },
  title: (p) => `Stop Runs ${p.n}`,
  calc(ctx) {
    const { n, minTicks, speed, period } = ctx.inputs;
    const { i, bar: b } = ctx;
    const rate = ctx.buf('rate');
    rate[i] = b.trades / Math.max(1, (b.tEnd - b.t) / 1000);
    if (i < n) return;
    const avg = sma(rate, i - 1, period);
    if (speed > 0 && !(avg > 0 && rate[i]! >= speed * avg)) return;
    const hh = highest(ctx.src('high'), i - 1, n);
    const ll = lowest(ctx.src('low'), i - 1, n);
    if (b.h >= hh + minTicks && b.c < hh)
      ctx.out.runs.add({
        bar: i,
        value: b.h,
        shape: 'triangleDown',
        size: 5,
        tone: 1,
        text: 'run',
        textPos: 'above',
      } satisfies Marker);
    else if (b.l <= ll - minTicks && b.c > ll)
      ctx.out.runs.add({
        bar: i,
        value: b.l,
        shape: 'triangleUp',
        size: 5,
        tone: 0,
        text: 'run',
        textPos: 'below',
      } satisfies Marker);
  },
});

export const SweepsTracker = defineIndicator({
  id: 'sweeps-tracker',
  name: 'Sweeps Tracker',
  short: 'Sweeps',
  ...ob,
  pane: 'overlay',
  autoscale: false,
  needsTrades: true,
  description:
    'One aggressive order clearing several price levels: consecutive same-side prints within a short window that span at least N distinct ticks.',
  formula:
    'Sweep: same-side prints with gaps ≤ window covering ≥ N ticks; marker at the final price, label = levels × volume',
  inputs: {
    levels: input.int('Minimum levels', 3, { min: 2, max: 1000 }),
    window: input.int('Max gap between prints', 20, { min: 0, max: 5000, unit: 'ms' }),
    minVol: input.float('Minimum volume', 0, { min: 0, max: 1e12, step: 1 }),
  },
  outputs: { sweeps: output.markers('Sweeps', HT.up, { color2: HT.down }) },
  title: (p) => `Sweeps ≥${p.levels} levels`,
  calc(ctx) {
    const { levels, window, minVol } = ctx.inputs;
    const tr = ctx.trades(ctx.i);
    let k = 0;
    while (k < tr.length) {
      const t0 = tr[k]!;
      if (t0.side === 'unknown') {
        k++;
        continue;
      }
      let j = k + 1;
      let vol = t0.qty;
      let lo = t0.px;
      let hi = t0.px;
      while (j < tr.length && tr[j]!.side === t0.side && tr[j]!.ts - tr[j - 1]!.ts <= window) {
        vol += tr[j]!.qty;
        lo = Math.min(lo, tr[j]!.px);
        hi = Math.max(hi, tr[j]!.px);
        j++;
      }
      const span = hi - lo + 1;
      if (span >= levels && vol >= minVol)
        ctx.out.sweeps.add({
          bar: ctx.i,
          value: tr[j - 1]!.px,
          shape: t0.side === 'buy' ? 'triangleUp' : 'triangleDown',
          size: 5,
          tone: t0.side === 'buy' ? 0 : 1,
          text: `${span}×${formatCompact(vol)}`,
          textPos: t0.side === 'buy' ? 'above' : 'below',
        } satisfies Marker);
      k = j;
    }
  },
});
