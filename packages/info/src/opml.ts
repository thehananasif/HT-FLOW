import {
  childElement,
  childElements,
  escapeXml,
  localName,
  parseXml,
  textContent,
  type XmlElement,
} from './xml';

export interface OpmlFeed {
  title: string;
  xmlUrl: string;
  htmlUrl?: string;
  /** Folder path joined with " / " ('' = top level). */
  folder: string;
}

export interface OpmlDocument {
  title: string;
  feeds: OpmlFeed[];
}

/** OPML 1.0/2.0 import: outlines with `xmlUrl` are feeds; outlines without are folders (nested). */
export function parseOpml(src: string): OpmlDocument {
  const root = parseXml(src);
  if (!root || localName(root.name).toLowerCase() !== 'opml') throw new Error('Not an OPML file');
  const head = childElement(root, 'head');
  const body = childElement(root, 'body');
  const feeds: OpmlFeed[] = [];
  const walk = (el: XmlElement, path: string[]) => {
    for (const o of childElements(el, 'outline')) {
      const label = (o.attrs.title ?? o.attrs.text ?? '').trim();
      const xmlUrl = (o.attrs.xmlUrl ?? o.attrs.xmlurl ?? o.attrs.url ?? '').trim();
      if (xmlUrl) {
        const f: OpmlFeed = { title: label || xmlUrl, xmlUrl, folder: path.join(' / ') };
        const html = (o.attrs.htmlUrl ?? o.attrs.htmlurl ?? '').trim();
        if (html) f.htmlUrl = html;
        feeds.push(f);
      }
      walk(o, xmlUrl || !label ? path : [...path, label]);
    }
  };
  if (body) walk(body, []);
  const titleEl = head && childElement(head, 'title');
  return { title: textContent(titleEl).trim(), feeds };
}

/** OPML 2.0 export grouped by folder (one level; nested paths keep their " / " joined name). */
export function exportOpml(title: string, feeds: OpmlFeed[], now = Date.now()): string {
  const byFolder = new Map<string, OpmlFeed[]>();
  for (const f of feeds) {
    const list = byFolder.get(f.folder) ?? [];
    list.push(f);
    byFolder.set(f.folder, list);
  }
  const line = (f: OpmlFeed, indent: string) =>
    `${indent}<outline type="rss" text="${escapeXml(f.title)}" title="${escapeXml(f.title)}" xmlUrl="${escapeXml(f.xmlUrl)}"${f.htmlUrl ? ` htmlUrl="${escapeXml(f.htmlUrl)}"` : ''}/>`;
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escapeXml(title)}</title>`,
    `    <dateCreated>${new Date(now).toUTCString()}</dateCreated>`,
    '  </head>',
    '  <body>',
  ];
  for (const [folder, list] of byFolder) {
    if (!folder) {
      for (const f of list) out.push(line(f, '    '));
      continue;
    }
    out.push(`    <outline text="${escapeXml(folder)}" title="${escapeXml(folder)}">`);
    for (const f of list) out.push(line(f, '      '));
    out.push('    </outline>');
  }
  out.push('  </body>', '</opml>');
  return out.join('\n') + '\n';
}
