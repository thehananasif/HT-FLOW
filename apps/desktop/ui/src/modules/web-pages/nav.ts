/** Pure navigation helpers for the Web Pages mini browser. */

export interface Tab {
  id: string;
  /** Visited URLs, oldest first. Empty = blank start page. */
  history: string[];
  /** Index of the current entry in `history` (-1 when blank). */
  idx: number;
}

export interface Bookmark {
  title: string;
  url: string;
}

/**
 * Turns what the user typed into an http(s) URL, or null if it is not one.
 * `example.com/x` → `https://example.com/x`; `localhost:3000` → `http://localhost:3000`.
 * Only http / https are ever allowed (no javascript:, data:, file:).
 */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  let candidate = raw;
  if (scheme && !/^[^/]*:\d+(\/|$)/.test(raw)) {
    // A real scheme (not "host:port").
    if (!/^https?:$/i.test(scheme[0])) return null;
  } else if (/^(localhost|127\.|\[::1\])/i.test(raw)) {
    candidate = 'http://' + raw;
  } else {
    candidate = 'https://' + raw;
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname;
    if (!host || (!host.includes('.') && !/^localhost$|^\[::1\]$/i.test(host))) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const newTab = (id: string): Tab => ({ id, history: [], idx: -1 });

export const currentUrl = (t: Tab): string | null => t.history[t.idx] ?? null;

/** Navigates to `url`, dropping any forward history. Same URL as current is a no-op. */
export function navigate(t: Tab, url: string): Tab {
  if (currentUrl(t) === url) return t;
  const history = [...t.history.slice(0, t.idx + 1), url].slice(-100);
  return { ...t, history, idx: history.length - 1 };
}

export const canBack = (t: Tab) => t.idx > 0;
export const canForward = (t: Tab) => t.idx >= 0 && t.idx < t.history.length - 1;
export const back = (t: Tab): Tab => (canBack(t) ? { ...t, idx: t.idx - 1 } : t);
export const forward = (t: Tab): Tab => (canForward(t) ? { ...t, idx: t.idx + 1 } : t);

/** Short tab label: the host, or "New tab". */
export function tabTitle(t: Tab): string {
  const u = currentUrl(t);
  if (!u) return 'New tab';
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}

/** Validates persisted tabs; always returns at least one. */
export function readTabs(raw: unknown): Tab[] {
  const out: Tab[] = [];
  if (Array.isArray(raw)) {
    for (const r of raw) {
      const t = r as Partial<Tab>;
      if (typeof t?.id !== 'string' || !Array.isArray(t.history)) continue;
      const history = t.history.filter((h): h is string => typeof h === 'string' && !!normalizeUrl(h));
      const idx = typeof t.idx === 'number' ? Math.min(Math.max(t.idx, -1), history.length - 1) : history.length - 1;
      out.push({ id: t.id, history, idx: history.length ? Math.max(idx, 0) : -1 });
    }
  }
  return out.length ? out : [newTab('t1')];
}

export function readBookmarks(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (b): b is Bookmark =>
        !!b && typeof (b as Bookmark).url === 'string' && typeof (b as Bookmark).title === 'string',
    )
    .filter((b) => !!normalizeUrl(b.url))
    .slice(0, 200);
}

export function toggleBookmark(list: Bookmark[], url: string, title: string): Bookmark[] {
  return list.some((b) => b.url === url)
    ? list.filter((b) => b.url !== url)
    : [...list, { url, title: title || url }];
}
