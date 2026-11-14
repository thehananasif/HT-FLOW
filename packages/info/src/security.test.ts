import { describe, expect, it } from 'vitest';
import { parseFeed, safeLink } from './feed';

describe('feed links from untrusted feeds', () => {
  it('keeps only absolute http(s) links', () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>
      <item><title>a</title><link>javascript:alert(document.cookie)</link></item>
      <item><title>b</title><link> JaVaScRiPt:alert(1)</link></item>
      <item><title>c</title><link>data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;</link></item>
      <item><title>d</title><link>file:///C:/Windows/win.ini</link></item>
      <item><title>e</title><link>/relative/ok</link></item>
      <item><title>f</title><link>https://news.example.com/x</link></item>
    </channel></rss>`;
    const links = parseFeed(rss, 'https://example.com/feed.xml').items.map((i) => i.link);
    expect(links).toEqual([
      '',
      '',
      '',
      '',
      'https://example.com/relative/ok',
      'https://news.example.com/x',
    ]);
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>
      <entry><id>1</id><title>a</title><link href="javascript:alert(1)"/></entry></feed>`;
    expect(parseFeed(atom).items[0]!.link).toBe('');
  });

  it('safeLink rejects control characters and bare schemes', () => {
    expect(safeLink('https://a.com/x')).toBe('https://a.com/x');
    expect(safeLink('https://a.com/\nx')).toBe('');
    expect(safeLink('http://')).toBe('');
    expect(safeLink('vbscript:x')).toBe('');
  });
});
