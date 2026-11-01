import { describe, expect, it } from 'vitest';
import { matchesDefaultJsonBody, matchesLargeJsonBody } from './json-body-limits.js';

const req = (url: string, contentType: string, method = 'POST') => ({
  url,
  method,
  headers: { 'content-type': contentType },
});

describe('JSON body limit routing', () => {
  it.each([
    '/v1/hr/import-runs',
    '/v1/terminal/sync/batches',
    '/v1/terminal/sync/batches/file?x=1',
  ])('uses the large limit for %s', (url) => {
    const r = req(url, 'Application/JSON; charset=utf-8');
    expect(matchesLargeJsonBody(r)).toBe(true);
    expect(matchesDefaultJsonBody(r)).toBe(false);
  });

  it('uses the default limit elsewhere, including +json types', () => {
    const r = req('/v1/absences', 'application/merge-patch+json');
    expect(matchesDefaultJsonBody(r)).toBe(true);
    expect(matchesLargeJsonBody(r)).toBe(false);
    expect(matchesDefaultJsonBody(req('/v1/hr/import-runs', 'application/json', 'GET'))).toBe(true);
  });

  it('matches neither parser for non-JSON content types', () => {
    const r = req('/v1/hr/import-runs', 'text/plain');
    expect(matchesLargeJsonBody(r)).toBe(false);
    expect(matchesDefaultJsonBody(r)).toBe(false);
    expect(matchesDefaultJsonBody({ url: '/x', headers: {} })).toBe(false);
  });
});
