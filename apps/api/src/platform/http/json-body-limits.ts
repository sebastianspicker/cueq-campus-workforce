/** Per-route JSON body limits: the large limit applies only to bulk import endpoints. */
export const DEFAULT_JSON_LIMIT = '100kb';
export const LARGE_JSON_LIMIT = '3mb';

const LARGE_JSON_PATHS = new Set([
  '/v1/hr/import-runs',
  '/v1/terminal/sync/batches',
  '/v1/terminal/sync/batches/file',
]);

type RequestLike = { url?: string; method?: string; headers: Record<string, unknown> };

function isJsonContentType(req: RequestLike): boolean {
  const type = String(req.headers['content-type'] ?? '')
    .split(';', 1)
    .join('')
    .trim()
    .toLowerCase();
  return type === 'application/json' || /^application\/[^/;\s]+\+json$/u.test(type);
}

function isLargeJsonRoute(req: RequestLike): boolean {
  // Match the way Express routes: case-insensitive, trailing slash optional.
  const path = (req.url ?? '').split('?', 1).join('').replace(/\/+$/u, '').toLowerCase();
  return req.method === 'POST' && LARGE_JSON_PATHS.has(path);
}

export const matchesLargeJsonBody = (req: RequestLike): boolean =>
  isLargeJsonRoute(req) && isJsonContentType(req);

export const matchesDefaultJsonBody = (req: RequestLike): boolean =>
  !isLargeJsonRoute(req) && isJsonContentType(req);
