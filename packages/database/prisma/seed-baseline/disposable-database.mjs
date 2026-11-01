/** Refuses destructive seed operations unless the target database is clearly disposable. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DISPOSABLE_NAME = /^cueq(_[a-z0-9_]+)?$/u;

/**
 * Allows local databases named cueq or cueq_*; any other target needs
 * CUEQ_DESTRUCTIVE_SEED_TARGET set to exactly "<hostname>/<database>".
 */
export function assertDisposableDatabase(databaseUrl, env = process.env) {
  let host = '<unknown>';
  let name = '<unknown>';
  try {
    const url = new URL(databaseUrl);
    host = url.hostname;
    name = decodeURIComponent(url.pathname.replace(/^\//u, ''));
    // libpq/Prisma let these override the URL host; multi-host URLs hide the real target.
    const redirectsHost =
      url.searchParams.has('host') || url.searchParams.has('hostaddr') || host.includes(',');
    if (!redirectsHost) {
      if (name && env.CUEQ_DESTRUCTIVE_SEED_TARGET === `${host}/${name}`) return;
      if (LOCAL_HOSTS.has(host) && DISPOSABLE_NAME.test(name)) return;
    }
  } catch {
    // Fall through: a missing or unparseable URL is never disposable.
  }
  throw new Error(
    `Refusing destructive seed: database "${name}" on host "${host}" is not a disposable local ` +
      `cueq database. Set CUEQ_DESTRUCTIVE_SEED_TARGET="${host}/${name}" to override.`,
  );
}
