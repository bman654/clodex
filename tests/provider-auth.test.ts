import { describe, expect, it, vi, beforeEach } from 'vitest';

const lockState = vi.hoisted(() => ({
  active: false,
  credentialActive: false,
}));

vi.mock('../src/ui.js', () => ({
  printOAuthStepsPanel: vi.fn(),
}));
vi.mock('../src/oauth/openai.js', () => ({
  runOpenAiDeviceCodeFlow: vi.fn(async () => ({
    tokens: { access_token: 'openai-access', refresh_token: 'openai-refresh', expires_in: 3600 },
    accountId: 'acct-123',
  })),
}));
vi.mock('../src/env.js', () => ({
  probeProviderCredentialStore: vi.fn(async () => true),
  saveProviderCredential: vi.fn(async () => false),
}));
vi.mock('../src/registry/io.js', () => ({
  loadRegistry: vi.fn(() => ({ version: 1, providers: [] })),
  saveRegistry: vi.fn(),
}));
vi.mock('../src/registry/refresh-models.js', () => ({
  refreshProviderModels: vi.fn(),
}));
vi.mock('../src/registry/lock.js', () => ({
  withRegistryWriteLock: vi.fn(async (operation: () => unknown) => {
    lockState.active = true;
    try {
      return await operation();
    } finally {
      lockState.active = false;
    }
  }),
  withCredentialMutationLock: vi.fn(async (
    _authRef: string,
    operation: () => unknown,
  ) => {
    lockState.credentialActive = true;
    try {
      return await operation();
    } finally {
      lockState.credentialActive = false;
    }
  }),
}));
vi.mock('@clack/prompts', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  select: vi.fn(),
  isCancel: vi.fn(() => false),
}));

import { probeProviderCredentialStore, saveProviderCredential } from '../src/env.js';
import { saveRegistry } from '../src/registry/io.js';
import { authenticateProvider } from '../src/registry/provider-auth.js';
import { runOpenAiDeviceCodeFlow } from '../src/oauth/openai.js';
import { refreshProviderModels } from '../src/registry/refresh-models.js';
import * as prompts from '@clack/prompts';

describe('authenticateProvider', () => {
  beforeEach(() => {
    vi.mocked(probeProviderCredentialStore).mockReset().mockResolvedValue(true);
    lockState.active = false;
    lockState.credentialActive = false;
    vi.mocked(saveProviderCredential).mockReset().mockResolvedValue(false);
    vi.mocked(saveRegistry).mockClear();
    vi.mocked(runOpenAiDeviceCodeFlow).mockClear();
    vi.mocked(refreshProviderModels).mockClear();
    vi.mocked(prompts.select).mockClear();
  });

  it('runs the OpenAI device-code flow and stores the openai-oauth registry entry', async () => {
    vi.mocked(saveProviderCredential).mockImplementationOnce(async () => {
      expect(lockState.active).toBe(false);
      expect(lockState.credentialActive).toBe(true);
      return true;
    });
    const result = await authenticateProvider('openai');

    expect(prompts.select).not.toHaveBeenCalled();
    expect(probeProviderCredentialStore).toHaveBeenCalledWith(
      'keyring:oauth:provider:openai-oauth',
      expect.any(Function),
    );
    expect(runOpenAiDeviceCodeFlow).toHaveBeenCalled();
    expect(saveRegistry).toHaveBeenCalled();
    expect(result.providerId).toBe('openai-oauth');
    expect(result.credential.access).toBe('openai-access');
    expect(result.registryProvider.name).toBe('OpenAI (ChatGPT)');
  });

  it('stops before device authorization when the credential store preflight fails', async () => {
    vi.mocked(probeProviderCredentialStore).mockImplementationOnce(async (_authRef, diagnostic) => {
      diagnostic?.('native keyring probe failed');
      return false;
    });
    await expect(authenticateProvider('openai')).rejects.toThrow(
      'Credential store is unavailable: native keyring probe failed. '
      + 'Set CLODEX_CREDENTIAL_HELPER to an absolute path to an external credential helper and try again.',
    );
    expect(runOpenAiDeviceCodeFlow).not.toHaveBeenCalled();
    expect(saveProviderCredential).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it('rejects before updating the registry or refreshing models when token persistence fails', async () => {
    vi.mocked(saveProviderCredential).mockImplementationOnce(async (_authRef, _credential, diagnostic) => {
      diagnostic?.('credential write failed');
      return false;
    });

    await expect(authenticateProvider('openai')).rejects.toThrow(
      'Could not save OAuth tokens to the credential store',
    );
    expect(saveProviderCredential).toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
    expect(refreshProviderModels).not.toHaveBeenCalled();
  });

  it('holds the registry lock only while persisting the provider entry', async () => {
    const observations: Array<[string, boolean]> = [];
    vi.mocked(saveProviderCredential).mockResolvedValueOnce(true);
    vi.mocked(runOpenAiDeviceCodeFlow).mockImplementationOnce(async () => {
      observations.push(['authorization', lockState.active]);
      return {
        tokens: { access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 },
        accountId: 'account-id',
      };
    });
    vi.mocked(saveRegistry).mockImplementationOnce(() => {
      observations.push(['registry-write', lockState.active]);
    });
    vi.mocked(refreshProviderModels).mockImplementationOnce(async () => {
      observations.push(['model-refresh', lockState.active]);
      return { id: 'openai-oauth', name: 'OpenAI', ok: true };
    });

    await authenticateProvider('openai');

    expect(observations).toEqual([
      ['authorization', false],
      ['registry-write', true],
      ['model-refresh', false],
    ]);
  });

  it('rejects non-OpenAI providers', async () => {
    await expect(authenticateProvider('xai')).rejects.toThrow('only available for openai');
  });
});
