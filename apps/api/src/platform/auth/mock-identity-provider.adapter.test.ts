import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MockIdentityProviderAdapter } from './mock-identity-provider.adapter.js';

describe('MockIdentityProviderAdapter', () => {
  it('returns only verified data and ignores role claims', async () => {
    const provider = new MockIdentityProviderAdapter();
    const named = await provider.verifyAccessToken('admin-token');
    expect(named.email).toContain('@');
    expect(named).not.toHaveProperty('role');

    const encoded = Buffer.from(
      JSON.stringify({ sub: 'subject-1', email: 'person@example.test', role: 'not-a-role' }),
    ).toString('base64url');
    await expect(provider.verifyAccessToken(`mock.${encoded}`)).resolves.toMatchObject({
      subject: 'subject-1',
    });
    await expect(provider.verifyAccessToken('mock.not-json')).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
