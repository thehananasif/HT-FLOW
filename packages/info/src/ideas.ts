/** TradersTalk: local idea log per instrument and the portable `.htidea` file format. */

export interface Idea {
  id: string;
  instrumentId: string;
  symbol: string;
  createdAt: number;
  updatedAt: number;
  author: string;
  text: string;
  tags: string[];
  /** Optional chart snapshot as a data: URL (PNG/JPEG). */
  snapshot?: string;
}

export interface IdeaFile {
  format: 'htidea';
  version: 1;
  exportedAt: number;
  ideas: Idea[];
}

export const IDEA_TEXT_MAX = 10_000;
export const SNAPSHOT_MAX_CHARS = 3_000_000;

/** "#breakout long #CL" → ['breakout', 'cl'] (lower-case, unique). */
export function extractTags(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{1,32})/gu)) out.add(m[1]!.toLowerCase());
  return [...out];
}

/** Parses a comma / space separated tag field. */
export function parseTagInput(s: string): string[] {
  return [
    ...new Set(
      s
        .split(/[,\s]+/)
        .map((t) => t.replace(/^#/, '').trim().toLowerCase())
        .filter((t) => /^[\p{L}\p{N}_-]{1,32}$/u.test(t)),
    ),
  ];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

/** Validates one idea; returns null when it is unusable. */
export function normalizeIdea(raw: unknown): Idea | null {
  if (!isObj(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.slice(0, 64) : '';
  const instrumentId = typeof raw.instrumentId === 'string' ? raw.instrumentId.slice(0, 128) : '';
  const text = typeof raw.text === 'string' ? raw.text.slice(0, IDEA_TEXT_MAX) : '';
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : NaN;
  if (!id || !instrumentId || Number.isNaN(createdAt)) return null;
  const idea: Idea = {
    id,
    instrumentId,
    symbol: typeof raw.symbol === 'string' && raw.symbol ? raw.symbol.slice(0, 32) : instrumentId,
    createdAt,
    updatedAt:
      typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
    author: typeof raw.author === 'string' ? raw.author.slice(0, 64) : '',
    text,
    tags: Array.isArray(raw.tags) ? parseTagInput(raw.tags.filter((t) => typeof t === 'string').join(' ')) : [],
  };
  // Only raster data URLs (no SVG — it can carry script).
  if (
    typeof raw.snapshot === 'string' &&
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw.snapshot) &&
    raw.snapshot.length <= SNAPSHOT_MAX_CHARS
  )
    idea.snapshot = raw.snapshot;
  if (!idea.text.trim() && !idea.snapshot) return null;
  return idea;
}

export function exportIdeas(ideas: readonly Idea[], now = Date.now()): string {
  const file: IdeaFile = { format: 'htidea', version: 1, exportedAt: now, ideas: [...ideas] };
  return JSON.stringify(file, null, 2);
}

/** Parses a `.htidea` file; throws with a readable message when it is not one. */
export function parseIdeaFile(text: string): { ideas: Idea[]; skipped: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not a .htidea file (invalid JSON)');
  }
  if (!isObj(raw) || raw.format !== 'htidea') throw new Error('Not a .htidea file');
  if (raw.version !== 1) throw new Error(`Unsupported .htidea version ${String(raw.version)}`);
  const list = Array.isArray(raw.ideas) ? raw.ideas : [];
  const ideas: Idea[] = [];
  for (const r of list) {
    const i = normalizeIdea(r);
    if (i) ideas.push(i);
  }
  return { ideas, skipped: list.length - ideas.length };
}

/** Imports ideas: new ids are added, known ids are replaced only by a newer `updatedAt`. */
export function mergeIdeas(
  existing: readonly Idea[],
  incoming: readonly Idea[],
): { ideas: Idea[]; added: number; updated: number } {
  const map = new Map(existing.map((i) => [i.id, i]));
  let added = 0;
  let updated = 0;
  for (const i of incoming) {
    const cur = map.get(i.id);
    if (!cur) {
      map.set(i.id, i);
      added++;
    } else if (i.updatedAt > cur.updatedAt) {
      map.set(i.id, i);
      updated++;
    }
  }
  return { ideas: [...map.values()].sort((a, b) => a.createdAt - b.createdAt), added, updated };
}

export function filterIdeas(
  ideas: readonly Idea[],
  f: { instrumentId?: string | null; tag?: string | null; query?: string },
): Idea[] {
  const q = f.query?.trim().toLowerCase() ?? '';
  return ideas.filter(
    (i) =>
      (!f.instrumentId || i.instrumentId === f.instrumentId) &&
      (!f.tag || i.tags.includes(f.tag)) &&
      (!q || i.text.toLowerCase().includes(q) || i.symbol.toLowerCase().includes(q)),
  );
}
