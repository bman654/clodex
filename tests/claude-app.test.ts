import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/claude-desktop/app-session.js', () => ({
  readSessionLock: vi.fn(),
  recoverSession: vi.fn(),
  hasStaleSession: vi.fn(() => false),
  writeSessionLock: vi.fn(),
  setupExitCleanup: vi.fn(),
  cleanupSession: vi.fn(),
  backupMetaJson: vi.fn(),
  isConcurrentLiveSession: vi.fn(() => false),
  waitForShutdown: vi.fn(),
}));
vi.mock('../src/claude-desktop/app-launch.js', () => ({
  launchOrRestartClaudeApp: vi.fn(),
  claudeAppSupported: vi.fn(),
  isClaudeAppRunning: vi.fn(() => false),
  quitClaudeAppGracefully: vi.fn(),
}));

import { recoverSession } from '../src/claude-desktop/app-session.js';
import { runClaudeAppCommand } from '../src/claude-app.js';

describe('runClaudeAppCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('restores Claude Desktop config without requiring a TTY', async () => {
    const code = await runClaudeAppCommand(['--restore']);

    expect(code).toBe(0);
    expect(recoverSession).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Restored'));
  });
});
