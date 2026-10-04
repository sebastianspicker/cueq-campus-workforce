import { lookup } from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertWebhookTargetUrl, resolveWebhookDispatchTarget } from './webhook-url.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

const lookupMock = vi.mocked(lookup);
const production = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;

afterEach(() => {
  lookupMock.mockReset();
});

describe('webhook url validation', () => {
  it('rejects malformed urls and non-http protocols', () => {
    expect(() => assertWebhookTargetUrl('not a url', production)).toThrow(/valid absolute URL/iu);
    expect(() => assertWebhookTargetUrl('ftp://example.com/hook', production)).toThrow(
      /protocol must be http or https/iu,
    );
  });

  it('requires https in production unless private targets are allowed', () => {
    expect(() => assertWebhookTargetUrl('http://example.com/hook', production)).toThrow(
      /must use https in production/iu,
    );
    expect(
      assertWebhookTargetUrl('http://example.com/hook', {
        NODE_ENV: 'production',
        WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true',
      } as NodeJS.ProcessEnv).hostname,
    ).toBe('example.com');
  });

  it('pins literal public addresses without a DNS lookup', async () => {
    const target = await resolveWebhookDispatchTarget('https://93.184.216.34/hook', production);
    expect(target).toMatchObject({ address: '93.184.216.34', family: 4 });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('fails closed on DNS errors and empty answers', async () => {
    lookupMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(
      resolveWebhookDispatchTarget('https://receiver.example/hook', production),
    ).rejects.toThrow(/DNS lookup failed/iu);
    lookupMock.mockResolvedValueOnce([] as never);
    await expect(
      resolveWebhookDispatchTarget('https://receiver.example/hook', production),
    ).rejects.toThrow(/returned no addresses/iu);
  });
});
