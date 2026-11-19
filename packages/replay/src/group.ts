import type { BarSpec } from '@htflow/market-data';
import type { ReplayEngine } from './engine';

/**
 * Several instruments replayed on one clock (P24 "multi-chart synchronized replay"). With `sync`
 * on, every control applies to all engines; stepping one instrument advances the others to the
 * same replay time. With it off, a control only affects the engine it is given.
 */
export class ReplayGroup {
  sync = true;

  constructor(readonly engines: ReplayEngine[]) {
    if (!engines.length) throw new Error('A replay group needs at least one engine');
  }

  get primary(): ReplayEngine {
    return this.engines[0]!;
  }

  private targets(e?: ReplayEngine): ReplayEngine[] {
    return this.sync || !e ? this.engines : [e];
  }

  play(e?: ReplayEngine): void {
    for (const x of this.targets(e)) x.play();
  }

  pause(e?: ReplayEngine): void {
    for (const x of this.targets(e)) x.pause();
  }

  toggle(e?: ReplayEngine): void {
    if ((e ?? this.primary).playing) this.pause(e);
    else this.play(e);
  }

  setSpeed(x: number, e?: ReplayEngine): void {
    for (const t of this.targets(e)) t.setSpeed(x);
  }

  seek(t: number, e?: ReplayEngine): void {
    for (const x of this.targets(e)) x.seek(t);
  }

  setLoop(range: { from: number; to: number } | null, e?: ReplayEngine): void {
    for (const x of this.targets(e)) x.setLoop(range);
  }

  addBookmark(t: number, label?: string, e?: ReplayEngine): void {
    for (const x of this.targets(e)) x.addBookmark(t, label);
  }

  removeBookmarkAt(t: number, e?: ReplayEngine): void {
    for (const x of this.targets(e))
      for (const b of x.bookmarks.filter((b) => b.t === t)) x.removeBookmark(b.id);
  }

  stepTick(e: ReplayEngine = this.primary): void {
    e.stepTick();
    this.follow(e);
  }

  stepBar(spec: BarSpec, e: ReplayEngine = this.primary): void {
    e.stepBar(spec);
    this.follow(e);
  }

  stepBackBar(spec: BarSpec, e: ReplayEngine = this.primary): void {
    e.stepBackBar(spec);
    if (this.sync) for (const x of this.engines) if (x !== e) x.seek(e.time);
  }

  /** Scheduler tick: every engine advances by the same wall time. */
  tick(wallDtMs: number): void {
    for (const e of this.engines) e.tick(wallDtMs);
  }

  inSync(): boolean {
    return this.engines.every((e) => e.time === this.primary.time);
  }

  private follow(e: ReplayEngine): void {
    if (!this.sync) return;
    for (const x of this.engines) if (x !== e && x.time < e.time) x.advanceTo(e.time);
  }
}

/**
 * Drives a group (or engine) from a wall clock; ~60 ticks per second by default.
 *
 * Load shedding: when one tick costs more than `budgetMs` of wall time (1000x on a busy chart),
 * the next ticks are skipped for the same amount of time, so the UI thread keeps painting and
 * input stays responsive; the replay clock then runs a little slower than nominal instead of the
 * window freezing. Skipped time is not lost: the engine caps the catch-up of the next tick.
 */
export class ReplayScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private resumeAt = 0;
  /** Wall time of the last tick (ms) and number of ticks skipped to give the UI time. */
  lastCostMs = 0;
  skipped = 0;

  constructor(
    private target: { tick(wallDtMs: number): void },
    private frameMs = 16,
    private clock: () => number = () => performance.now(),
    private budgetMs = 40,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.last = this.clock();
    this.resumeAt = 0;
    this.timer = setInterval(() => this.frame(), this.frameMs);
  }

  /** One scheduler step (public for tests). */
  frame(): void {
    const now = this.clock();
    if (now < this.resumeAt) {
      this.skipped++;
      return;
    }
    const dt = now - this.last;
    this.last = now;
    this.target.tick(dt);
    const cost = this.clock() - now;
    this.lastCostMs = cost;
    if (cost > this.budgetMs) this.resumeAt = this.clock() + cost;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
