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

/**
 * Poll a condition on a clock the fake timers are not driving. Callers under
 * `vi.useFakeTimers()` cannot use `waitForPath`: its `setTimeout` and `Date.now`
 * are both faked, so it would spin without ever yielding to the real world.
 * `performance.now()` keeps advancing, which is what makes the budget a real
 * wall-clock bound rather than a count of sleeps that each last longer than asked.
 */
async function pollOnRealClock(
  done: () => boolean,
  sleep: (ms: number) => Promise<void>,
  budgetMs: number,
): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (done()) return true;
    await sleep(5);
  }
  return done();
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

  it('serializes a delete behind an active helper credential write', async () => {
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE = 'detect-overlap';
    const authRef = credentialInstanceAuthRef('provider:test');
    const storePath = process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE!;

    const write = provisionProviderCredential(authRef, 'secret-value');
    await waitForPath(`${storePath}.set-started`);
    const deletion = deleteProviderCredential(authRef);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(existsSync(`${storePath}.overlapping-delete`)).toBe(false);
    writeFileSync(`${storePath}.release-set`, '', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await expect(write).resolves.toBe(true);
    await expect(deletion).resolves.toBe(true);
    await expect(resolveProviderCredential('test', authRef)).resolves.toBeNull();
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

  // The watchdog that force-kills a hung helper has to be disarmed when the helper
  // answers in time, or every successful credential read holds the event loop open
  // for the full timeout and the command appears to hang before it exits.
  it('disarms the runtime watchdog when the helper answers in time', async () => {
    await writeCredentialHelperAccount('provider:test', 'value');
    vi.useFakeTimers();
    try {
      await expect(readCredentialHelperAccount('provider:test')).resolves.toBe('value');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('force-kills a helper that exceeds the runtime limit', async () => {
    process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE = 'hang-ignore-term';
    const storePath = process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE!;
    const pidPath = `${storePath}.helper-pid`;
    const realSetTimeout = globalThis.setTimeout;
    const sleep = (ms: number): Promise<void> =>
      new Promise(resolve => { realSetTimeout(resolve, ms); });
    let pid = 0;
    vi.useFakeTimers();
    try {
      const outcome = readCredentialHelperAccount('provider:test').catch(error => error);

      // Wait for the helper to announce itself instead of guessing how long its
      // interpreter needs to boot: that took 322ms on an idle machine against the
      // 100ms this once allowed, and losing the race stranded the helper for the
      // life of the host rather than merely failing.
      await pollOnRealClock(() => existsSync(pidPath), sleep, 15_000);
      // Whole-file match, not `parseInt`: `parseInt('999999junk')` yields a pid this
      // test would then happily probe, passing on an unrelated process while its own
      // helper ran on. The range check matters for the same reason -- an over-long
      // run of digits becomes `Infinity`, which no `process.kill` can ever find.
      const announced = readFileSync(pidPath, 'utf8').trim();
      expect(announced).toMatch(/^[1-9][0-9]*$/);
      pid = Number(announced);
      expect(Number.isSafeInteger(pid)).toBe(true);

      await vi.advanceTimersByTimeAsync(10_001);
      await expect(outcome).resolves.toMatchObject({
        message: 'credential helper get timed out',
      });

      const exited = await pollOnRealClock(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, sleep, 5_000);
      expect(exited).toBe(true);
    } finally {
      // Fire a timeout still pending on the fake clock before that clock is torn
      // down, so a failure above still reaches the force-kill. Restoring real
      // timers discards pending fake ones silently, and the helper ignores SIGTERM,
      // so a skipped kill strands it until the fixture's own 60s fail-safe fires.
      await vi.advanceTimersByTimeAsync(10_001);
      vi.useRealTimers();
      if (Number.isInteger(pid) && pid > 0) {
        // Unreachable on a passing run: the assertion above is what proves the
        // helper is already gone.
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already reaped, which is the expected outcome.
        }
      }
    }
  }, 30_000);
});
