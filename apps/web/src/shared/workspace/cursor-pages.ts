import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_PREFERENCE_SLOT,
  getStoredPreference,
} from '../../platform/browser/preferences';

/** Merge pages without duplicating rows when a record changes between requests. */
export function mergePage<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  const rows = new Map(previous.map((row) => [row.id, row]));
  for (const row of incoming) rows.set(row.id, row);
  return [...rows.values()];
}

const PAGE_SIZES = new Set(['10', '20', '50', '100']);

/** Uses the page size chosen in Settings; anything else (unset, edited storage) falls back to the default. */
export function pagePath(path: string, cursor?: string | null): string {
  const stored = getStoredPreference(PAGE_SIZE_PREFERENCE_SLOT, DEFAULT_PAGE_SIZE);
  const params = new URLSearchParams({
    limit: PAGE_SIZES.has(stored) ? stored : DEFAULT_PAGE_SIZE,
  });
  if (cursor) params.set('cursor', cursor);
  return `${path}${path.includes('?') ? '&' : '?'}${params}`;
}
