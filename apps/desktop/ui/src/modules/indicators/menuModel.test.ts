import { describe, expect, it } from 'vitest';
import type { IndicatorConfig } from '@htflow/indicator-sdk';
import { canMovePane, indicatorsInPane, moveIndicator } from './menuModel';

const ind = (uid: string, pane: string): IndicatorConfig =>
  ({
    uid,
    type: 'x',
    enabled: true,
    inputs: {},
    styles: {},
    visibility: [],
    pane,
    scale: 'own',
    z: 'top',
    height: 100,
  }) as IndicatorConfig;

const items = [ind('ema', 'overlay'), ind('rsi', 'new'), ind('rsi2', 'rsi'), ind('cvd', 'new')];

describe('indicator context menu model', () => {
  it('lists the indicators of a sub-pane', () => {
    expect(indicatorsInPane(items, 'ind-pane:rsi')).toEqual(['rsi', 'rsi2']);
    expect(indicatorsInPane(items, 'volume-pane')).toEqual([]);
  });

  it('moves to the price pane / a new pane; joiners get their own pane', () => {
    const out = moveIndicator(items, 'rsi', 'overlay');
    expect(out.find((c) => c.uid === 'rsi')!.pane).toBe('overlay');
    expect(out.find((c) => c.uid === 'rsi2')!.pane).toBe('new');
    expect(moveIndicator(items, 'ema', 'new').find((c) => c.uid === 'ema')!.pane).toBe('new');
  });

  it('swaps pane groups up / down', () => {
    expect(canMovePane(items, 'rsi', 'up')).toBe(false);
    expect(canMovePane(items, 'rsi2', 'down')).toBe(true);
    expect(canMovePane(items, 'ema', 'down')).toBe(false);
    const out = moveIndicator(items, 'cvd', 'up');
    expect(out.map((c) => c.uid)).toEqual(['ema', 'cvd', 'rsi', 'rsi2']);
    expect(moveIndicator(out, 'rsi2', 'up').map((c) => c.uid)).toEqual([
      'ema',
      'rsi',
      'rsi2',
      'cvd',
    ]);
    expect(moveIndicator(items, 'rsi', 'up')).toEqual(items);
  });
});
