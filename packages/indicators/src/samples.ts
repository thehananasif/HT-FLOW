import {
  HT,
  RESET_OPTIONS,
  defineIndicator,
  input,
  isNewPeriod,
  output,
  type Marker,
  type ResetMode,
  type Zone,
} from '@htflow/indicator-sdk';

const NaN_ = Number.NaN;
const DAY = 86_400_000;

export const BarNumbering = defineIndicator({
  id: 'bar-numbering',
  name: 'Bar Numbering',
  short: 'Bar #',
  category: 'samples',
  pane: 'overlay',
  autoscale: false,
  description: 'Numbers the bars below their low, restarting at 1 after each reset period.',
  formula: 'n = bars since the reset (1-based); a label is drawn when n is a multiple of "every"',
  inputs: {
    every: input.int('Label every N bars', 1, { min: 1, max: 1000 }),
    reset: input.enum('Restart numbering', 'never', RESET_OPTIONS),
    first: input.int('First number', 1, { min: 0, max: 1_000_000 }),
  },
  outputs: { labels: output.markers('Numbers', HT.grey) },
  title: (p) => `Bar numbering /${p.every}`,
  calc(ctx) {
    const { i, bar } = ctx;
    const n = ctx.buf('n');
    const reset = i === 0 || isNewPeriod(ctx.bars[i - 1]!.t, bar.t, ctx.inputs.reset as ResetMode);
    n[i] = reset ? ctx.inputs.first : n[i - 1]! + 1;
    if (n[i]! % ctx.inputs.every === 0)
      ctx.out.labels.add({
        bar: i,
        value: bar.l,
        shape: 'text',
        size: 0,
        text: String(n[i]),
        tone: 0,
        textPos: 'below',
      } satisfies Marker);
  },
});

export const BarTimer = defineIndicator({
  id: 'bar-timer',
  name: 'Bar Timer',
  short: 'Bar Timer',
  category: 'samples',
  pane: 'overlay',
  autoscale: false,
  description:
    'Time left in the forming bar, shown next to the last bar: bar length minus the time since its open, measured on the exchange clock of the last print.',
  formula:
    'left = length − (t_last print − t_open); length = the input, or the open-to-open distance of the last two bars (0 = auto)',
  inputs: {
    length: input.int('Bar length (seconds)', 0, {
      min: 0,
      max: 604_800,
      help: '0 = auto-detect from the last two bars.',
    }),
  },
  outputs: { label: output.markers('Timer', HT.warning) },
  title: () => 'Bar timer',
  calc(ctx) {
    if (ctx.final) return;
    const { i, bar } = ctx;
    const len =
      ctx.inputs.length > 0 ? ctx.inputs.length * 1000 : i > 0 ? bar.t - ctx.bars[i - 1]!.t : NaN_;
    if (!(len > 0)) return;
    const left = Math.max(0, Math.round((len - (bar.tEnd - bar.t)) / 1000));
    const mm = Math.floor(left / 60);
    const ss = left % 60;
    const text =
      left >= 3600
        ? `${Math.floor(left / 3600)}h ${String(mm % 60).padStart(2, '0')}m`
        : `${mm}:${String(ss).padStart(2, '0')}`;
    ctx.out.label.add({
      bar: i,
      value: bar.c,
      shape: 'text',
      size: 0,
      text,
      tone: 0,
      textPos: 'right',
    } satisfies Marker);
  },
});

const SESSIONS = [
  { key: 'asia', label: 'Asia', start: 0, end: 8 },
  { key: 'london', label: 'London', start: 7, end: 16 },
  { key: 'ny', label: 'New York', start: 13, end: 22 },
] as const;

const hod = (t: number) => (((t % DAY) + DAY) % DAY) / 3_600_000;
const inWindow = (t: number, s: number, e: number) => {
  const h = hod(t);
  return s <= e ? h >= s && h < e : h >= s || h < e;
};

export const SessionVisualizer = defineIndicator({
  id: 'session-visualizer',
  name: 'Trading Session Visualizer',
  short: 'Sessions',
  category: 'trading',
  pane: 'overlay',
  autoscale: false,
  description:
    "Boxes for the Asia, London and New York sessions (and any killzone: just narrow the hours) spanning each session's high and low. Hours are UTC.",
  formula:
    'Box = [session low, session high] from the session start until its end (wraps midnight)',
  inputs: {
    asia: input.bool('Asia', true),
    asiaStart: input.float('Asia start (UTC h)', SESSIONS[0].start, { min: 0, max: 24, step: 0.5 }),
    asiaEnd: input.float('Asia end (UTC h)', SESSIONS[0].end, { min: 0, max: 24, step: 0.5 }),
    london: input.bool('London', true),
    londonStart: input.float('London start (UTC h)', SESSIONS[1].start, {
      min: 0,
      max: 24,
      step: 0.5,
    }),
    londonEnd: input.float('London end (UTC h)', SESSIONS[1].end, { min: 0, max: 24, step: 0.5 }),
    ny: input.bool('New York', true),
    nyStart: input.float('New York start (UTC h)', SESSIONS[2].start, {
      min: 0,
      max: 24,
      step: 0.5,
    }),
    nyEnd: input.float('New York end (UTC h)', SESSIONS[2].end, { min: 0, max: 24, step: 0.5 }),
  },
  outputs: {
    boxes: output.zones('Sessions', HT.info, {
      color2: HT.warning,
      color3: HT.special,
      opacity: 0.12,
    }),
  },
  title: () => 'Sessions',
  calc(ctx) {
    const { i, bar } = ctx;
    const inp = ctx.inputs;
    const cfg = [
      [inp.asia, inp.asiaStart, inp.asiaEnd],
      [inp.london, inp.londonStart, inp.londonEnd],
      [inp.ny, inp.nyStart, inp.nyEnd],
    ] as const;
    cfg.forEach(([on, s, e], tone) => {
      if (!on || s === e || !inWindow(bar.t, s, e)) return;
      // Continue the box of this session when the previous bar was inside it, else start a new one.
      let z: Zone | undefined;
      const items = ctx.out.boxes.items;
      for (let k = items.length - 1; k >= 0 && k >= items.length - 6; k--) {
        const c = items[k]!;
        if (c.tone === tone && c.to >= i - 1) {
          z = c;
          break;
        }
      }
      if (z) {
        z.top = Math.max(z.top, bar.h);
        z.bottom = Math.min(z.bottom, bar.l);
        z.to = i;
      } else
        ctx.out.boxes.add({
          bar: i,
          to: i,
          top: bar.h,
          bottom: bar.l,
          tone,
          label: SESSIONS[tone]!.label,
        } satisfies Zone);
    });
  },
});
