/** Tiny Markdown-like parser for the in-app guide: headings, paragraphs, lists, tables, `code`, **bold**. */

export type Inline = { t: 'text' | 'code' | 'bold'; v: string };

export type Block =
  | { t: 'h'; level: 2 | 3; inl: Inline[] }
  | { t: 'p'; inl: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][] }
  | { t: 'table'; head: string[]; rows: string[][] };

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    const tok = m[0];
    out.push(
      tok.startsWith('`') ? { t: 'code', v: tok.slice(1, -1) } : { t: 'bold', v: tok.slice(2, -2) },
    );
    last = m.index + tok.length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r/g, '').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{2,3})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: 'h', level: h[1]!.length as 2 | 3, inl: parseInline(h[2]!) });
      i++;
      continue;
    }
    if (line.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(cells(lines[i++]!));
      out.push({ t: 'table', head, rows });
      continue;
    }
    const ul = /^\s*[-*]\s+/;
    const ol = /^\s*\d+\.\s+/;
    if (ul.test(line) || ol.test(line)) {
      const re = ul.test(line) ? ul : ol;
      const items: Inline[][] = [];
      while (i < lines.length && re.test(lines[i]!))
        items.push(parseInline(lines[i++]!.replace(re, '')));
      out.push({ t: re === ul ? 'ul' : 'ol', items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^#{2,3}\s/.test(lines[i]!) &&
      !ul.test(lines[i]!) &&
      !ol.test(lines[i]!) &&
      !lines[i]!.trim().startsWith('|')
    )
      para.push(lines[i++]!.trim());
    out.push({ t: 'p', inl: parseInline(para.join(' ')) });
  }
  return out;
}

/** Plain text of a markdown source (for search). */
export function plainText(src: string): string {
  return src
    .replace(/[`*#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
