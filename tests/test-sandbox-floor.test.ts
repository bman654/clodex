import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getAppHome, getCredentialCleanupPath } from '../src/paths.js';
import {
  getCredentialLockRoot,
  getCredentialMutationLockPath,
  getCredentialStateRoot,
} from '../src/registry/lock.js';

function expectInsideVitestSandbox(candidate: string): void {
  const relativeToTemp = relative(resolve(tmpdir()), resolve(candidate));

  expect(relativeToTemp).not.toBe('');
  expect(relativeToTemp).not.toMatch(/^\.\.(?:[/\\]|$)/);
  expect(isAbsolute(relativeToTemp)).toBe(false);
  expect(relativeToTemp.split(/[/\\]/)).toContainEqual(
    expect.stringMatching(/^clodex-vitest-sandbox-/),
  );
}

function expectOutsideDirectory(candidate: string, directory: string): void {
  const relativeToDirectory = relative(resolve(directory), resolve(candidate));
  const insideOrEqual =
    relativeToDirectory === ''
    || (!relativeToDirectory.match(/^\.\.(?:[/\\]|$)/) && !isAbsolute(relativeToDirectory));

  expect(insideOrEqual).toBe(false);
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

  it('keeps credential coordination and cleanup state away from the real home', async () => {
    const actualOs = await vi.importActual<typeof import('node:os')>('node:os');
    const realUserHome = actualOs.userInfo().homedir;
    const coordinationPaths = [
      getCredentialLockRoot(),
      getCredentialMutationLockPath('keyring:test-account'),
      getCredentialStateRoot(),
      getCredentialCleanupPath(),
    ];

    expect(realUserHome).not.toBe(userInfo().homedir);
    for (const path of coordinationPaths) {
      expectInsideVitestSandbox(path);
      expectOutsideDirectory(path, realUserHome);
    }
  });
});
