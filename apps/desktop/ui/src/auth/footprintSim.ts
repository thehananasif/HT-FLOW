/**
 * Synthetic footprint data for the animated login background. Original, seeded, no market data:
 * a random walk prints trades into price levels; each level keeps the volume traded at the bid
 * (sells) and at the ask (buys), like a real footprint candle.
 */

export interface Level {
  bid: number;
  ask: number;
}

export interface SimCandle {
  id: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Tick index -> volume at that price. */
  levels: Map<number, Level>;
  closed: boolean;
}

/** Deterministic PRNG (mulberry32) so the animation is reproducible in tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newCandle(id: number, price: number): SimCandle {
  return {
    id,
    open: price,
    high: price,
    low: price,
    close: price,
    levels: new Map(),
    closed: false,
  };
}

/** Level with the largest total volume (the point of control); null for an empty candle. */
export function pocOf(c: SimCandle): number | null {
  let best: number | null = null;
  let bestVol = -1;
  for (const [tick, l] of c.levels) {
    const v = l.bid + l.ask;
    if (
      v > bestVol ||
      (v === bestVol && best !== null && Math.abs(tick - c.close) < Math.abs(best - c.close))
    ) {
      best = tick;
      bestVol = v;
    }
  }
  return best;
}

export const deltaOf = (l: Level): number => l.ask - l.bid;

export function candleDelta(c: SimCandle): number {
  let d = 0;
  for (const l of c.levels.values()) d += deltaOf(l);
  return d;
}

/** Largest |delta| of any level, used to scale the cell tint. */
export function maxAbsDelta(c: SimCandle): number {
  let m = 1;
  for (const l of c.levels.values()) m = Math.max(m, Math.abs(deltaOf(l)));
  return m;
}

/**
 * Diagonal imbalances: the ask at a price against the bid one tick below it (buyers overwhelm
 * sellers), and the bid against the ask one tick above (sellers overwhelm buyers).
 * Returns keys like `"105:ask"` / `"104:bid"`.
 */
export function imbalances(c: SimCandle, ratio = 3, minVolume = 4): Set<string> {
  const out = new Set<string>();
  for (const [tick, l] of c.levels) {
    const below = c.levels.get(tick - 1);
    if (below && l.ask >= minVolume && l.ask >= ratio * Math.max(1, below.bid))
      out.add(`${tick}:ask`);
    const above = c.levels.get(tick + 1);
    if (above && l.bid >= minVolume && l.bid >= ratio * Math.max(1, above.ask))
      out.add(`${tick}:bid`);
  }
  return out;
}

/** Trade generator: mean-reverting random walk with bursts of one-sided aggression. */
export class SyntheticFlow {
  private rnd: () => number;
  price = 1000;
  private anchor = 1000;
  private bias = 0; // -1..1 current order-flow pressure
  private burst = 0;
  private nextId = 1;
  current: SimCandle;

  constructor(seed = 20260314) {
    this.rnd = rng(seed);
    this.current = newCandle(this.nextId++, this.price);
  }

  private trade(): void {
    const r = this.rnd;
    if (this.burst <= 0 && r() < 0.015) {
      this.burst = 6 + Math.floor(r() * 10);
      this.bias = r() < 0.5 ? -0.85 : 0.85;
    }
    if (this.burst > 0) this.burst--;
    else this.bias *= 0.97;
    this.bias += (r() - 0.5) * 0.12;
    this.bias = Math.max(-1, Math.min(1, this.bias));

    // price follows the pressure, with a slow pull back to the anchor
    const pull = (this.anchor - this.price) * 0.01;
    const u = r();
    const pUp = Math.max(0.03, 0.28 + this.bias * 0.2 + pull);
    const pDown = Math.max(0.03, 0.28 - this.bias * 0.2 - pull);
    this.price += u < pUp ? 1 : u > 1 - pDown ? -1 : 0;
    if (r() < 0.002) this.anchor = this.price + Math.round((r() - 0.5) * 16);

    const buy = r() < 0.5 + this.bias * 0.42;
    const size = Math.max(
      1,
      Math.floor(-Math.log(1 - r()) * 4.5 * (1 + (this.burst > 0 ? 1.6 : 0))),
    );
    const c = this.current;
    let l = c.levels.get(this.price);
    if (!l) c.levels.set(this.price, (l = { bid: 0, ask: 0 }));
    if (buy) l.ask += size;
    else l.bid += size;
    c.high = Math.max(c.high, this.price);
    c.low = Math.min(c.low, this.price);
    c.close = this.price;
  }

  /** Prints `n` trades into the forming candle. */
  prints(n: number): void {
    for (let i = 0; i < n; i++) this.trade();
  }

  /** Closes the forming candle and opens the next one at the same price. */
  roll(): SimCandle {
    const done = this.current;
    done.closed = true;
    this.current = newCandle(this.nextId++, this.price);
    return done;
  }
}
