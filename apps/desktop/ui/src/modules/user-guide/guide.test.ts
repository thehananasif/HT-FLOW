import { describe, expect, it } from 'vitest';
import { MODULES } from '../../shell/modules';
import { ARTICLES, SHORTCUTS } from './content';
import { parseInline, parseMarkdown } from './markdown';
import { searchArticles, sections } from './search';

describe('markdown', () => {
  it('parses inline code and bold', () => {
    expect(parseInline('a `b` **c** d')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'code', v: 'b' },
      { t: 'text', v: ' ' },
      { t: 'bold', v: 'c' },
      { t: 'text', v: ' d' },
    ]);
  });
  it('parses headings, lists, paragraphs and tables', () => {
    const b = parseMarkdown(
      'Intro line\ncontinues\n\n## Head\n\n- a\n- b\n\n1. x\n2. y\n\n| K | V |\n| --- | --- |\n| `a` | b |',
    );
    expect(b.map((x) => x.t)).toEqual(['p', 'h', 'ul', 'ol', 'table']);
    const t = b[4]!;
    expect(t.t === 'table' && t.rows).toEqual([['`a`', 'b']]);
    const p = b[0]!;
    expect(p.t === 'p' && p.inl[0]).toEqual({ t: 'text', v: 'Intro line continues' });
  });
});

describe('guide content', () => {
  it('has unique ids, non-empty bodies and valid "open" targets', () => {
    const ids = ARTICLES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const known = new Set(MODULES.map((m) => m.id));
    for (const a of ARTICLES) {
      expect(a.body.trim().length).toBeGreaterThan(20);
      for (const o of a.opens ?? []) expect(known.has(o), `${a.id} → ${o}`).toBe(true);
    }
  });
  it('covers the P28 modules and the shortcut table', () => {
    for (const id of ['web-pages', 'logs', 'shortcuts', 'replay', 'tour'])
      expect(ARTICLES.some((a) => a.id === id)).toBe(true);
    expect(SHORTCUTS.some((s) => s.keys === 'Ctrl+K')).toBe(true);
    expect(ARTICLES.find((a) => a.id === 'shortcuts')!.body).toContain('Command palette');
  });
});

describe('search', () => {
  it('returns everything for an empty query', () => {
    expect(searchArticles(ARTICLES, '')).toHaveLength(ARTICLES.length);
  });
  it('ranks title matches first and requires all terms', () => {
    const hits = searchArticles(ARTICLES, 'replay');
    expect(hits[0]!.article.id).toBe('replay');
    expect(searchArticles(ARTICLES, 'replay zzzznotaword')).toHaveLength(0);
  });
  it('finds body text and gives a snippet', () => {
    const hits = searchArticles(ARTICLES, 'recovery code');
    expect(hits.some((h) => h.article.id === 'welcome')).toBe(true);
    expect(hits[0]!.snippet.length).toBeGreaterThan(0);
  });
  it('groups into sections preserving order', () => {
    const s = sections(ARTICLES);
    expect(s[0]!.name).toBe('Getting started');
    expect(s.flatMap((x) => x.items)).toHaveLength(ARTICLES.length);
  });
});
