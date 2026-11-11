/** Local Following list (P28). The server side (public ideas / accounts) is blocked: no sharing server. */

export interface Followed {
  id: string;
  /** Handle without a leading @. */
  handle: string;
  notes: string;
  tags: string[];
  addedAt: number;
  /** Silences the trader's items in the sample feed. */
  muted: boolean;
}

export const HANDLE_RE = /^[A-Za-z0-9_.-]{3,24}$/;
export const MAX_TAGS = 8;

export function normalizeHandle(input: string): string {
  return input.trim().replace(/^@+/, '');
}

export function validateHandle(input: string, existing: readonly Followed[]): string | null {
  const h = normalizeHandle(input);
  if (!h) return 'Enter a trader handle';
  if (!HANDLE_RE.test(h)) return '3–24 letters, digits, dot, dash or underscore';
  if (existing.some((f) => f.handle.toLowerCase() === h.toLowerCase())) return 'Already in your list';
  return null;
}

/** "scalper, ES ,  ES" → ["scalper", "ES"] (case-insensitive unique, max 8, 1–20 chars). */
export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,;]/)) {
    const t = raw.trim().replace(/^#/, '').slice(0, 20);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export function addFollowed(
  list: readonly Followed[],
  handle: string,
  notes: string,
  tags: string[],
  now = Date.now(),
): Followed[] {
  const err = validateHandle(handle, list);
  if (err) throw new Error(err);
  const h = normalizeHandle(handle);
  return [
    ...list,
    { id: `f${now.toString(36)}${list.length}`, handle: h, notes: notes.trim(), tags, addedAt: now, muted: false },
  ];
}

export function filterFollowed(list: readonly Followed[], query: string, tag: string): Followed[] {
  const q = query.trim().toLowerCase();
  return list.filter(
    (f) =>
      (!tag || f.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) &&
      (!q ||
        f.handle.toLowerCase().includes(q) ||
        f.notes.toLowerCase().includes(q) ||
        f.tags.some((t) => t.toLowerCase().includes(q))),
  );
}

export function allTags(list: readonly Followed[]): string[] {
  const m = new Map<string, string>();
  for (const f of list) for (const t of f.tags) if (!m.has(t.toLowerCase())) m.set(t.toLowerCase(), t);
  return [...m.values()].sort((a, b) => a.localeCompare(b));
}

export function readFollowed(raw: unknown): Followed[] {
  if (!Array.isArray(raw)) return [];
  const out: Followed[] = [];
  for (const r of raw) {
    const f = r as Partial<Followed>;
    if (typeof f?.id !== 'string' || typeof f.handle !== 'string' || !HANDLE_RE.test(f.handle)) continue;
    if (out.some((o) => o.handle.toLowerCase() === f.handle!.toLowerCase())) continue;
    out.push({
      id: f.id,
      handle: f.handle,
      notes: typeof f.notes === 'string' ? f.notes : '',
      tags: Array.isArray(f.tags) ? parseTags(f.tags.filter((t) => typeof t === 'string').join(',')) : [],
      addedAt: typeof f.addedAt === 'number' ? f.addedAt : 0,
      muted: f.muted === true,
    });
  }
  return out;
}

// ------------------------------------------------------------------ sample feed (clearly mock)

export interface SampleIdea {
  handle: string;
  symbol: string;
  side: 'long' | 'short';
  title: string;
  hoursAgo: number;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const SYMBOLS = ['ESZ6', 'NQZ6', 'CLZ6', 'GCZ6', 'BTCUSDT'];
const TITLES = [
  'Absorption at the prior day low',
  'Stacked bid imbalances into the open',
  'Failed breakout, delta divergence',
  'Value area rejection, fading back to POC',
  'Iceberg refilling at the offer',
];

/** Deterministic placeholder ideas per handle, so the UI can be reviewed without a server. */
export function sampleIdeas(list: readonly Followed[]): SampleIdea[] {
  const out: SampleIdea[] = [];
  for (const f of list) {
    if (f.muted) continue;
    const h = hash(f.handle.toLowerCase());
    for (let i = 0; i < 2; i++) {
      const k = hash(`${h}:${i}`);
      out.push({
        handle: f.handle,
        symbol: SYMBOLS[k % SYMBOLS.length]!,
        side: k % 2 ? 'long' : 'short',
        title: TITLES[(k >> 3) % TITLES.length]!,
        hoursAgo: 1 + (k % 47),
      });
    }
  }
  return out.sort((a, b) => a.hoursAgo - b.hoursAgo);
}
