import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service.js';
import type { OidcIdentityProviderAdapter } from './oidc-identity-provider.adapter.js';
import type { SamlIdentityProviderAdapter } from './saml-identity-provider.adapter.js';

const oidc = { kind: 'oidc' } as unknown as OidcIdentityProviderAdapter;
const saml = { kind: 'saml' } as unknown as SamlIdentityProviderAdapter;
const savedEnv = { ...process.env };

function configure(values: Record<string, string | undefined>) {
  for (const key of ['NODE_ENV', 'AUTH_PROVIDER', 'AUTH_MODE', 'OIDC_ISSUER_URL']) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
}

describe('AuthService provider selection', () => {
  beforeEach(() => configure({}));
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('fails closed when NODE_ENV is unset and no provider is configured', () => {
    expect(() => new AuthService(oidc, saml)).toThrow(/AUTH_PROVIDER is required/);
  });

  it('rejects the mock provider outside development and test', () => {
    configure({ NODE_ENV: 'staging', AUTH_PROVIDER: 'mock' });
    expect(() => new AuthService(oidc, saml)).toThrow(/mock auth provider is disabled/);
  });

  it('allows explicit mock in development', () => {
    configure({ NODE_ENV: 'development', AUTH_PROVIDER: 'mock' });
    expect(() => new AuthService(oidc, saml)).not.toThrow();
  });

  it('defaults to mock in test', async () => {
    configure({ NODE_ENV: 'test' });
    const service = new AuthService(oidc, saml);
    await expect(service.verifyToken('employee-token')).resolves.toMatchObject({
      subject: expect.any(String),
    });
  });

  it('accepts oidc in production', () => {
    configure({ NODE_ENV: 'production', AUTH_PROVIDER: 'oidc' });
    expect(() => new AuthService(oidc, saml)).not.toThrow();
  });
});
