import { describe, expect, it } from 'vitest';
import { MODULES } from '../../shell/modules';
import { ARTICLES, articlesFor, buildArticles, guideImage } from './content';
import {
  parseFrontMatter,
  parseInline,
  parseMarkdown,
  plainText,
  sectionsOf,
  slugify,
  type Block,
} from './markdown';
import { searchArticles, sections } from './search';
import { helpTopicFor } from './topics';

describe('markdown', () => {
  it('parses inline code, bold, italic, links and images', () => {
    expect(parseInline('a `b` **c** *d* [e](f.md#g) ![h](i.webp)')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'code', v: 'b' },
      { t: 'text', v: ' ' },
      { t: 'bold', v: 'c' },
      { t: 'text', v: ' ' },
      { t: 'em', v: 'd' },
      { t: 'text', v: ' ' },
      { t: 'link', v: 'e', href: 'f.md#g' },
      { t: 'text', v: ' ' },
      { t: 'img', alt: 'h', src: 'i.webp' },
    ]);
  });
  it('parses headings with unique ids, lists, tables, code, quotes and images', () => {
    const b = parseMarkdown(
      [
        'Intro line',
        'continues',
        '',
        '## Head',
        '## Head',
        '- a',
        '  - nested',
        '- b',
        '',
        '1. x',
        '2. y',
        '',
        '| K | V |',
        '| --- | --- |',
        '| `a` | b |',
        '',
        '```ts',
        'const x = 1;',
        '```',
        '> **Tip** use it',
        '',
        '![Alt text](images/a.webp)',
        '<!-- shortcuts:begin -->',
        'old',
        '<!-- shortcuts:end -->',
      ].join('\n'),
    );
    expect(b.map((x) => x.t)).toEqual([
      'p',
      'h',
      'h',
      'ul',
      'ol',
      'table',
      'code',
      'quote',
      'img',
      'shortcuts',
    ]);
    expect(b.filter((x): x is Block & { t: 'h' } => x.t === 'h').map((h) => h.id)).toEqual([
      'head',
      'head-1',
    ]);
    const ul = b[3]!;
    expect(ul.t === 'ul' && ul.items[0]!.children?.items).toHaveLength(1);
    const q = b[7]!;
    expect(q.t === 'quote' && q.kind).toBe('tip');
  });
  it('never produces HTML: markup stays text', () => {
    const b = parseMarkdown('<img src=x onerror=alert(1)> and [x](javascript:alert(1))');
    expect(b[0]!.t).toBe('p');
    expect(plainText('<script>x</script>')).toContain('<script>');
  });
  it('front matter and slugs', () => {
    const f = parseFrontMatter('---\ntitle: A\nnew: true\n---\nBody');
    expect(f.meta).toEqual({ title: 'A', new: 'true' });
    expect(f.body).toBe('Body');
    expect(slugify('Time & Sales (Smart Tape)')).toBe('time-sales-smart-tape');
    expect(sectionsOf(parseMarkdown('x\n\n## A\n\ny')).map((s) => s.id)).toEqual(['', 'a']);
  });
});

function walk(blocks: Block[], f: (b: Block) => void): void {
  for (const b of blocks) {
    f(b);
    if (b.t === 'quote') walk(b.blocks, f);
  }
}

describe('guide content', () => {
  it('has unique ids, valid "open" targets, and the required topics', () => {
    const ids = ARTICLES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const known = new Set(MODULES.map((m) => m.id));
    for (const a of ARTICLES) {
      expect(a.body.trim().length).toBeGreaterThan(200);
      for (const o of a.opens ?? []) expect(known.has(o), `${a.id} → ${o}`).toBe(true);
    }
    for (const id of [
      'getting-started',
      'interface',
      'data',
      'charts',
      'order-flow',
      'trading',
      'replay',
      'alerts',
      'news',
      'scanners',
      'strategies',
      'ai',
      'settings',
      'data-manager',
      'backups-logs',
      'keyboard-shortcuts',
      'troubleshooting',
    ])
      expect(ids, id).toContain(id);
    expect(ARTICLES.find((a) => a.id === 'ai')!.isNew).toBe(true);
  });
  it('every image exists and every link resolves', () => {
    const anchors = new Map(
      ARTICLES.map((a) => [a.id, new Set((a.parts ?? []).map((p) => p.id))] as const),
    );
    const files = new Set(ARTICLES.flatMap((a) => [a.id, a.file]));
    for (const a of ARTICLES) {
      walk(a.blocks ?? [], (b) => {
        if (b.t === 'img') expect(guideImage(b.src), `${a.id}: ${b.src}`).toBeTruthy();
        const inl =
          b.t === 'p' ? b.inl : b.t === 'ul' || b.t === 'ol' ? b.items.flatMap((i) => i.inl) : [];
        for (const p of inl)
          if (p.t === 'link' && !/^https?:/.test(p.href)) {
            const [f, h] = p.href.replace(/\.md/, '').split('#');
            const id = f ? ARTICLES.find((x) => x.file === f || x.id === f)?.id : a.id;
            expect(files.has(f || a.id) || !!id, `${a.id}: ${p.href}`).toBe(true);
            if (h && id) expect(anchors.get(id)!.has(h), `${a.id}: ${p.href}`).toBe(true);
          }
      });
    }
  });
  it('help topics point at real articles and headings', () => {
    const modules = MODULES.map((m) => ({ kind: 'module', module: m.id }));
    const states = [
      ...modules,
      { kind: 'dom' },
      { kind: 'chart' },
      ...[
        'footprint',
        'liquidity-map',
        'candles-vp',
        'tpo',
        'order-flow-dark',
        'delta-profile',
      ].map((template) => ({ kind: 'chart', template })),
    ];
    for (const s of states) {
      const t = helpTopicFor(s);
      const a = ARTICLES.find((x) => x.id === t.article);
      expect(a, JSON.stringify(s)).toBeTruthy();
      if (t.anchor)
        expect(
          (a!.parts ?? []).some((p) => p.id === t.anchor),
          `${JSON.stringify(s)} → ${t.anchor}`,
        ).toBe(true);
    }
  });
  it('picks the language folder and falls back to English files', () => {
    const raw = {
      '/x/docs/user-guide/01-a.md': '---\ntitle: A\n---\n## One\ntext',
      '/x/docs/user-guide/de/01-a.md': '---\ntitle: Ä\n---\n## Eins\ntext',
      '/x/docs/user-guide/README.md': 'readme',
    };
    expect(buildArticles(raw, 'en').map((a) => a.title)).toEqual(['A']);
    expect(buildArticles(raw, 'de').map((a) => a.title)).toEqual(['Ä']);
  });
});

describe('Urdu guide articles', () => {
  const ur = articlesFor('ur');

  it('translates the first two articles and falls back to English for the rest', () => {
    const byId = new Map(ur.map((a) => [a.id, a]));
    expect(byId.get('getting-started')!.title).toBe('آغاز کرنا');
    expect(byId.get('interface')!.title).toBe('انٹرفیس کا ٹور');
    expect(ur.map((a) => a.id)).toEqual(ARTICLES.map((a) => a.id));
    expect(byId.get('charts')!.title).toBe(ARTICLES.find((a) => a.id === 'charts')!.title);
  });

  it('keeps ids, "opens" targets, images and links of the English article', () => {
    for (const id of ['getting-started', 'interface']) {
      const en = ARTICLES.find((a) => a.id === id)!;
      const u = ur.find((a) => a.id === id)!;
      expect(u.opens).toEqual(en.opens);
      const imgs = (a: typeof en) => {
        const out: string[] = [];
        walk(a.blocks ?? [], (b) => {
          if (b.t === 'img') out.push(b.src);
        });
        return out;
      };
      expect(imgs(u)).toEqual(imgs(en));
      for (const src of imgs(u)) expect(guideImage(src), src).toBeTruthy();
      expect(u.parts?.length).toBe(en.parts?.length);
    }
  });

  it('recognises translated callout labels', () => {
    const b = parseMarkdown('> **ٹِپ** استعمال کریں\n\n> **انتباہ** احتیاط\n\n> **نوٹ** یاد رکھیں');
    expect(b.map((x) => (x.t === 'quote' ? x.kind : null))).toEqual(['tip', 'warning', 'note']);
  });
});

describe('search', () => {
  it('returns everything for an empty query', () => {
    expect(searchArticles(ARTICLES, '')).toHaveLength(ARTICLES.length);
  });
  it('requires all terms and ranks heading matches first', () => {
    expect(searchArticles(ARTICLES, 'replay zzzznotaword')).toHaveLength(0);
    expect(searchArticles(ARTICLES, 'replay')[0]!.article.id).toBe('replay');
  });
  it('finds footprint in the order flow article with a section anchor', () => {
    const hit = searchArticles(ARTICLES, 'footprint').find((h) => h.article.id === 'order-flow');
    expect(hit).toBeTruthy();
    expect(hit!.snippet.length).toBeGreaterThan(0);
  });
  it('groups into sections preserving order', () => {
    const s = sections(ARTICLES);
    expect(s[0]!.name).toBe('Getting started');
    expect(s.flatMap((x) => x.items)).toHaveLength(ARTICLES.length);
  });
});
