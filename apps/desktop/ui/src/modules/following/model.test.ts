import { describe, expect, it } from 'vitest';
import {
  addFollowed,
  allTags,
  filterFollowed,
  normalizeHandle,
  parseTags,
  readFollowed,
  sampleIdeas,
  validateHandle,
} from './model';

describe('handles', () => {
  it('strips @ and validates', () => {
    expect(normalizeHandle('  @@flowking ')).toBe('flowking');
    expect(validateHandle('', [])).toBeTruthy();
    expect(validateHandle('ab', [])).toBeTruthy();
    expect(validateHandle('bad handle', [])).toBeTruthy();
    expect(validateHandle('@good_one', [])).toBeNull();
  });
  it('rejects duplicates case-insensitively', () => {
    const l = addFollowed([], 'Alpha', '', []);
    expect(validateHandle('@alpha', l)).toBe('Already in your list');
    expect(() => addFollowed(l, 'ALPHA', '', [])).toThrow();
  });
});

describe('tags / filtering', () => {
  it('parses unique tags, trims, caps', () => {
    expect(parseTags('scalper, ES ; #es,  ,')).toEqual(['scalper', 'ES']);
    expect(parseTags(Array.from({ length: 20 }, (_, i) => `t${i}`).join(','))).toHaveLength(8);
  });
  it('filters by text and tag; lists tags', () => {
    let l = addFollowed([], 'alpha_one', 'tape reader', ['ES'], 1);
    l = addFollowed(l, 'beta_two', 'swing', ['CL', 'es'], 2);
    expect(filterFollowed(l, 'tape', '').map((f) => f.handle)).toEqual(['alpha_one']);
    expect(filterFollowed(l, '', 'es')).toHaveLength(2);
    expect(filterFollowed(l, '', 'CL')).toHaveLength(1);
    expect(allTags(l)).toEqual(['CL', 'ES']);
  });
});

describe('persistence + sample feed', () => {
  it('readFollowed drops invalid and duplicate rows', () => {
    const r = readFollowed([
      { id: 'a', handle: 'valid_one', tags: ['x'] },
      { id: 'b', handle: 'VALID_ONE' },
      { id: 'c', handle: 'no' },
      null,
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]!.tags).toEqual(['x']);
  });
  it('sample ideas are deterministic and skip muted traders', () => {
    const l = addFollowed(addFollowed([], 'alpha_one', '', [], 1), 'beta_two', '', [], 2);
    expect(sampleIdeas(l)).toEqual(sampleIdeas(l));
    expect(sampleIdeas(l)).toHaveLength(4);
    const muted = l.map((f) => (f.handle === 'beta_two' ? { ...f, muted: true } : f));
    expect(sampleIdeas(muted).every((i) => i.handle === 'alpha_one')).toBe(true);
  });
});
