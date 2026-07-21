import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/oauth/refresh.js', () => ({
  oauthCredentialShouldRefresh: vi.fn((credential: { access?: string }) => credential.access === 'old-access'),
  refreshStoredOAuthCredential: vi.fn(async () => ({
    type: 'oauth',
    access: 'new-access',
    refresh: 'new-refresh',
    expires: Date.now() + 3_600_000,
  })),
}));

import {
  CREDENTIAL_HELPER_ENV,
  credentialAuthRef,
  readCredentialHelperAccount,
  writeCredentialHelperAccount,
} from '../src/credential-helper.js';
import {
  deleteProviderCredential,
  resolveProviderCredential,
  saveProviderCredential,
} from '../src/env.js';
import { oauthCredentialToKeychainJson } from '../src/oauth/types.js';
import { refreshStoredOAuthCredential } from '../src/oauth/refresh.js';
import { withRegistryWriteLock } from '../src/registry/lock.js';

const helperPath = fileURLToPath(new URL('./fixtures/credential-helper.mjs', import.meta.url));
let account = '';
let authRef = '';
const expiredCredential = oauthCredentialToKeychainJson({
  type: 'oauth',
  access: 'old-access',
  refresh: 'old-refresh',
  expires: 0,
});

function unexpiredCredential(access: string): string {
  return oauthCredentialToKeychainJson({
    type: 'oauth',
    access,
    refresh: `${access}-refresh`,
    expires: Date.now() + 3_600_000,
  });
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (!existsSync(path)) throw new Error(`Timed out waiting for ${path}`);
}

describe('OAuth credential-store refresh', () => {
  let tempDir = '';
  const previousHome = process.env.CLODEX_HOME;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'clodex-oauth-store-'));
    account = `oauth:provider:openai-oauth-${tempDir.split('-').at(-1)}`;
    process.env[CREDENTIAL_HELPER_ENV] = helperPath;
    process.env.CLODEX_HOME = tempDir;
    authRef = credentialAuthRef(account);
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE = join(tempDir, 'credentials.json');
    delete process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE;
    delete process.env.CLODEX_KEY_OPENAI_OAUTH;
    vi.mocked(refreshStoredOAuthCredential).mockReset().mockResolvedValue({
      type: 'oauth',
      access: 'new-access',
      refresh: 'new-refresh',
      expires: Date.now() + 3_600_000,
    });
    await writeCredentialHelperAccount(account, expiredCredential);
  });

  afterEach(() => {
    delete process.env[CREDENTIAL_HELPER_ENV];
    delete process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE;
    delete process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE;
    delete process.env.CLODEX_TEST_ENV_CREDENTIAL;
    delete process.env.CLODEX_KEY_OPENAI_OAUTH;
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists and verifies the rotated credential before returning its access token', async () => {
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBe('new-access');
    const stored = await readCredentialHelperAccount(account);
    expect(stored).toContain('new-refresh');
    expect(stored).not.toContain('old-refresh');
  });

  it('never decodes malformed OAuth JSON as a bearer token', async () => {
    await writeCredentialHelperAccount(account, JSON.stringify({
      type: 'oauth',
      refresh: 'sensitive-refresh-value',
      expires: Date.now() + 3_600_000,
    }));

    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBeNull();
  });

  it('never sends truncated structured credentials as bearer tokens', async () => {
    await writeCredentialHelperAccount(
      account,
      '{"type":"oauth","access":"partial-access","refresh":"sensitive-refresh-value"',
    );

    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBeNull();
  });

  it.each([
    {
      label: 'missing refresh token',
      credential: {
        type: 'oauth',
        access: 'partial-access',
        expires: Date.now() + 3_600_000,
      },
    },
    {
      label: 'missing expiration',
      credential: {
        type: 'oauth',
        access: 'partial-access',
        refresh: 'sensitive-refresh-value',
      },
    },
    {
      label: 'invalid rejection marker',
      credential: {
        type: 'oauth',
        access: 'partial-access',
        refresh: 'sensitive-refresh-value',
        expires: Date.now() + 3_600_000,
        accessRejected: false,
      },
    },
  ])('rejects an incomplete structured credential with $label', async ({ credential }) => {
    await writeCredentialHelperAccount(account, JSON.stringify(credential));

    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBeNull();
  });

  it('preserves a complete well-known token credential', async () => {
    await writeCredentialHelperAccount(account, JSON.stringify({
      type: 'wellknown',
      token: 'static-access',
    }));

    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBe('static-access');
  });

  it('serves the rotated token from memory without launching the helper again', async () => {
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBe('new-access');
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE = 'fail-get';
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBe('new-access');
    expect(refreshStoredOAuthCredential).toHaveBeenCalledTimes(1);
  });

  it('fails when a rotated credential cannot be persisted', async () => {
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE = 'fail-set';
    await expect(resolveProviderCredential('openai-oauth', authRef)).rejects.toThrow(
      'Could not persist refreshed OAuth credential',
    );
    delete process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE;
    await expect(readCredentialHelperAccount(account)).resolves.toBe(expiredCredential);
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBe('new-access');
    expect(refreshStoredOAuthCredential).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent refreshes per backend and account', async () => {
    const [first, second] = await Promise.all([
      resolveProviderCredential('openai-oauth', authRef),
      resolveProviderCredential('openai-oauth', authRef),
    ]);
    expect(first).toBe('new-access');
    expect(second).toBe('new-access');
    expect(refreshStoredOAuthCredential).toHaveBeenCalledTimes(1);
  });

  it('deduplicates before a delayed helper read can return a stale refresh token', async () => {
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE = 'delay-stale-read';
    const storePath = process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE!;
    const first = resolveProviderCredential('openai-oauth', authRef);
    await waitForPath(`${storePath}.stale-first-get`);
    const second = resolveProviderCredential('openai-oauth', authRef);

    await new Promise(resolve => setTimeout(resolve, 50));
    writeFileSync(`${storePath}.release-stale-get`, '', { encoding: 'utf8', mode: 0o600 });

    await expect(first).resolves.toBe('new-access');
    await expect(second).resolves.toBe('new-access');
    expect(refreshStoredOAuthCredential).toHaveBeenCalledTimes(1);
  });

  it('updates and clears the in-memory cache with explicit credential writes', async () => {
    const replacement = oauthCredentialToKeychainJson({
      type: 'oauth',
      access: 'replacement-access',
      refresh: 'replacement-refresh',
      expires: Date.now() + 3_600_000,
    });

    await expect(saveProviderCredential(authRef, replacement)).resolves.toBe(true);
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE = 'fail-get';
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBe('replacement-access');

    delete process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE;
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBeNull();
  });

  it('rereads an externally replaced credential after a cached token is rejected', async () => {
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBe('new-access');
    await writeCredentialHelperAccount(account, unexpiredCredential('external-access'));

    await expect(resolveProviderCredential(
      'openai-oauth',
      authRef,
      undefined,
      { rejectedAccessToken: 'new-access' },
    )).resolves.toBe('external-access');
    expect(refreshStoredOAuthCredential).toHaveBeenCalledTimes(1);
  });

  it('falls through to the stored credential when a rejected namespaced override remains set', async () => {
    process.env.CLODEX_KEY_OPENAI_OAUTH = 'rejected-env-access';
    await writeCredentialHelperAccount(account, unexpiredCredential('stored-access'));

    await expect(resolveProviderCredential(
      'openai-oauth',
      authRef,
      undefined,
      { rejectedAccessToken: 'rejected-env-access' },
    )).resolves.toBe('stored-access');
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBe('stored-access');

    process.env.CLODEX_KEY_OPENAI_OAUTH = 'changed-env-access';
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBe('changed-env-access');
  });

  it('remembers a rejected env-backed credential until its value changes', async () => {
    process.env.CLODEX_TEST_ENV_CREDENTIAL = 'rejected-env-access';

    await expect(resolveProviderCredential(
      'env-provider',
      'env:CLODEX_TEST_ENV_CREDENTIAL',
      undefined,
      { rejectedAccessToken: 'rejected-env-access' },
    )).resolves.toBeNull();
    await expect(resolveProviderCredential(
      'env-provider',
      'env:CLODEX_TEST_ENV_CREDENTIAL',
    )).resolves.toBeNull();

    process.env.CLODEX_TEST_ENV_CREDENTIAL = 'changed-env-access';
    await expect(resolveProviderCredential(
      'env-provider',
      'env:CLODEX_TEST_ENV_CREDENTIAL',
    )).resolves.toBe('changed-env-access');
  });

  it('refreshes an unexpired token when the upstream rejects it', async () => {
    await writeCredentialHelperAccount(account, unexpiredCredential('revoked-access'));
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBe('revoked-access');

    await expect(resolveProviderCredential(
      'openai-oauth',
      authRef,
      undefined,
      { rejectedAccessToken: 'revoked-access' },
    )).resolves.toBe('new-access');
    expect(refreshStoredOAuthCredential).toHaveBeenCalledTimes(1);
  });

  it('retains a rotated refresh token without reusing a rejected access token', async () => {
    await writeCredentialHelperAccount(account, unexpiredCredential('revoked-access'));
    vi.mocked(refreshStoredOAuthCredential).mockResolvedValue({
      type: 'oauth',
      access: 'revoked-access',
      refresh: 'rotated-refresh',
      expires: Date.now() + 3_600_000,
    });

    await expect(resolveProviderCredential(
      'openai-oauth',
      authRef,
      undefined,
      { rejectedAccessToken: 'revoked-access' },
    )).resolves.toBeNull();

    const stored = await readCredentialHelperAccount(account);
    expect(stored).toContain('rotated-refresh');
    expect(stored).toContain('"accessRejected":true');
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBeNull();
    expect(refreshStoredOAuthCredential).toHaveBeenCalledTimes(2);
  });

  it('does not replace one rejected access token with another rejected token', async () => {
    await writeCredentialHelperAccount(account, oauthCredentialToKeychainJson({
      type: 'oauth',
      access: 'stored-rejected-access',
      refresh: 'stored-refresh',
      expires: Date.now() + 3_600_000,
      accessRejected: true,
    }));
    vi.mocked(refreshStoredOAuthCredential).mockResolvedValue({
      type: 'oauth',
      access: 'request-rejected-access',
      refresh: 'rotated-refresh',
      expires: Date.now() + 3_600_000,
    });

    await expect(resolveProviderCredential(
      'openai-oauth',
      authRef,
      undefined,
      { rejectedAccessToken: 'request-rejected-access' },
    )).resolves.toBeNull();

    const stored = await readCredentialHelperAccount(account);
    expect(stored).toContain('request-rejected-access');
    expect(stored).toContain('"accessRejected":true');
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBeNull();
  });

  it('deduplicates concurrent rejected-token refreshes', async () => {
    await writeCredentialHelperAccount(account, unexpiredCredential('revoked-access'));
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBe('revoked-access');
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
    vi.mocked(refreshStoredOAuthCredential).mockImplementation(async () => {
      await refreshGate;
      return {
        type: 'oauth',
        access: 'new-access',
        refresh: 'new-refresh',
        expires: Date.now() + 3_600_000,
      };
    });

    const first = resolveProviderCredential(
      'openai-oauth',
      authRef,
      undefined,
      { rejectedAccessToken: 'revoked-access' },
    );
    const second = resolveProviderCredential(
      'openai-oauth',
      authRef,
      undefined,
      { rejectedAccessToken: 'revoked-access' },
    );
    await vi.waitFor(() => expect(refreshStoredOAuthCredential).toHaveBeenCalledTimes(1));
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual(['new-access', 'new-access']);
    expect(refreshStoredOAuthCredential).toHaveBeenCalledTimes(1);
  });

  it('does not hold the provider registry lock while OAuth refresh awaits the network', async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
    vi.mocked(refreshStoredOAuthCredential).mockImplementation(async () => {
      await refreshGate;
      return {
        type: 'oauth',
        access: 'new-access',
        refresh: 'new-refresh',
        expires: Date.now() + 3_600_000,
      };
    });

    const resolving = resolveProviderCredential('openai-oauth', authRef);
    await vi.waitFor(() => expect(refreshStoredOAuthCredential).toHaveBeenCalledTimes(1));
    await expect(withRegistryWriteLock(
      () => 'registry-write-completed',
      { waitMs: 100, retryMs: 5 },
    )).resolves.toBe('registry-write-completed');
    releaseRefresh();
    await expect(resolving).resolves.toBe('new-access');
  });

  it('never falls back to a rejected token after forced refresh failure', async () => {
    await writeCredentialHelperAccount(account, unexpiredCredential('revoked-access'));
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBe('revoked-access');
    vi.mocked(refreshStoredOAuthCredential).mockRejectedValueOnce(new Error('refresh rejected'));

    await expect(resolveProviderCredential(
      'openai-oauth',
      authRef,
      undefined,
      { rejectedAccessToken: 'revoked-access' },
    )).rejects.toThrow('refresh rejected');

    await writeCredentialHelperAccount(account, unexpiredCredential('external-access'));
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBe('external-access');
  });

  it('evicts the old cache before an uncertain credential write', async () => {
    await writeCredentialHelperAccount(account, unexpiredCredential('cached-access'));
    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBe('cached-access');
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE = 'fail-set';
    await expect(saveProviderCredential(authRef, unexpiredCredential('replacement-access'))).resolves.toBe(false);
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE = 'fail-get';

    await expect(resolveProviderCredential('openai-oauth', authRef)).resolves.toBeNull();
  });
});
