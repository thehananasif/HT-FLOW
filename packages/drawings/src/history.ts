import type { Drawing } from './types';

/** Undo/redo stack of drawing-list snapshots (drawings are treated as immutable values). */
export class History {
  private past: Drawing[][] = [];
  private future: Drawing[][] = [];

  constructor(readonly limit = 100) {}

  /** Records the state before a change. */
  push(before: Drawing[]): void {
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  /** Returns the state to restore, or null when there is nothing to undo. */
  undo(current: Drawing[]): Drawing[] | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(current);
    return prev;
  }

  redo(current: Drawing[]): Drawing[] | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
