import { describe, expect, it, vi, beforeEach } from 'vitest';

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
import * as prompts from '@clack/prompts';

describe('authenticateProvider', () => {
  beforeEach(() => {
    vi.mocked(probeProviderCredentialStore).mockReset().mockResolvedValue(true);
    vi.mocked(saveProviderCredential).mockClear();
    vi.mocked(saveRegistry).mockClear();
    vi.mocked(runOpenAiDeviceCodeFlow).mockClear();
    vi.mocked(prompts.select).mockClear();
  });

  it('runs the OpenAI device-code flow and stores the openai-oauth registry entry', async () => {
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
    vi.mocked(probeProviderCredentialStore).mockResolvedValue(false);
    await expect(authenticateProvider('openai')).rejects.toThrow('Credential store is unavailable');
    expect(runOpenAiDeviceCodeFlow).not.toHaveBeenCalled();
    expect(saveProviderCredential).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  it('warns and continues when token persistence fails (graceful degradation)', async () => {
    const result = await authenticateProvider('openai');
    expect(saveProviderCredential).toHaveBeenCalled();
    expect(saveRegistry).toHaveBeenCalled();
    expect(result.providerId).toBe('openai-oauth');
  });

  it('rejects non-OpenAI providers', async () => {
    await expect(authenticateProvider('xai')).rejects.toThrow('only available for openai');
  });
});
