/**
 * Small Markdown parser for the in-app User Guide. It produces a typed block tree that React
 * renders element by element (never as HTML), so guide text can never inject markup.
 *
 * Supported: `##`..`####` headings, paragraphs, nested bullet / numbered lists, tables, fenced code,
 * block quotes (callouts: `> **Tip** ...`, `> **Note**`, `> **Warning**`), images `![alt](file)`,
 * horizontal rules, and inline `code`, **bold**, *italic*, [links](target).
 * The block `<!-- shortcuts:begin --> ... <!-- shortcuts:end -->` is replaced in the app by a live
 * table of the registered commands (so user re-bindings show up); the text between the markers is
 * the static copy for readers of the .md file on GitHub.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'em'; v: string }
  | { t: 'link'; v: string; href: string }
  | { t: 'img'; alt: string; src: string };

export interface ListItem {
  inl: Inline[];
  /** Nested list directly under this item. */
  children?: Block & { t: 'ul' | 'ol' };
}

export type CalloutKind = 'tip' | 'note' | 'warning' | 'new';

export type Block =
  | { t: 'h'; level: 2 | 3 | 4; inl: Inline[]; id: string }
  | { t: 'p'; inl: Inline[] }
  | { t: 'ul'; items: ListItem[] }
  | { t: 'ol'; items: ListItem[] }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'quote'; kind: CalloutKind | null; blocks: Block[] }
  | { t: 'img'; alt: string; src: string }
  | { t: 'hr' }
  | { t: 'shortcuts' };

/** GitHub-style heading slug: lower case, words joined by `-`. */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[`*_]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'section'
  );
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /(`[^`]+`|!\[[^\]]*\]\([^)\s]+\)|\[[^\]]+\]\([^)\s]+\)|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith('`')) out.push({ t: 'code', v: tok.slice(1, -1) });
    else if (tok.startsWith('![')) {
      const mm = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(tok)!;
      out.push({ t: 'img', alt: mm[1]!, src: mm[2]! });
    } else if (tok.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      out.push({ t: 'link', v: mm[1]!, href: mm[2]! });
    } else if (tok.startsWith('**')) out.push({ t: 'bold', v: tok.slice(2, -2) });
    else out.push({ t: 'em', v: tok.slice(1, -1) });
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

const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = LIST.exec(lines[start]!)!;
  const base = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]!);
    if (!m) {
      // Continuation line of the previous item (indented text).
      if (lines[i]!.trim() && /^\s{2,}\S/.test(lines[i]!) && items.length) {
        const it = items[items.length - 1]!;
        it.inl = [...it.inl, { t: 'text', v: ' ' }, ...parseInline(lines[i]!.trim())];
        i++;
        continue;
      }
      break;
    }
    const indent = m[1]!.length;
    if (indent < base) break;
    if (indent > base) {
      const sub = parseList(lines, i);
      const parent = items[items.length - 1];
      if (parent && (sub.block.t === 'ul' || sub.block.t === 'ol')) parent.children = sub.block;
      i = sub.next;
      continue;
    }
    if (/\d/.test(m[2]!) !== ordered) break;
    items.push({ inl: parseInline(m[3]!) });
    i++;
  }
  return { block: { t: ordered ? 'ol' : 'ul', items }, next: i };
}

const CALLOUT = /^\*\*(Tip|Note|Warning|New)\*\*[:.]?\s*/i;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r/g, '').split('\n');
  const out: Block[] = [];
  const seen = new Map<string, number>();
  const uniqueId = (text: string) => {
    const base = slugify(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*<!--\s*shortcuts:begin\s*-->/.test(line)) {
      while (i < lines.length && !/<!--\s*shortcuts:end\s*-->/.test(lines[i]!)) i++;
      i++;
      out.push({ t: 'shortcuts' });
      continue;
    }
    if (/^\s*<!--.*-->\s*$/.test(line)) {
      i++;
      continue;
    }
    const fence = /^```\s*([\w-]*)\s*$/.exec(line.trim());
    if (fence) {
      const text: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) text.push(lines[i++]!);
      i++;
      out.push({ t: 'code', lang: fence[1] ?? '', text: text.join('\n') });
      continue;
    }
    const h = /^(#{2,4})\s+(.*)$/.exec(line);
    if (h) {
      const inl = parseInline(h[2]!);
      out.push({ t: 'h', level: h[1]!.length as 2 | 3 | 4, inl, id: uniqueId(h[2]!) });
      i++;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    const img = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line.trim());
    if (img) {
      out.push({ t: 'img', alt: img[1]!, src: img[2]! });
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
    if (line.startsWith('>')) {
      const inner: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) inner.push(lines[i++]!.replace(/^>\s?/, ''));
      const first = CALLOUT.exec(inner[0] ?? '');
      let kind: CalloutKind | null = null;
      if (first) {
        kind = first[1]!.toLowerCase() as CalloutKind;
        inner[0] = inner[0]!.replace(CALLOUT, '');
      }
      out.push({ t: 'quote', kind, blocks: parseMarkdown(inner.join('\n')) });
      continue;
    }
    if (LIST.test(line)) {
      const r = parseList(lines, i);
      out.push(r.block);
      i = r.next;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^#{2,4}\s/.test(lines[i]!) &&
      !LIST.test(lines[i]!) &&
      !lines[i]!.startsWith('>') &&
      !lines[i]!.trim().startsWith('|') &&
      !lines[i]!.trim().startsWith('```') &&
      !/^!\[[^\]]*\]\([^)\s]+\)\s*$/.test(lines[i]!.trim()) &&
      !/^\s*<!--/.test(lines[i]!)
    )
      para.push(lines[i++]!.trim());
    if (para.length) out.push({ t: 'p', inl: parseInline(para.join(' ')) });
    else i++;
  }
  return out;
}

function inlineText(inl: Inline[]): string {
  return inl
    .map((p) => (p.t === 'img' ? p.alt : p.t === 'link' ? p.v : 'v' in p ? p.v : ''))
    .join('');
}

function blockText(b: Block): string {
  switch (b.t) {
    case 'h':
    case 'p':
      return inlineText(b.inl);
    case 'ul':
    case 'ol':
      return b.items
        .map((it) => inlineText(it.inl) + (it.children ? ' ' + blockText(it.children) : ''))
        .join(' ');
    case 'table':
      return [...b.head, ...b.rows.flat()].join(' ').replace(/`/g, '');
    case 'code':
      return b.text;
    case 'quote':
      return b.blocks.map(blockText).join(' ');
    case 'img':
      return b.alt;
    default:
      return '';
  }
}

/** Plain text of a block list (for search). */
export function plainText(src: string | Block[]): string {
  const blocks = typeof src === 'string' ? parseMarkdown(src) : src;
  return blocks.map(blockText).join(' ').replace(/\s+/g, ' ').trim();
}

export interface Section {
  /** Heading id (anchor); '' for the intro before the first heading. */
  id: string;
  title: string;
  text: string;
}

/** Splits parsed blocks into the sections introduced by `##` headings (for section-level search). */
export function sectionsOf(blocks: Block[]): Section[] {
  const out: Section[] = [{ id: '', title: '', text: '' }];
  const bufs: string[][] = [[]];
  for (const b of blocks) {
    if (b.t === 'h' && b.level === 2) {
      out.push({ id: b.id, title: inlineText(b.inl), text: '' });
      bufs.push([]);
    } else bufs[bufs.length - 1]!.push(blockText(b));
  }
  out.forEach((s, i) => (s.text = bufs[i]!.join(' ').replace(/\s+/g, ' ').trim()));
  return out.filter((s) => s.text || s.title);
}

export interface FrontMatter {
  meta: Record<string, string>;
  body: string;
}

/** `---` delimited `key: value` header at the top of a guide file. */
export function parseFrontMatter(src: string): FrontMatter {
  const text = src.replace(/\r/g, '');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  return { meta, body: text.slice(m[0].length) };
}
