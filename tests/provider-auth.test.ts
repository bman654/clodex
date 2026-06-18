import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../src/opencode-serve.js', () => ({
  findOpencodeBinary: vi.fn(() => '/usr/local/bin/opencode'),
  fetchRawOpencodeProviders: vi.fn(async () => [{
    id: 'gitlab',
    name: 'GitLab',
    models: {
      claude: {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        api: { npm: 'gitlab-ai-provider', url: 'https://gitlab.example.com/v1' },
      },
    },
  }]),
}));
vi.mock('../src/registry/auth-broker.js', () => ({
  runOpencodeAuthBroker: vi.fn(async () => ({
    type: 'oauth',
    access: 'access-token',
    refresh: 'refresh-token',
    expires: Date.now() + 3600_000,
  })),
}));
vi.mock('../src/env.js', () => ({
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

import { saveProviderCredential } from '../src/env.js';
import { saveRegistry } from '../src/registry/io.js';
import { authenticateProvider } from '../src/registry/provider-auth.js';

describe('authenticateProvider', () => {
  beforeEach(() => {
    vi.mocked(saveProviderCredential).mockClear();
    vi.mocked(saveRegistry).mockClear();
  });

  it('warns and continues when token persistence fails (graceful degradation)', async () => {
    const result = await authenticateProvider('gitlab');
    expect(saveProviderCredential).toHaveBeenCalled();
    expect(saveRegistry).toHaveBeenCalled();
    expect(result.providerId).toBe('gitlab');
  });
});
