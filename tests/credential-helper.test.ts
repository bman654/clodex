import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_HELPER_ENV,
  configuredCredentialHelper,
  configuredCredentialHelperPath,
  credentialAccountBase,
  credentialAuthRef,
  credentialInstanceAuthRef,
  deleteCredentialHelperAccount,
  isCredentialAccountInstance,
  readCredentialHelperAccount,
  writeCredentialHelperAccount,
} from '../src/credential-helper.js';
import {
  deleteProviderCredential,
  probeProviderCredentialStore,
  provisionProviderCredential,
  resolveProviderCredential,
  saveProviderCredential,
} from '../src/env.js';
import { removeProviderFromRegistry } from '../src/registry/crud.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';

const helperPath = fileURLToPath(new URL('./fixtures/credential-helper.mjs', import.meta.url));
const previousClodexHome = process.env.CLODEX_HOME;

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (!existsSync(path)) throw new Error(`Timed out waiting for ${path}`);
}

describe('external credential helper', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clodex-credential-helper-'));
    process.env.CLODEX_HOME = tempDir;
    process.env[CREDENTIAL_HELPER_ENV] = helperPath;
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE = join(tempDir, 'credentials.json');
    delete process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE;
  });

  afterEach(() => {
    if (previousClodexHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousClodexHome;
    delete process.env[CREDENTIAL_HELPER_ENV];
    delete process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE;
    delete process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('selects helper auth refs only when an executable helper is configured', () => {
    expect(configuredCredentialHelperPath()).toBe(helperPath);
    const helper = configuredCredentialHelper();
    expect(helper).not.toBeNull();
    const authRef = credentialAuthRef('provider:openai');
    expect(authRef).toBe(`helper:v1:${helper!.id}:provider:openai`);
    expect(authRef).not.toContain(helperPath);
    const newAuthRef = credentialInstanceAuthRef('provider:openai');
    expect(newAuthRef).toMatch(
      new RegExp(`^helper:v1:${helper!.id}:provider:openai::credential::v1:[0-9a-f]{32}$`),
    );
    const newAccount = newAuthRef.slice(`helper:v1:${helper!.id}:`.length);
    expect(isCredentialAccountInstance(newAccount)).toBe(true);
    expect(credentialAccountBase(newAccount)).toBe('provider:openai');
    delete process.env[CREDENTIAL_HELPER_ENV];
    expect(credentialAuthRef('provider:openai')).toBe('keyring:provider:openai');
  });

  it('scopes provider-owned accounts to the config home without exposing its path', () => {
    const firstHome = join(tempDir, 'first-config');
    const secondHome = join(tempDir, 'second-config');
    process.env.CLODEX_HOME = firstHome;
    const first = credentialInstanceAuthRef('provider:openai');
    process.env.CLODEX_HOME = secondHome;
    const second = credentialInstanceAuthRef('provider:openai');

    expect(second).not.toBe(first);
    expect(first).not.toContain(firstHome);
    expect(second).not.toContain(secondHome);
    expect(first).toMatch(/::credential::v1:[0-9a-f]{32}$/);
    expect(second).toMatch(/::credential::v1:[0-9a-f]{32}$/);
  });

  it('rejects relative helper paths', () => {
    process.env[CREDENTIAL_HELPER_ENV] = 'credential-helper';
    expect(() => configuredCredentialHelperPath()).toThrow('absolute executable path');
  });

  it('rejects missing, directory, and non-executable helper paths', () => {
    process.env[CREDENTIAL_HELPER_ENV] = join(tempDir, 'missing-helper');
    expect(() => configuredCredentialHelperPath()).toThrow('not an executable file');

    process.env[CREDENTIAL_HELPER_ENV] = tempDir;
    expect(() => configuredCredentialHelperPath()).toThrow('must point to a file');

    const nonExecutable = join(tempDir, 'non-executable-helper');
    writeFileSync(nonExecutable, '#!/bin/sh\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    process.env[CREDENTIAL_HELPER_ENV] = nonExecutable;
    expect(() => configuredCredentialHelperPath()).toThrow('not an executable file');
  });

  it('round-trips opaque values without adding output whitespace', async () => {
    const value = '{"type":"oauth","access":"token","refresh":"rotating-token"}';
    await writeCredentialHelperAccount('oauth:provider:test', value);
    await expect(readCredentialHelperAccount('oauth:provider:test')).resolves.toBe(value);
    await deleteCredentialHelperAccount('oauth:provider:test');
    await expect(readCredentialHelperAccount('oauth:provider:test')).resolves.toBeNull();
  });

  it('writes and verifies helper-backed provider credentials', async () => {
    const authRef = credentialInstanceAuthRef('provider:test');
    await expect(provisionProviderCredential(authRef, 'secret-value')).resolves.toBe(true);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBe('secret-value');
    await expect(deleteProviderCredential(authRef)).resolves.toBe(true);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
  });

  it('removes a helper-backed credential with its provider', async () => {
    const authRef = credentialInstanceAuthRef('provider:openai');
    await expect(provisionProviderCredential(authRef, 'secret-value')).resolves.toBe(true);
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'openai',
      templateId: 'openai',
      name: 'OpenAI',
      enabled: true,
      authRef,
      authType: 'api',
      api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
      addedAt: '2026-07-21T00:00:00.000Z',
    });
    withRegistryWriteLockSync(() => saveRegistry(registry));

    const result = await removeProviderFromRegistry('openai');

    expect(result).toMatchObject({
      removed: true,
      credentialDeleted: true,
    });
    expect(loadRegistry().providers).toHaveLength(0);
    const account = authRef.slice(authRef.lastIndexOf(':provider:') + 1);
    await expect(readCredentialHelperAccount(account)).resolves.toBeNull();
  });

  it('probes the helper with a disposable round trip', async () => {
    await expect(
      probeProviderCredentialStore(credentialAuthRef('oauth:provider:test')),
    ).resolves.toBe(true);
  });

  it('fails the probe when its disposable credential cannot be removed', async () => {
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE = 'fail-delete';
    const diagnostics: string[] = [];
    await expect(probeProviderCredentialStore(credentialAuthRef('oauth:provider:test'), message => {
      diagnostics.push(message);
      }),
    ).resolves.toBe(false);
    expect(diagnostics).toContain('credential store probe cleanup failed');
  });

  it('rejects a helper write whose read-back does not match', async () => {
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE = 'mismatch';
    const diagnostics: string[] = [];
    await expect(
      provisionProviderCredential(
        credentialInstanceAuthRef('provider:test'),
        'secret-value',
        message => {
      diagnostics.push(message);
        },
      ),
    ).resolves.toBe(false);
    expect(diagnostics).toContain('credential store read-back verification failed');

    delete process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE;
    await expect(
      provisionProviderCredential(credentialInstanceAuthRef('provider:test'), 'secret-value'),
    ).resolves.toBe(true);
  });

  it('serializes concurrent writes to the same helper credential', async () => {
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE = 'detect-overlap';
    const authRef = credentialInstanceAuthRef('provider:test');
    const storePath = process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE!;

    const firstWrite = provisionProviderCredential(authRef, 'first-value');
    await waitForPath(`${storePath}.set-started`);
    const secondWrite = saveProviderCredential(authRef, 'second-value');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(existsSync(`${storePath}.overlapping-set`)).toBe(false);
    writeFileSync(`${storePath}.release-set`, '', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await expect(firstWrite).resolves.toBe(true);
    await expect(secondWrite).resolves.toBe(true);
    const account = authRef.slice(authRef.lastIndexOf(':provider:') + 1);
    await expect(readCredentialHelperAccount(account)).resolves.toBe('second-value');
  });

  it('does not silently fall back when the configured helper fails', async () => {
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE = 'fail';
    const diagnostics: string[] = [];
    await expect(
      provisionProviderCredential(
        credentialInstanceAuthRef('provider:test'),
        'secret-value',
        message => {
      diagnostics.push(message);
        },
      ),
    ).resolves.toBe(false);
    expect(diagnostics.join('\n')).toContain('credential helper set failed');
  });

  it('refuses to redirect a credential reference to a different helper path', async () => {
    const authRef = credentialInstanceAuthRef('provider:test');
    await expect(provisionProviderCredential(authRef, 'secret-value')).resolves.toBe(true);

    const replacementHelper = join(tempDir, 'replacement-helper.mjs');
    copyFileSync(helperPath, replacementHelper);
    chmodSync(replacementHelper, 0o700);
    process.env[CREDENTIAL_HELPER_ENV] = replacementHelper;
    const diagnostics: string[] = [];

    await expect(
      resolveProviderCredential('test', authRef, message => diagnostics.push(message)),
    ).resolves.toBeNull();
    await expect(
      deleteProviderCredential(authRef, message => diagnostics.push(message)),
    ).resolves.toBe(false);
    expect(diagnostics.join('\n')).toContain('does not match the helper that owns this credential');
  });

  it('force-kills a helper that exceeds the runtime limit', async () => {
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE = 'hang-ignore-term';
    const storePath = process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE!;
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers();
    try {
      const outcome = readCredentialHelperAccount('provider:test').catch(error => error);
      await new Promise(resolve => realSetTimeout(resolve, 100));
      const pid = Number.parseInt(readFileSync(`${storePath}.helper-pid`, 'utf8'), 10);

      await vi.advanceTimersByTimeAsync(10_001);
      await expect(outcome).resolves.toMatchObject({
        message: 'credential helper get timed out',
      });

      vi.useRealTimers();
      let running = true;
      const deadline = Date.now() + 2_000;
      while (running && Date.now() < deadline) {
        try {
          process.kill(pid, 0);
          await new Promise(resolve => realSetTimeout(resolve, 10));
        } catch {
          running = false;
        }
      }
      expect(running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
