import { describe, expect, it } from 'vitest';
import { passwordStrength } from './strength';

describe('passwordStrength', () => {
  it('requires 10 characters', () => {
    expect(passwordStrength('Abc12!').score).toBeLessThanOrEqual(1);
  });
  it('rewards length and variety', () => {
    expect(passwordStrength('abcdefghij').score).toBe(1);
    expect(passwordStrength('Abcdefgh12').score).toBe(3);
    expect(passwordStrength('Abcdefgh12!xyzQ').score).toBe(4);
  });
});
