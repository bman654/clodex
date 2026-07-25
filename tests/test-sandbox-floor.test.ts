import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAppHome } from '../src/paths.js';
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

  it('keeps native credential coordination state inside the Vitest sandbox', () => {
    expectInsideVitestSandbox(getCredentialLockRoot());
    expectInsideVitestSandbox(getCredentialMutationLockPath('keyring:test-account'));
    expectInsideVitestSandbox(getCredentialStateRoot());
  });
});
