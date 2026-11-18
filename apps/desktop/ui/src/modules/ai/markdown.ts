/**
 * Small Markdown subset for model replies, parsed to a plain tree and rendered with React
 * elements only (never `innerHTML`), so HTML in a reply is shown as text: sanitized by
 * construction. Supported: headings, paragraphs, fenced code, bullet / numbered lists,
 * blockquotes, tables, horizontal rules, **bold**, *italic*, `code`, ~~strike~~ and http(s) links.
 */
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'b'; c: Inline[] }
  | { t: 'i'; c: Inline[] }
  | { t: 's'; c: Inline[] }
  | { t: 'a'; href: string; c: Inline[] };

export type Block =
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

/** Only absolute http(s) URLs become links. */
export function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpMatchArray | null;
    if (rest[0] === '\\' && rest.length > 1 && /[\\`*_~[\]()#|-]/.test(rest[1]!)) {
      buf += rest[1];
      i += 2;
    } else if ((m = rest.match(/^`([^`]+)`/))) {
      flush();
      out.push({ t: 'code', v: m[1]! });
      i += m[0].length;
    } else if ((m = rest.match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/))) {
      flush();
      out.push({ t: 'b', c: parseInline(m[2]!) });
      i += m[0].length;
    } else if ((m = rest.match(/^~~(?=\S)([\s\S]*?\S)~~/))) {
      flush();
      out.push({ t: 's', c: parseInline(m[1]!) });
      i += m[0].length;
    } else if ((m = rest.match(/^(\*|_)(?=\S)([^*_]*?\S)\1(?![*_\w])/))) {
      flush();
      out.push({ t: 'i', c: parseInline(m[2]!) });
      i += m[0].length;
    } else if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/))) {
      flush();
      const href = safeHref(m[2]!);
      if (href) out.push({ t: 'a', href, c: parseInline(m[1]!) });
      else out.push({ t: 'text', v: m[1]! });
      i += m[0].length;
    } else if ((m = rest.match(/^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/))) {
      flush();
      const href = safeHref(m[0]);
      out.push(href ? { t: 'a', href, c: [{ t: 'text', v: m[0] }] } : { t: 'text', v: m[0] });
      i += m[0].length;
    } else {
      buf += rest[0];
      i += 1;
    }
  }
  flush();
  return out;
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => parseInline(c.trim()));

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i]!;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*(```|~~~)\s*([\w+-]*)/))) {
      endPara();
      const fence = m[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence)) body.push(lines[i++]!);
      i++; // closing fence (or end of a still-streaming reply)
      blocks.push({ t: 'code', lang: m[2] ?? '', v: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      endPara();
      i++;
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      endPara();
      blocks.push({ t: 'h', level: m[1]!.length, c: parseInline(m[2]!.replace(/\s#+\s*$/, '')) });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      endPara();
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      endPara();
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!))
        body.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      blocks.push({ t: 'quote', c: parseMarkdown(body.join('\n')) });
      continue;
    }
    if (/^\s*([-*+])\s+/.test(line)) {
      endPara();
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*([-*+])\s+/.test(lines[i]!))
        items.push(parseInline(lines[i++]!.replace(/^\s*[-*+]\s+/, '')));
      blocks.push({ t: 'ul', items });
      continue;
    }
    if ((m = line.match(/^\s*(\d+)[.)]\s+/))) {
      endPara();
      const start = Number(m[1]);
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!))
        items.push(parseInline(lines[i++]!.replace(/^\s*\d+[.)]\s+/, '')));
      blocks.push({ t: 'ol', start, items });
      continue;
    }
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1]!)
    ) {
      endPara();
      const head = splitRow(line);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim())
        rows.push(splitRow(lines[i++]!));
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    para.push(line);
    i++;
  }
  endPara();
  return blocks;
}

/** Fenced code blocks of a reply (for "copy code"). */
export function codeBlocks(src: string): string[] {
  return parseMarkdown(src)
    .filter((b): b is Extract<Block, { t: 'code' }> => b.t === 'code')
    .map((b) => b.v);
}
