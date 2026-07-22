import { beforeEach, describe, expect, it, vi } from 'vitest';

const lockState = vi.hoisted(() => ({ active: false }));
const mocks = vi.hoisted(() => ({
  readCredential: vi.fn(),
  refreshCredential: vi.fn(),
  writeCredential: vi.fn(),
  withCredentialMutationLock: vi.fn(
    async (_authRef: string, operation: () => Promise<unknown>) => {
      lockState.active = true;
      try {
        return await operation();
      } finally {
        lockState.active = false;
      }
    },
  ),
}));

vi.mock('../src/credential-helper.js', () => ({
  credentialAccountBase: (account: string) => account,
  deleteCredentialHelperAccount: vi.fn(),
  isCredentialAccountInstance: vi.fn(() => false),
  readCredentialHelperAccount: mocks.readCredential,
  writeCredentialHelperAccount: mocks.writeCredential,
}));

vi.mock('../src/oauth/refresh.js', () => ({
  oauthCredentialShouldRefresh: (credential: { expires: number }) =>
    credential.expires <= Date.now() + 120_000,
  refreshStoredOAuthCredential: mocks.refreshCredential,
}));

vi.mock('../src/registry/lock.js', () => ({
  withCredentialMutationLock: mocks.withCredentialMutationLock,
}));

import { resolveProviderCredential } from '../src/env.js';

const HELPER_ID = 'a'.repeat(64);
const AUTH_REF = `helper:v1:${HELPER_ID}:oauth:provider:openai-oauth`;
const FRESH_AUTH_REF = `helper:v1:${'b'.repeat(64)}:oauth:provider:openai-oauth`;

function oauthCredential(access: string, expires: number): string {
  return JSON.stringify({
    type: 'oauth',
    access,
    refresh: `${access}-refresh`,
    expires,
  });
}

describe('OAuth credential refresh serialization', () => {
  beforeEach(() => {
    mocks.readCredential.mockReset();
    mocks.refreshCredential.mockReset();
    mocks.writeCredential.mockReset();
    mocks.withCredentialMutationLock.mockClear();
    lockState.active = false;
    delete process.env.CLODEX_KEY_OPENAI_OAUTH;
  });

  it('reads the credential after acquiring its mutation lock', async () => {
    const replacement = oauthCredential('replacement', Date.now() + 3_600_000);
    mocks.readCredential.mockImplementationOnce(async () => {
      expect(lockState.active).toBe(true);
      return replacement;
    });

    await expect(
      resolveProviderCredential('openai-oauth', FRESH_AUTH_REF),
    ).resolves.toBe('replacement');

    expect(mocks.withCredentialMutationLock).toHaveBeenCalledWith(
      FRESH_AUTH_REF,
      expect.any(Function),
      { waitMs: 150_000 },
    );
    expect(mocks.refreshCredential).not.toHaveBeenCalled();
    expect(mocks.writeCredential).not.toHaveBeenCalled();
    expect(mocks.readCredential).toHaveBeenCalledOnce();
  });

  it('persists a refreshed credential while holding the mutation lock', async () => {
    const stale = oauthCredential('stale', 0);
    const refreshed = {
      type: 'oauth' as const,
      access: 'refreshed',
      refresh: 'rotated-refresh',
      expires: Date.now() + 3_600_000,
    };
    mocks.readCredential
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(JSON.stringify(refreshed));
    mocks.refreshCredential.mockResolvedValue(refreshed);
    mocks.writeCredential.mockResolvedValue(undefined);

    await expect(
      resolveProviderCredential('openai-oauth', AUTH_REF),
    ).resolves.toBe('refreshed');

    expect(mocks.refreshCredential).toHaveBeenCalledOnce();
    expect(mocks.writeCredential).toHaveBeenCalledWith(
      'oauth:provider:openai-oauth',
      JSON.stringify(refreshed),
      HELPER_ID,
    );
  });
});
