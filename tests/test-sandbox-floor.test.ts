import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAppHome, getCredentialCleanupPath } from '../src/paths.js';
import { getCredentialMutationLockPath } from '../src/registry/lock.js';

function expectInsideVitestSandbox(candidate: string): void {
  const relativeToTemp = relative(resolve(tmpdir()), resolve(candidate));

  expect(relativeToTemp).not.toBe('');
  expect(relativeToTemp).not.toMatch(/^\.\.(?:[/\\]|$)/);
  expect(isAbsolute(relativeToTemp)).toBe(false);
  expect(relativeToTemp.split(/[/\\]/)).toContainEqual(
    expect.stringMatching(/^clodex-vitest-sandbox-/),
  );
}

describe('test sandbox floor', () => {
  it('keeps the default app home inside a Vitest temp sandbox', () => {
    expect(process.env.CLODEX_HOME).toBeDefined();
    const clodexHome = process.env.CLODEX_HOME!;
    const relativeToTemp = relative(resolve(tmpdir()), resolve(clodexHome));

    expect(relativeToTemp).not.toBe('');
    expect(relativeToTemp).not.toMatch(/^\.\.(?:[/\\]|$)/);
    expect(isAbsolute(relativeToTemp)).toBe(false);
    expect(basename(clodexHome)).toBe('clodex-home');
    expect(basename(dirname(clodexHome))).toMatch(/^clodex-vitest-sandbox-/);
    expect(getAppHome()).toBe(clodexHome);
    expect(getAppHome()).not.toBe(join(userInfo().homedir, '.clodex'));
  });

  // Credential locking and credential cleanup state are derived from CLODEX_HOME today, so these
  // assertions pass trivially. They exist to fail loudly if that derivation is ever relocated to
  // the real user home - `os.userInfo().homedir` in particular reads the OS account record and
  // ignores $HOME, so it would escape this sandbox and let the suite mutate a developer's own
  // credential state.
  it('keeps credential lock and cleanup state inside the same sandbox', () => {
    const realHome = userInfo().homedir;

    const lockPath = getCredentialMutationLockPath('openai-oauth:default');
    expectInsideVitestSandbox(lockPath);
    expect(relative(resolve(realHome), resolve(lockPath))).toMatch(/^\.\.(?:[/\\]|$)/);

    const cleanupPath = getCredentialCleanupPath();
    expectInsideVitestSandbox(cleanupPath);
    expect(relative(resolve(realHome), resolve(cleanupPath))).toMatch(/^\.\.(?:[/\\]|$)/);
  });
});
