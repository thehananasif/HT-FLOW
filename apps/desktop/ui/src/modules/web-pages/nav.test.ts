import { describe, expect, it } from 'vitest';
import {
  back,
  canBack,
  canForward,
  forward,
  navigate,
  newTab,
  normalizeUrl,
  readBookmarks,
  readTabs,
  tabTitle,
  toggleBookmark,
} from './nav';

describe('normalizeUrl', () => {
  it('adds https to bare hosts', () => {
    expect(normalizeUrl('example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(normalizeUrl('  www.example.org ')).toBe('https://www.example.org/');
  });
  it('keeps http(s) and defaults localhost to http', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com/');
    expect(normalizeUrl('localhost:3000/x')).toBe('http://localhost:3000/x');
  });
  it('rejects other schemes, spaces, and non-hosts', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('data:text/html,hi')).toBeNull();
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('two words')).toBeNull();
    expect(normalizeUrl('justaword')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });
});

describe('tab history', () => {
  it('navigates, goes back and forward, drops forward history on new navigation', () => {
    let t = newTab('a');
    expect(canBack(t)).toBe(false);
    t = navigate(t, 'https://a.com/');
    t = navigate(t, 'https://b.com/');
    t = navigate(t, 'https://c.com/');
    expect(t.idx).toBe(2);
    t = back(back(t));
    expect(t.history[t.idx]).toBe('https://a.com/');
    expect(canForward(t)).toBe(true);
    t = forward(t);
    expect(t.history[t.idx]).toBe('https://b.com/');
    t = navigate(t, 'https://d.com/');
    expect(t.history).toEqual(['https://a.com/', 'https://b.com/', 'https://d.com/']);
    expect(canForward(t)).toBe(false);
  });
  it('same URL is a no-op; back/forward clamp', () => {
    let t = navigate(newTab('a'), 'https://a.com/');
    expect(navigate(t, 'https://a.com/')).toBe(t);
    expect(back(t)).toBe(t);
    expect(forward(t)).toBe(t);
    t = navigate(t, 'https://b.com/');
    expect(tabTitle(t)).toBe('b.com');
    expect(tabTitle(newTab('x'))).toBe('New tab');
  });
});

describe('persistence validation', () => {
  it('readTabs falls back to one blank tab and drops bad entries', () => {
    expect(readTabs(undefined)).toHaveLength(1);
    const tabs = readTabs([
      { id: 'a', history: ['https://a.com/', 'javascript:x', 5], idx: 9 },
      { nope: true },
    ]);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toEqual({ id: 'a', history: ['https://a.com/'], idx: 0 });
  });
  it('readBookmarks filters invalid and toggleBookmark adds / removes', () => {
    expect(
      readBookmarks([
        { title: 'x', url: 'file:///a' },
        { title: 'ok', url: 'https://a.com/' },
      ]),
    ).toEqual([{ title: 'ok', url: 'https://a.com/' }]);
    let b = toggleBookmark([], 'https://a.com/', '');
    expect(b).toEqual([{ url: 'https://a.com/', title: 'https://a.com/' }]);
    b = toggleBookmark(b, 'https://a.com/', '');
    expect(b).toEqual([]);
  });
});
