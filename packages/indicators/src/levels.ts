import {
  HT,
  defineIndicator,
  input,
  output,
  periodStart,
  type CalcContext,
  type InputDefs,
  type OutputDefs,
} from '@htflow/indicator-sdk';

/** Fills prevO/prevH/prevL/prevC buffers with the previous period's OHLC at bar i. */
function prevPeriod(
  ctx: CalcContext<InputDefs, OutputDefs, unknown>,
  tf: 'D' | 'W' | 'MN',
): { o: number; h: number; l: number; c: number } {
  const { i, bar } = ctx;
  const co = ctx.buf('co');
  const ch = ctx.buf('ch');
  const cl = ctx.buf('cl');
  const po = ctx.buf('po');
  const ph = ctx.buf('ph');
  const pl = ctx.buf('pl');
  const pc = ctx.buf('pc');
  const fresh = i === 0 || periodStart(ctx.bars[i - 1]!.t, tf) !== periodStart(bar.t, tf);
  if (fresh) {
    co[i] = bar.o;
    ch[i] = bar.h;
    cl[i] = bar.l;
    if (i > 0) {
      po[i] = co[i - 1]!;
      ph[i] = ch[i - 1]!;
      pl[i] = cl[i - 1]!;
      pc[i] = ctx.bars[i - 1]!.c;
    }
  } else {
    co[i] = co[i - 1]!;
    ch[i] = Math.max(ch[i - 1]!, bar.h);
    cl[i] = Math.min(cl[i - 1]!, bar.l);
    po[i] = po[i - 1]!;
    ph[i] = ph[i - 1]!;
    pl[i] = pl[i - 1]!;
    pc[i] = pc[i - 1]!;
  }
  return { o: po[i]!, h: ph[i]!, l: pl[i]!, c: pc[i]! };
}

const PERIODS = ['D', 'W', 'MN'] as const;

export const PivotPoints = defineIndicator({
  id: 'pivot-points',
  name: 'Pivot Points',
  short: 'Pivots',
  category: 'technical',
  group: 'Levels & structure',
  pane: 'overlay',
  autoscale: false,
  description: 'Support / resistance levels from the previous period high, low and close.',
  formula:
    'Classic: P=(H+L+C)/3, R1=2P−L, S1=2P−H, R2=P+(H−L), S2=P−(H−L), R3=H+2(P−L), S3=L−2(H−P). Fibonacci: P±0.382/0.618/1.0·(H−L). Camarilla: C±(H−L)·1.1/12, /6, /4. Woodie: P=(H+L+2C)/4. DeMark: X = H+2L+C (C<O), 2H+L+C (C>O), H+L+2C (C=O); P=X/4, R1=X/2−L, S1=X/2−H.',
  inputs: {
    type: input.enum('Type', 'classic', [
      ['classic', 'Classic'],
      ['fibonacci', 'Fibonacci'],
      ['camarilla', 'Camarilla'],
      ['woodie', 'Woodie'],
      ['demark', 'DeMark'],
    ]),
    period: input.timeframe('Period', 'D', { options: PERIODS }),
  },
  outputs: {
    r3: output.step('R3', HT.down, { unit: 'price', width: 1, opacity: 0.8 }),
    r2: output.step('R2', HT.down, { unit: 'price', width: 1, opacity: 0.8 }),
    r1: output.step('R1', HT.down, { unit: 'price', width: 1 }),
    p: output.step('P', HT.soft, { unit: 'price', width: 1 }),
    s1: output.step('S1', HT.up, { unit: 'price', width: 1 }),
    s2: output.step('S2', HT.up, { unit: 'price', width: 1, opacity: 0.8 }),
    s3: output.step('S3', HT.up, { unit: 'price', width: 1, opacity: 0.8 }),
  },
  title: (p) => `Pivots ${p.type} ${p.period}`,
  calc(ctx) {
    const {
      o: po,
      h,
      l,
      c,
    } = prevPeriod(
      ctx as unknown as CalcContext<InputDefs, OutputDefs, unknown>,
      ctx.inputs.period as 'D',
    );
    if (Number.isNaN(h)) return;
    const r = h - l;
    let v: number[];
    switch (ctx.inputs.type) {
      case 'fibonacci': {
        const p = (h + l + c) / 3;
        v = [p + r, p + 0.618 * r, p + 0.382 * r, p, p - 0.382 * r, p - 0.618 * r, p - r];
        break;
      }
      case 'demark': {
        const x = c < po ? h + 2 * l + c : c > po ? 2 * h + l + c : h + l + 2 * c;
        v = [NaN, NaN, x / 2 - l, x / 4, x / 2 - h, NaN, NaN];
        break;
      }
      case 'camarilla':
        v = [
          c + (r * 1.1) / 4,
          c + (r * 1.1) / 6,
          c + (r * 1.1) / 12,
          (h + l + c) / 3,
          c - (r * 1.1) / 12,
          c - (r * 1.1) / 6,
          c - (r * 1.1) / 4,
        ];
        break;
      case 'woodie': {
        const p = (h + l + 2 * c) / 4;
        v = [h + 2 * (p - l), p + r, 2 * p - l, p, 2 * p - h, p - r, l - 2 * (h - p)];
        break;
      }
      default: {
        const p = (h + l + c) / 3;
        v = [h + 2 * (p - l), p + r, 2 * p - l, p, 2 * p - h, p - r, l - 2 * (h - p)];
      }
    }
    const o = ctx.out;
    [o.r3, o.r2, o.r1, o.p, o.s1, o.s2, o.s3].forEach((s, k) => s.set(ctx.i, v[k]!));
  },
});

export const PrevSessionOHLC = defineIndicator({
  id: 'prev-session-ohlc',
  name: 'Previous Session OHLC',
  short: 'Prev OHLC',
  category: 'technical',
  group: 'Levels & structure',
  pane: 'overlay',
  autoscale: false,
  description: 'Open, high, low and close of the previous session / week / month as levels.',
  formula: 'Levels = O, H, L, C of the previous period',
  inputs: { period: input.timeframe('Period', 'D', { options: PERIODS }) },
  outputs: {
    h: output.step('PH', HT.down, { unit: 'price', width: 1, style: 'dashed' }),
    o: output.step('PO', HT.grey, { unit: 'price', width: 1, style: 'dashed' }),
    c: output.step('PC', HT.soft, { unit: 'price', width: 1, style: 'dashed' }),
    l: output.step('PL', HT.up, { unit: 'price', width: 1, style: 'dashed' }),
  },
  title: (p) => `Prev ${p.period} OHLC`,
  calc(ctx) {
    const v = prevPeriod(
      ctx as unknown as CalcContext<InputDefs, OutputDefs, unknown>,
      ctx.inputs.period as 'D',
    );
    ctx.out.o.set(ctx.i, v.o);
    ctx.out.h.set(ctx.i, v.h);
    ctx.out.l.set(ctx.i, v.l);
    ctx.out.c.set(ctx.i, v.c);
  },
});
