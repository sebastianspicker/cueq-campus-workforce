/** Fail-closed runtime classification: only an explicit development or test NODE_ENV relaxes security. */
export function isDevelopmentOrTest(env: NodeJS.ProcessEnv = process.env): boolean {
  const runtime = (env.NODE_ENV ?? '').trim().toLowerCase();
  return runtime === 'development' || runtime === 'test';
}
