// PR98 credential-security lens: does any account-slot display / error path
// emit the secret, the refresh token, or the ChatGPT account id?
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keyring = vi.hoisted(() => ({
  values: new Map<string, string>(),
  lockHome: '' as string,
}));

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    userInfo: () => ({ ...actual.userInfo(), homedir: keyring.lockHome || actual.userInfo().homedir }),
  };
});

vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    private readonly key: string;
    constructor(service: string, account: string) { this.key = `${service}:${account}`; }
    getPassword(): string | null { return keyring.values.get(this.key) ?? null; }
    setPassword(value: string): void { keyring.values.set(this.key, value); }
    deletePassword(): boolean { return keyring.values.delete(this.key); }
  },
  findCredentials: (service: string) => {
    const prefix = `${service}:`;
    return [...keyring.values.entries()].filter(([k]) => k.startsWith(prefix))
      .map(([k, password]) => ({ account: k.slice(prefix.length), password }));
  },
}));

import { saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import { getProvidersPath, getAppHome } from '../src/paths.js';
import { resolveActiveAccount, resolveProvidersForDisplay, formatRegistryAuthLabel } from '../src/provider-catalog.js';
import { accountSwitchOutcome, accountSwitchHint, accountSwitchServerRestartWarning } from '../src/providers-command.js';
import { applySelectedOAuthAccount, projectSelectedOAuthAccount } from '../src/registry/materialize.js';
import { refreshCredentialSnapshot } from '../src/registry/refresh-credentials.js';
import type { ProviderRegistry, RegistryProvider } from '../src/registry/types.js';

const SECRET = 'sk-' + 'proj-LEAKCANARY-0123456789abcdefghijklmnop';
const REFRESH = 'rt-LEAKCANARY-refreshtoken-zzzz';
const ACCOUNT_ID = 'CHATGPTACCTID-11111111-2222-3333-4444-555555555555';

const prevHome = process.env.CLODEX_HOME;
const prevRt = process.env.XDG_RUNTIME_DIR;
let tempDir = '';

const WORK_REF = 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:22222222222222222222222222222222';
const HOME_REF = 'keyring:oauth:provider:openai-oauth:account:home::credential::v1:33333333333333333333333333333333';
const DEF_REF = 'keyring:oauth:provider:openai-oauth::credential::v1:11111111111111111111111111111111';

function provider(overrides: Partial<RegistryProvider> = {}): RegistryProvider {
  return {
    id: 'openai-oauth',
    templateId: 'openai-oauth',
    name: 'OpenAI (ChatGPT)',
    enabled: true,
    authType: 'oauth',
    authRef: WORK_REF,
    defaultAuthRef: DEF_REF,
    activeAuthAccount: 'work',
    authAccounts: {
      work: { authRef: WORK_REF, addedAt: 'x', oauthAccountId: ACCOUNT_ID },
      home: { authRef: HOME_REF, addedAt: 'x' },
    },
    api: { npm: '@ai-sdk/openai', baseUrl: 'https://api.openai.com/v1' },
    addedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function scan(label: string, value: unknown): string[] {
  const text = JSON.stringify(value);
  const hits: string[] = [];
  for (const [name, canary] of [['SECRET', SECRET], ['REFRESH', REFRESH], ['ACCOUNT_ID', ACCOUNT_ID]] as const) {
    if (text.includes(canary)) hits.push(`${label} leaks ${name}`);
  }
  return hits;
}

describe('PR98 leak scan', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'clodex-pr98-leak-'));
    process.env.CLODEX_HOME = tempDir;
    process.env.XDG_RUNTIME_DIR = tempDir;
    keyring.lockHome = tempDir;
    keyring.values.clear();
    process.env.CLODEX_KEY_OPENAI_OAUTH = SECRET;
    keyring.values.set(
      `clodex:oauth:provider:openai-oauth:account:work::credential::v1:22222222222222222222222222222222`,
      JSON.stringify({ type: 'oauth', access: SECRET, refresh: REFRESH, expires: Date.now() + 3.6e6, accountId: ACCOUNT_ID }),
    );
  });

  afterEach(() => {
    delete process.env.CLODEX_KEY_OPENAI_OAUTH;
    delete process.env.CLODEX_OAUTH_ACCOUNT;
    if (prevHome === undefined) delete process.env.CLODEX_HOME; else process.env.CLODEX_HOME = prevHome;
    if (prevRt === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = prevRt;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('L1: display + snapshot surfaces never carry the secret or the refresh token', async () => {
    const reg: ProviderRegistry = { schemaVersion: 1, providers: [provider()] };
    withRegistryWriteLockSync(() => saveRegistry(reg));
    process.env.CLODEX_OAUTH_ACCOUNT = 'home';

    const hits: string[] = [];
    const p = provider();
    hits.push(...scan('resolveActiveAccount', resolveActiveAccount(p)));
    hits.push(...scan('applySelectedOAuthAccount', applySelectedOAuthAccount(p)));
    hits.push(...scan('projectSelectedOAuthAccount', projectSelectedOAuthAccount(p)));
    const snap = refreshCredentialSnapshot(p);
    hits.push(...scan('refreshCredentialSnapshot', snap));
    // eslint-disable-next-line no-console
    console.log('L1 snapshot =', JSON.stringify(snap, null, 2));
    hits.push(...scan('formatRegistryAuthLabel', formatRegistryAuthLabel(p)));
    const display = await resolveProvidersForDisplay();
    hits.push(...scan('resolveProvidersForDisplay', display));
    // eslint-disable-next-line no-console
    console.log('L1 display =', JSON.stringify(display, null, 2));
    const active = resolveActiveAccount(p);
    hits.push(...scan('accountSwitchOutcome', accountSwitchOutcome('OpenAI (ChatGPT)', 'work', active)));
    hits.push(...scan('accountSwitchHint', accountSwitchHint(p, active)));
    hits.push(...scan('restartWarning', accountSwitchServerRestartWarning(2)));
    // eslint-disable-next-line no-console
    console.log('L1 activeAccount =', JSON.stringify(active, null, 2));
    // eslint-disable-next-line no-console
    console.log('L1 switchOutcome =', JSON.stringify(accountSwitchOutcome('OpenAI (ChatGPT)', 'work', active)));

    // eslint-disable-next-line no-console
    console.log('L1 hits =', hits);
    expect(hits.filter(h => h.includes('SECRET') || h.includes('REFRESH'))).toEqual([]);
    // Report account-id exposure separately; it is an identifier, not a secret.
    // eslint-disable-next-line no-console
    console.log('L1 ACCOUNT_ID hits =', hits.filter(h => h.includes('ACCOUNT_ID')));
  });

  it('L2: error text from a missing-slot selection carries no secret', () => {
    const broken = provider({ activeAuthAccount: 'gone' });
    let msg = '';
    try { applySelectedOAuthAccount(broken, undefined); } catch (e) { msg = (e as Error).message; }
    // eslint-disable-next-line no-console
    console.log('L2 error =', msg);
    expect(msg).not.toContain(SECRET);
    expect(msg).not.toContain(REFRESH);
    expect(msg).not.toContain(ACCOUNT_ID);
    expect(msg).toContain('gone');
  });

  it('L3: nothing under CLODEX_HOME on disk contains the secret or refresh token', async () => {
    const reg: ProviderRegistry = { schemaVersion: 1, providers: [provider()] };
    withRegistryWriteLockSync(() => saveRegistry(reg));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name);
        if (name.isDirectory()) walk(full); else files.push(full);
      }
    };
    walk(getAppHome());
    const leaks = files.filter(f => {
      const t = readFileSync(f, 'utf8');
      return t.includes(SECRET) || t.includes(REFRESH);
    });
    const idFiles = files.filter(f => readFileSync(f, 'utf8').includes(ACCOUNT_ID));
    // eslint-disable-next-line no-console
    console.log('L3 files =', files.map(f => f.replace(tempDir, '')), 'secretLeaks =', leaks, 'accountIdIn =', idFiles.map(f => f.replace(tempDir, '')));
    expect(leaks).toEqual([]);
  });
});
