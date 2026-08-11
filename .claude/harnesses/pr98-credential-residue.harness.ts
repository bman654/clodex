// PR98 credential-security lens harness: real keyring store + real cleanup
// journal + real registry io, driving named OAuth account slots end to end.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keyring = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failSetSuffix: '' as string,
  lockHome: '' as string,
}));

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    userInfo: () => ({
      ...actual.userInfo(),
      homedir: keyring.lockHome || actual.userInfo().homedir,
    }),
  };
});

vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    private readonly key: string;
    constructor(service: string, account: string) {
      this.key = `${service}:${account}`;
    }
    getPassword(): string | null {
      return keyring.values.get(this.key) ?? null;
    }
    setPassword(value: string): void {
      if (keyring.failSetSuffix && this.key.endsWith(keyring.failSetSuffix)) {
        throw new Error('injected keyring write failure');
      }
      keyring.values.set(this.key, value);
    }
    deletePassword(): boolean {
      return keyring.values.delete(this.key);
    }
  },
  findCredentials: (service: string) => {
    const prefix = `${service}:`;
    return [...keyring.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, password]) => ({ account: key.slice(prefix.length), password }));
  },
}));

import {
  deleteProviderCredential,
  provisionProviderCredential,
  resolveProviderCredential,
} from '../src/env.js';
import { saveRegistry, loadRegistry, loadRegistryStrict } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import { getProvidersPath } from '../src/paths.js';
import {
  queueCredentialDelete,
  reconcilePendingCredentialDeletes,
  journalCredentialWrite,
} from '../src/registry/credential-lifecycle.js';
import type { ProviderRegistry, RegistryProvider } from '../src/registry/types.js';

const previousHome = process.env.CLODEX_HOME;
const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
let tempDir = '';

function inst(n: string): string {
  return `v1:${n.repeat(32).slice(0, 32)}`;
}

const DEFAULT_ACCOUNT = `oauth:provider:openai-oauth::credential::${inst('1')}`;
const WORK_ACCOUNT = `oauth:provider:openai-oauth:account:work::credential::${inst('2')}`;
const HOME_ACCOUNT = `oauth:provider:openai-oauth:account:home::credential::${inst('3')}`;
const DEFAULT_REF = `keyring:${DEFAULT_ACCOUNT}`;
const WORK_REF = `keyring:${WORK_ACCOUNT}`;
const HOME_REF = `keyring:${HOME_ACCOUNT}`;

function oauthJson(access: string, refresh: string, accountId: string): string {
  return JSON.stringify({
    type: 'oauth',
    access,
    refresh,
    expires: Date.now() + 3_600_000,
    accountId,
  });
}

function residueFor(accountBase: string): string[] {
  return [...keyring.values.entries()]
    .filter(([key]) => key.includes(accountBase))
    .map(([key, value]) => `${key} => ${value.slice(0, 40)}`);
}

function allSecretsInStore(): string {
  return [...keyring.values.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
}

function baseProvider(): RegistryProvider {
  return {
    id: 'openai-oauth',
    templateId: 'openai-oauth',
    name: 'OpenAI (ChatGPT)',
    enabled: true,
    authType: 'oauth',
    authRef: DEFAULT_REF,
    api: { npm: '@ai-sdk/openai', baseUrl: 'https://api.openai.com/v1' },
    addedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('PR98 credential residue lens', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clodex-pr98-'));
    process.env.CLODEX_HOME = tempDir;
    process.env.XDG_RUNTIME_DIR = tempDir;
    keyring.lockHome = tempDir;
    keyring.values.clear();
    keyring.failSetSuffix = '';
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('E1: a large (chunked) slot credential round-trips and leaves no residue on delete', async () => {
    const big = oauthJson('A'.repeat(4000), 'R'.repeat(4000), 'acct-work-uuid');
    expect(await provisionProviderCredential(WORK_REF, big)).toBe(true);
    const chunkKeys = [...keyring.values.keys()].filter(k => k.includes('::chunk::'));
    // eslint-disable-next-line no-console
    console.log('E1 chunk keys after write:', chunkKeys.length, chunkKeys.slice(0, 4));
    expect(chunkKeys.length).toBeGreaterThan(0);
    expect(await resolveProviderCredential('openai-oauth', WORK_REF)).toBe('A'.repeat(4000));

    expect(await deleteProviderCredential(WORK_REF)).toBe(true);
    const residue = residueFor(WORK_ACCOUNT);
    // eslint-disable-next-line no-console
    console.log('E1 residue after delete:\n', residue.join('\n'));
    expect(residue.some(r => r.includes('AAAA'))).toBe(false);
    expect(residue.some(r => r.includes('RRRR'))).toBe(false);
    expect(residue.some(r => r.includes('acct-work-uuid'))).toBe(false);
    const dangling = [...keyring.values.keys()].filter(k => k.includes('::chunk::'));
    // eslint-disable-next-line no-console
    console.log('E1 dangling chunk keys:', dangling);
    expect(dangling).toEqual([]);
  });

  it('E2: deleting one slot leaves the sibling slot and the default intact', async () => {
    const bigWork = oauthJson('W'.repeat(4000), 'r1', 'acct-work');
    const bigHome = oauthJson('H'.repeat(4000), 'r2', 'acct-home');
    const def = oauthJson('D'.repeat(4000), 'r3', 'acct-default');
    expect(await provisionProviderCredential(WORK_REF, bigWork)).toBe(true);
    expect(await provisionProviderCredential(HOME_REF, bigHome)).toBe(true);
    expect(await provisionProviderCredential(DEFAULT_REF, def)).toBe(true);

    expect(await deleteProviderCredential(WORK_REF)).toBe(true);

    expect(await resolveProviderCredential('openai-oauth', HOME_REF)).toBe('H'.repeat(4000));
    expect(await resolveProviderCredential('openai-oauth', DEFAULT_REF)).toBe('D'.repeat(4000));
    expect(await resolveProviderCredential('openai-oauth', WORK_REF)).toBe(null);
    expect(allSecretsInStore()).not.toContain('WWWW');
  });

  it('E3: interrupted chunk write of a slot fails closed and does not corrupt the sibling', async () => {
    expect(await provisionProviderCredential(HOME_REF, oauthJson('H'.repeat(4000), 'r', 'a'))).toBe(true);
    keyring.failSetSuffix = '::2';
    const ok = await provisionProviderCredential(WORK_REF, oauthJson('W'.repeat(9000), 'r', 'a'));
    // eslint-disable-next-line no-console
    console.log('E3 provision result during injected failure:', ok);
    keyring.failSetSuffix = '';
    const work = await resolveProviderCredential('openai-oauth', WORK_REF).catch(e => `THREW:${e.message}`);
    // eslint-disable-next-line no-console
    console.log('E3 work resolves to:', typeof work === 'string' ? work.slice(0, 30) : work);
    expect(await resolveProviderCredential('openai-oauth', HOME_REF)).toBe('H'.repeat(4000));
  });

  it('E4: providers.json permissions + what an account slot writes in plaintext', async () => {
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        ...baseProvider(),
        authRef: WORK_REF,
        defaultAuthRef: DEFAULT_REF,
        activeAuthAccount: 'work',
        authAccounts: {
          work: { authRef: WORK_REF, addedAt: 'x', oauthAccountId: 'chatgpt-account-uuid-1234' },
          home: { authRef: HOME_REF, addedAt: 'x', oauthAccountId: 'chatgpt-account-uuid-5678' },
        },
      }],
    };
    withRegistryWriteLockSync(() => saveRegistry(registry));
    const path = getProvidersPath();
    const raw = readFileSync(path, 'utf8');
    const mode = statSync(path).mode & 0o777;
    // eslint-disable-next-line no-console
    console.log('E4 providers.json mode:', mode.toString(8));
    // eslint-disable-next-line no-console
    console.log('E4 providers.json content:\n', raw);
    expect(mode).toBe(0o600);
    expect(raw).toContain('chatgpt-account-uuid-1234');
    expect(JSON.parse(raw).schemaVersion).toBe(5);
  });

  it('E5: reconcile never deletes a slot credential that is still referenced', async () => {
    await provisionProviderCredential(WORK_REF, oauthJson('W'.repeat(100), 'r', 'a'));
    await provisionProviderCredential(DEFAULT_REF, oauthJson('D'.repeat(100), 'r', 'a'));
    const registry: ProviderRegistry = {
      schemaVersion: 1,
      providers: [{
        ...baseProvider(),
        authRef: WORK_REF,
        defaultAuthRef: DEFAULT_REF,
        activeAuthAccount: 'work',
        authAccounts: { work: { authRef: WORK_REF, addedAt: 'x' } },
      }],
    };
    withRegistryWriteLockSync(() => saveRegistry(registry));
    // Simulate a crash that journaled a delete for a still-live slot credential.
    expect(await queueCredentialDelete(WORK_REF)).toBe(true);
    const result = await reconcilePendingCredentialDeletes();
    // eslint-disable-next-line no-console
    console.log('E5 reconcile result:', JSON.stringify(result));
    expect(result.deleted).toEqual([]);
    expect(await resolveProviderCredential('openai-oauth', WORK_REF)).toBe('W'.repeat(100));
  });

  it('E6: journalCredentialWrite accepts a named slot ref (would throw pre-fix)', async () => {
    await expect(journalCredentialWrite(WORK_REF)).resolves.toBeUndefined();
  });
});

describe('PR98 slot re-add after removal', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clodex-pr98b-'));
    process.env.CLODEX_HOME = tempDir;
    process.env.XDG_RUNTIME_DIR = tempDir;
    keyring.lockHome = tempDir;
    keyring.values.clear();
    keyring.failSetSuffix = '';
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('E7: deleting then re-provisioning the SAME slot ref works (authRef is deterministic)', async () => {
    const first = oauthJson('F'.repeat(4000), 'r', 'id1');
    expect(await provisionProviderCredential(WORK_REF, first)).toBe(true);
    expect(await deleteProviderCredential(WORK_REF)).toBe(true);
    const second = oauthJson('S'.repeat(4000), 'r', 'id2');
    const ok = await provisionProviderCredential(WORK_REF, second);
    // eslint-disable-next-line no-console
    console.log('E7 re-provision =', ok);
    const read = await resolveProviderCredential('openai-oauth', WORK_REF);
    // eslint-disable-next-line no-console
    console.log('E7 reads back', read?.slice(0, 6), 'len', read?.length);
    expect(ok).toBe(true);
    expect(read).toBe('S'.repeat(4000));
    expect([...keyring.values.values()].some(v => v.includes('FFFF'))).toBe(false);
  });
});
