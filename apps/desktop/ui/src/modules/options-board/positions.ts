import { create } from 'zustand';
import type { Leg, PricingModel } from '@htflow/options';
import { backend } from '../../backend';

/**
 * Legacy local options strategies saved before the paper engine modelled options (P18). New
 * orders go to the paper engine; these stay listed (read-only, removable) so nothing is lost.
 */
export interface OptionsPosition {
  id: string;
  createdAt: number;
  account: string;
  underlying: string;
  root: string;
  model: PricingModel;
  r: number;
  q: number;
  multiplier: number;
  simulated: boolean;
  legs: Leg[];
  /** Net premium at entry: + credit, − debit. */
  entryNet: number;
}

const KEY = 'options.positions';

interface PositionsState {
  loaded: boolean;
  positions: OptionsPosition[];
  load(): Promise<void>;
  add(p: OptionsPosition): void;
  remove(id: string): void;
}

const isPosition = (x: unknown): x is OptionsPosition =>
  !!x &&
  typeof x === 'object' &&
  typeof (x as OptionsPosition).id === 'string' &&
  Array.isArray((x as OptionsPosition).legs);

export const useOptionsPositions = create<PositionsState>((set, get) => ({
  loaded: false,
  positions: [],
  async load() {
    if (get().loaded) return;
    try {
      const saved = await backend.loadSettings<unknown>(KEY);
      set({ loaded: true, positions: Array.isArray(saved) ? saved.filter(isPosition) : [] });
    } catch {
      set({ loaded: true });
    }
  },
  add(p) {
    const positions = [...get().positions, p];
    set({ positions });
    void backend.saveSettings(KEY, positions);
  },
  remove(id) {
    const positions = get().positions.filter((p) => p.id !== id);
    set({ positions });
    void backend.saveSettings(KEY, positions);
  },
}));
