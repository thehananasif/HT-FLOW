import { describe, expect, it } from 'vitest';
import { nicePriceStep, niceTimeStep } from './scale';

describe('scales', () => {
  it('picks integer tick steps that keep labels apart', () => {
    expect(nicePriceStep(20, 30)).toBe(2);
    expect(nicePriceStep(1, 30)).toBe(50);
    expect(nicePriceStep(0.01, 40)).toBe(5000);
  });
  it('picks a time step', () => {
    expect(niceTimeStep(1000, 60)).toBe(60_000);
    expect(niceTimeStep(60_000, 80)).toBe(7_200_000);
  });
});
