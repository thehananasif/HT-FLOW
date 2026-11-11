/**
 * Small, lenient XML parser for feeds and OPML. Works in Node and the browser (no DOMParser).
 * Handles the XML declaration, processing instructions, comments, CDATA, DOCTYPE (incl. internal
 * subset), namespaced names, character / predefined / common HTML entities, self-closing tags and
 * mismatched closing tags (recovers instead of throwing — real-world feeds are often broken).
 */

export interface XmlElement {
  /** Qualified name as written, e.g. `content:encoded`. */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  deg: '°',
  laquo: '«',
  raquo: '»',
  times: '×',
  divide: '÷',
  plusmn: '±',
  shy: '­',
};

/** Decodes character references and predefined/common named entities. Unknown entities stay as-is. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1));
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

const NAME_RE = /[^\s/>=]+/y;

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const v = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[m[1]!] = decodeEntities(v);
  }
  return attrs;
}

/** Parses a document and returns the root element (or null when there is none). */
export function parseXml(src: string): XmlElement | null {
  const doc: XmlElement = { name: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [doc];
  const top = () => stack[stack.length - 1]!;
  let i = 0;
  const n = src.length;
  // Strip a UTF-8 BOM.
  if (src.charCodeAt(0) === 0xfeff) i = 1;

  const pushText = (t: string) => {
    if (!t) return;
    const kids = top().children;
    const last = kids[kids.length - 1];
    if (typeof last === 'string') kids[kids.length - 1] = last + t;
    else kids.push(t);
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      pushText(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) pushText(decodeEntities(src.slice(i, lt)));
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      pushText(src.slice(i + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
    } else if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (src.startsWith('<!', i)) {
      // DOCTYPE or other declaration; skip a bracketed internal subset.
      let j = i + 2;
      let depth = 0;
      while (j < n) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
        j++;
      }
      i = j + 1;
    } else if (src[i + 1] === '/') {
      const end = src.indexOf('>', i + 2);
      const name = src.slice(i + 2, end < 0 ? n : end).trim();
      i = end < 0 ? n : end + 1;
      // Pop to the matching open element; ignore stray closing tags.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
    } else {
      NAME_RE.lastIndex = i + 1;
      const nm = NAME_RE.exec(src);
      if (!nm || nm.index !== i + 1) {
        // A bare "<" in text.
        pushText('<');
        i++;
        continue;
      }
      // Find the end of the tag, respecting quoted attribute values.
      let j = i + 1 + nm[0].length;
      let quote: string | null = null;
      while (j < n) {
        const c = src[j]!;
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        j++;
      }
      let body = src.slice(i + 1 + nm[0].length, j);
      const selfClose = body.endsWith('/');
      if (selfClose) body = body.slice(0, -1);
      const el: XmlElement = { name: nm[0], attrs: parseAttrs(body), children: [] };
      top().children.push(el);
      if (!selfClose) stack.push(el);
      i = j + 1;
    }
  }
  return (doc.children.find((c) => typeof c !== 'string') as XmlElement | undefined) ?? null;
}

/** Local name without a namespace prefix (`dc:date` → `date`). */
export function localName(name: string): string {
  const k = name.indexOf(':');
  return k < 0 ? name : name.slice(k + 1);
}

const matches = (el: XmlElement, name: string) =>
  name.includes(':') ? el.name === name : localName(el.name) === name;

/** Direct child elements; `name` without a prefix matches any namespace. */
export function childElements(el: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) {
    if (typeof c !== 'string' && (name === undefined || matches(c, name))) out.push(c);
  }
  return out;
}

export function childElement(el: XmlElement, name: string): XmlElement | undefined {
  for (const c of el.children) if (typeof c !== 'string' && matches(c, name)) return c;
  return undefined;
}

/** Concatenated text content (descendants included). */
export function textContent(el: XmlElement | undefined): string {
  if (!el) return '';
  let s = '';
  for (const c of el.children) s += typeof c === 'string' ? c : textContent(c);
  return s;
}

/** Re-serialises children as markup (for Atom `type="xhtml"` content). */
export function innerXml(el: XmlElement): string {
  let s = '';
  for (const c of el.children) {
    if (typeof c === 'string') s += escapeXml(c);
    else {
      const attrs = Object.entries(c.attrs)
        .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
        .join('');
      s += `<${c.name}${attrs}>${innerXml(c)}</${c.name}>`;
    }
  }
  return s;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
