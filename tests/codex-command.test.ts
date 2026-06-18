import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkSessionLock: vi.fn(),
  recoverInterruptedCodexSession: vi.fn(() => ({ recovered: false })),
  restoreCodexOverlay: vi.fn(() => []),
  remainingOverlayPaths: vi.fn(() => []),
  writeOverlayFile: vi.fn(),
  writeSessionLock: vi.fn(),
  startCodexProxy: vi.fn(async () => ({ port: 61234, close: vi.fn() })),
  launchCodex: vi.fn(async () => 0),
}));

vi.mock('../src/codex/session.js', () => ({
  CODEX_PROFILE_NAME: 'relay-ai-launch',
  getCatalogPath: (providerId: string) => `/tmp/models-${providerId}.json`,
  getCodexProfilePath: () => '/tmp/relay-ai-launch.config.toml',
  getRelayAiCodexDir: () => '/tmp/relay-ai-codex',
  checkSessionLock: mocks.checkSessionLock,
  recoverInterruptedCodexSession: mocks.recoverInterruptedCodexSession,
  restoreCodexOverlay: mocks.restoreCodexOverlay,
  remainingOverlayPaths: mocks.remainingOverlayPaths,
  writeOverlayFile: mocks.writeOverlayFile,
  writeSessionLock: mocks.writeSessionLock,
}));

vi.mock('../src/codex/launch.js', () => ({
  findCodexBinary: vi.fn(() => '/usr/local/bin/codex'),
  buildCodexChildEnv: vi.fn(() => ({})),
  launchCodex: mocks.launchCodex,
}));

vi.mock('../src/codex-proxy.js', () => ({
  startCodexProxy: mocks.startCodexProxy,
}));

vi.mock('../src/server/vertex-config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/server/vertex-config.js')>();
  return {
    ...actual,
    hasApplicationDefaultCredentials: vi.fn(() => true),
    buildVertexRuntimeConfig: vi.fn(() => ({
      project: 'test-project',
      location: 'global',
      models: [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' }],
    })),
  };
});

vi.mock('@clack/prompts', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), success: vi.fn() },
  select: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

import { runCodexCommand } from '../src/codex.js';

describe('runCodexCommand vertex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recoverInterruptedCodexSession.mockReturnValue({ recovered: false });
    mocks.remainingOverlayPaths.mockReturnValue([]);
    mocks.launchCodex.mockResolvedValue(0);
    mocks.startCodexProxy.mockResolvedValue({ port: 61234, close: vi.fn() });
  });

  it('rejects vertex launch when a concurrent Codex session lock exists', async () => {
    mocks.checkSessionLock.mockReturnValue({
      ok: false,
      reason: 'concurrent',
      lock: { pid: 1234, startedAt: new Date().toISOString(), profilePath: '/tmp/x', catalogPaths: [] },
    });

    const code = await runCodexCommand([], false, { vertex: true });

    expect(code).toBe(1);
    expect(mocks.startCodexProxy).not.toHaveBeenCalled();
  });

  it('restores vertex overlay files after Codex exits', async () => {
    mocks.checkSessionLock.mockReturnValue({ ok: true });

    const code = await runCodexCommand([], false, { vertex: true });

    expect(code).toBe(0);
    expect(mocks.launchCodex).toHaveBeenCalled();
    expect(mocks.restoreCodexOverlay).toHaveBeenCalled();
  });
});
