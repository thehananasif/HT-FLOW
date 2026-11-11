/** Picker favourites (star) and recently opened instruments — persisted per user by the app. */
export interface CatalogPrefs {
  favourites: string[];
  recent: string[];
}

export const RECENT_MAX = 20;

export const EMPTY_PREFS: CatalogPrefs = { favourites: [], recent: [] };

/** Validates persisted data (unknown shape → defaults). */
export function sanitizePrefs(x: unknown): CatalogPrefs {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const list = (v: unknown, max: number) =>
    Array.isArray(v)
      ? [...new Set(v.filter((s): s is string => typeof s === 'string' && s.length < 200))].slice(
          0,
          max,
        )
      : [];
  return { favourites: list(o.favourites, 500), recent: list(o.recent, RECENT_MAX) };
}

export function isFavourite(p: CatalogPrefs, id: string): boolean {
  return p.favourites.includes(id);
}

export function toggleFavourite(p: CatalogPrefs, id: string): CatalogPrefs {
  return {
    ...p,
    favourites: isFavourite(p, id) ? p.favourites.filter((x) => x !== id) : [...p.favourites, id],
  };
}

/** Moves `id` to the front of the recent list (deduplicated, capped). */
export function pushRecent(p: CatalogPrefs, id: string, max = RECENT_MAX): CatalogPrefs {
  return { ...p, recent: [id, ...p.recent.filter((x) => x !== id)].slice(0, max) };
}
