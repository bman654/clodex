import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applySelectedOAuthAccount,
  materializeRegistry,
  projectSelectedOAuthAccount,
} from '../src/registry/materialize.js';
import {
  accountSwitchHint,
  accountSwitchOutcome,
  accountSwitchServerRestartWarning,
  shouldOfferAccountSwitch,
} from '../src/providers-command.js';
import { resolveActiveAccount } from '../src/provider-catalog.js';
import { emptyRegistry, loadRegistry, loadRegistryStrict, saveRegistry } from '../src/registry/io.js';
import { credentialIsReferenced } from '../src/registry/credential-lifecycle.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import { oauthProviderIdFromAccount } from '../src/env.js';
import type { RegistryModelsCache, RegistryProvider } from '../src/registry/types.js';

function modelsCache(...ids: string[]): RegistryModelsCache {
  return {
    fetchedAt: '2026-08-09T00:00:00.000Z',
    models: ids.map(id => ({
      id,
      name: id,
      upstreamModelId: id,
      modelFormat: 'openai' as const,
    })),
  };
}

const base: RegistryProvider = {
  id: 'openai-oauth',
  templateId: 'openai',
  name: 'OpenAI (ChatGPT)',
  enabled: true,
  authRef: 'keyring:oauth:provider:openai-oauth::credential::v1:default',
  authType: 'oauth',
  api: { npm: '@ai-sdk/openai', url: 'https://api.openai.com/v1' },
  addedAt: '2026-08-07T00:00:00.000Z',
};

const withSlots: RegistryProvider = {
  ...base,
  authAccounts: {
    work: { authRef: 'keyring:oauth:provider:openai-oauth:account:work::credential::v1:w', addedAt: '2026-08-07T00:00:00.000Z', oauthAccountId: 'acct-work' },
    alt: { authRef: 'keyring:oauth:provider:openai-oauth:account:alt::credential::v1:a', addedAt: '2026-08-07T00:00:00.000Z' },
  },
};

describe('applySelectedOAuthAccount', () => {
  it('returns the provider unchanged when no account is selected', () => {
    expect(applySelectedOAuthAccount(withSlots, undefined)).toBe(withSlots);
    expect(applySelectedOAuthAccount(withSlots, '')).toBe(withSlots);
    expect(applySelectedOAuthAccount(withSlots, '   ')).toBe(withSlots);
  });

  it('swaps the authRef for the selected slot without mutating the original', () => {
    const selected = applySelectedOAuthAccount(withSlots, 'work');
    expect(selected.authRef).toBe(withSlots.authAccounts!.work!.authRef);
    expect(selected).not.toBe(withSlots);
    expect(withSlots.authRef).toBe(base.authRef);
    // Everything else is untouched, so models/aliases/partitions are stable.
    expect(selected.id).toBe(withSlots.id);
    expect(selected.authAccounts).toBe(withSlots.authAccounts);
  });

  it('projects only the temporary account cache into runtime materialization', () => {
    const provider: RegistryProvider = {
      ...withSlots,
      activeAuthAccount: 'work',
      modelsCache: modelsCache('work-only'),
      authAccounts: {
        ...withSlots.authAccounts,
        work: { ...withSlots.authAccounts!.work!, modelsCache: modelsCache('work-only') },
        alt: { ...withSlots.authAccounts!.alt!, modelsCache: modelsCache('alt-only') },
      },
    };

    const selected = applySelectedOAuthAccount(provider, 'alt');
    expect(selected.modelsCache?.models.map(model => model.id)).toEqual(['alt-only']);
    expect(provider.modelsCache?.models.map(model => model.id)).toEqual(['work-only']);
    expect(materializeRegistry(
      { schemaVersion: 4, providers: [selected] },
      () => 'alt-token',
    )[0]?.models.map(model => model.id)).toEqual(['alt-only']);
  });

  it('fails closed instead of pairing a temporary account with another account cache', () => {
    const provider: RegistryProvider = {
      ...withSlots,
      activeAuthAccount: 'work',
      modelsCache: modelsCache('work-only'),
    };

    const selected = applySelectedOAuthAccount(provider, 'alt');
    expect(selected.modelsCache).toBeUndefined();
    expect(materializeRegistry(
      { schemaVersion: 3, providers: [selected] },
      () => 'alt-token',
    )).toEqual([]);
  });

  it('ignores the selector on providers without slots', () => {
    expect(applySelectedOAuthAccount(base, 'work')).toBe(base);
  });

  it('ignores the selector on non-oauth providers', () => {
    const apiProvider: RegistryProvider = { ...withSlots, authType: 'api' };
    expect(applySelectedOAuthAccount(apiProvider, 'work')).toBe(apiProvider);
  });

  it('fails loud when a slotted provider lacks the named slot', () => {
    expect(() => applySelectedOAuthAccount(withSlots, 'personal')).toThrow(
      /has no account named "personal" \(available: alt, work\)/,
    );
  });

  it('never resolves prototype names as slots', () => {
    // JSON-parsed registries carry Object.prototype; a selector like
    // "constructor" must be a missing-slot error, not a Function-valued slot.
    const parsed = JSON.parse(JSON.stringify(withSlots)) as RegistryProvider;
    expect(() => applySelectedOAuthAccount(parsed, 'constructor')).toThrow(/has no account named "constructor"/);
  });
});

describe('the stored account selection', () => {
  const withActive: RegistryProvider = { ...withSlots, activeAuthAccount: 'alt' };

  it('launches as the stored account when nothing is passed', () => {
    // The whole point of persisting it: no environment variable to remember,
    // and forgetting one no longer silently runs the default identity.
    expect(applySelectedOAuthAccount(withActive, undefined).authRef)
      .toBe(withSlots.authAccounts!.alt!.authRef);
  });

  it('lets an explicit selector override the stored one for a single run', () => {
    expect(applySelectedOAuthAccount(withActive, 'work').authRef)
      .toBe(withSlots.authAccounts!.work!.authRef);
    // ...without disturbing the stored choice every other launch reads.
    expect(withActive.activeAuthAccount).toBe('alt');
  });

  it('still returns the provider default when neither is set', () => {
    expect(applySelectedOAuthAccount(withSlots, undefined)).toBe(withSlots);
  });

  it('points a stale stored selector at the repair path, not the add path', () => {
    // Distinct from the environment message on purpose: this account was
    // chosen deliberately and its slot is gone, so the fix is to choose
    // again — and it must never quietly fall back to the default identity.
    const stale: RegistryProvider = { ...withSlots, activeAuthAccount: 'personal' };
    expect(() => applySelectedOAuthAccount(stale, undefined)).toThrow(
      /is set to use account "personal", which no longer exists \(available: alt, work\).*clodex providers/s,
    );
    expect(() => applySelectedOAuthAccount(stale, undefined)).not.toThrow(/CLODEX_OAUTH_ACCOUNT=/);
  });

  it('ignores a stored selector on a provider that cannot launch', () => {
    const disabled: RegistryProvider = { ...withSlots, enabled: false, activeAuthAccount: 'personal' };
    expect(applySelectedOAuthAccount(disabled, undefined)).toBe(disabled);
  });

  it('fails loudly when the stored selector has no slot table left at all', () => {
    // The registry serializes selector-only state as valid, so an empty or
    // absent slot table is reachable. Returning the provider default here
    // would run every launch as the wrong identity in silence — the whole
    // failure this feature exists to prevent.
    const orphaned: RegistryProvider = { ...base, activeAuthAccount: 'zachspartofaday' };
    expect(() => applySelectedOAuthAccount(orphaned, undefined)).toThrow(
      /has no named accounts.*clodex providers/s,
    );
    const emptyTable: RegistryProvider = { ...base, authAccounts: {}, activeAuthAccount: 'zachspartofaday' };
    expect(() => applySelectedOAuthAccount(emptyTable, undefined)).toThrow(/has no named accounts/);
  });

  it('an environment selector cannot mask an orphaned stored selection', () => {
    // Gating the orphan check on which selector WON conflated two things:
    // exporting the variable for any provider made every orphaned stored
    // selection resolve silently to the provider default — the exact
    // substitution the check exists to refuse. The environment cannot rescue a
    // broken stored selection anyway, since with no slot table it has nothing
    // to select either.
    const orphaned: RegistryProvider = { ...base, activeAuthAccount: 'zachspartofaday' };
    expect(() => applySelectedOAuthAccount(orphaned, 'anything')).toThrow(/has no named accounts/);
    // ...and the message names the STORED account, not whatever the variable said.
    expect(() => applySelectedOAuthAccount(orphaned, 'anything')).toThrow(/"zachspartofaday"/);
    expect(() => applySelectedOAuthAccount(orphaned, 'anything')).not.toThrow(/"anything"/);
  });

  it('still ignores an ENVIRONMENT selector on a provider with no slots', () => {
    // Unchanged contract: the variable only ever chooses among slots, and a
    // stale one must not take down a catalog load for providers that can run.
    expect(applySelectedOAuthAccount(base, 'zachspartofaday')).toBe(base);
  });
});

describe('selection on disabled providers', () => {
  it('ignores the selector on a disabled provider instead of throwing', () => {
    // A disabled slotted provider cannot participate in the launch; a stale
    // or mistyped CLODEX_OAUTH_ACCOUNT aimed at it must not take the whole
    // catalog load down for the providers that CAN launch.
    const disabled: RegistryProvider = { ...withSlots, enabled: false };
    expect(applySelectedOAuthAccount(disabled, 'personal')).toBe(disabled);
    // Enabled slotted providers keep the fail-loud contract.
    expect(() => applySelectedOAuthAccount(withSlots, 'personal')).toThrow(/has no account named/);
  });

  it('projects the catalog and credential a disabled OAuth provider will use when enabled', () => {
    const disabled: RegistryProvider = {
      ...withSlots,
      enabled: false,
      activeAuthAccount: 'work',
      modelsCache: modelsCache('work-only'),
      authAccounts: {
        ...withSlots.authAccounts,
        alt: { ...withSlots.authAccounts!.alt!, modelsCache: modelsCache('alt-only') },
      },
    };

    const projected = projectSelectedOAuthAccount(disabled, 'alt');

    expect(projected.enabled).toBe(false);
    expect(projected.authRef).toBe(withSlots.authAccounts!.alt!.authRef);
    expect(projected.modelsCache?.models.map(model => model.id)).toEqual(['alt-only']);
    expect(disabled.modelsCache?.models.map(model => model.id)).toEqual(['work-only']);
  });

  it('fails closed when a disabled OAuth provider projects a missing slot', () => {
    const disabled: RegistryProvider = { ...withSlots, enabled: false };
    expect(() => projectSelectedOAuthAccount(disabled, 'personal')).toThrow(/has no account named/);
  });

  it('does not reinterpret a disabled non-OAuth provider catalog', () => {
    const disabledApi: RegistryProvider = {
      ...withSlots,
      enabled: false,
      authType: 'api',
      modelsCache: modelsCache('api-only'),
    };
    expect(projectSelectedOAuthAccount(disabledApi, 'alt')).toBe(disabledApi);
  });
});

describe('authAccounts registry persistence', () => {
  let home = '';
  let path = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-account-slots-'));
    path = join(home, 'providers.json');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function registryWith(provider: unknown, schemaVersion = 1): string {
    return `${JSON.stringify({ schemaVersion, providers: [provider] }, null, 2)}\n`;
  }

  async function replaceRegistryWhileMigrationWaits<T>(
    replacement: string,
    operation: () => T,
  ): Promise<T> {
    const childScript = `
      const fs = require('node:fs');
      const [target, lock, encoded] = process.argv.slice(1);
      fs.writeFileSync(lock, JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
        token: 'migration-race',
      }), { mode: 0o600 });
      process.stdout.write('ready\\n');
      setTimeout(() => {
        try {
          fs.writeFileSync(target, Buffer.from(encoded, 'base64'));
        } finally {
          try { fs.unlinkSync(lock); } catch {}
        }
      }, 100);
    `;
    const child = spawn(process.execPath, [
      '-e',
      childScript,
      path,
      `${path}.lock`,
      Buffer.from(replacement).toString('base64'),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      child.once('error', reject);
      child.once('exit', code => {
        if (!ready) reject(new Error(`migration race helper exited early (${code ?? 'signal'})`));
      });
      child.stdout!.once('data', () => {
        ready = true;
        resolve();
      });
    });

    try {
      return operation();
    } finally {
      if (child.exitCode === null) {
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', () => resolve());
        });
      }
    }
  }

  it('named slots survive load → save-back → load', () => {
    writeFileSync(path, registryWith(withSlots));
    const loaded = loadRegistry(path);
    expect(loaded.providers[0]!.authAccounts).toEqual(withSlots.authAccounts);

    // A model refresh saves the PARSED provider back; the slots must not be
    // shed on that write, or the next launch silently reverts to the default
    // identity and reconciliation can delete the slot credential.
    withRegistryWriteLockSync(() => saveRegistry(loaded, path), { lockPath: `${path}.lock` });
    expect(loadRegistryStrict(path).providers[0]!.authAccounts).toEqual(withSlots.authAccounts);
  });

  it('persists account-specific caches behind the v4 writer fence without a selector', () => {
    const cachedProvider: RegistryProvider = {
      ...withSlots,
      authAccounts: {
        ...withSlots.authAccounts,
        work: { ...withSlots.authAccounts!.work!, modelsCache: modelsCache('work-only') },
        alt: { ...withSlots.authAccounts!.alt!, modelsCache: modelsCache('alt-only') },
      },
    };
    const registry = { ...emptyRegistry(), providers: [cachedProvider] };

    withRegistryWriteLockSync(() => saveRegistry(registry, path), { lockPath: `${path}.lock` });

    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(4);
    const loaded = loadRegistryStrict(path).providers[0]!;
    expect(loaded.authAccounts?.work?.modelsCache?.models[0]?.id).toBe('work-only');
    expect(loaded.authAccounts?.alt?.modelsCache?.models[0]?.id).toBe('alt-only');
  });

  it('fails closed on a malformed account-specific cache', () => {
    const malformed = {
      ...withSlots,
      authAccounts: {
        ...withSlots.authAccounts,
        work: { ...withSlots.authAccounts!.work!, modelsCache: { fetchedAt: 'now', models: [null] } },
      },
    };
    writeFileSync(path, registryWith(malformed));

    expect(loadRegistry(path).providers).toHaveLength(0);
    expect(() => loadRegistryStrict(path)).toThrow(/invalid provider entry/);
  });

  it('fails closed on a malformed slot instead of silently dropping it', () => {
    const malformed = {
      ...withSlots,
      authAccounts: { work: { addedAt: '2026-08-07T00:00:00.000Z' } }, // no authRef
    };
    writeFileSync(path, registryWith(malformed));
    // Lenient load rejects the whole provider record — a slot-less copy of a
    // slotted provider must never come back — and the strict load propagates.
    expect(loadRegistry(path).providers).toHaveLength(0);
    expect(() => loadRegistryStrict(path)).toThrow();
  });

  it('rejects slot names the auth flow could never have created', () => {
    const malformed = {
      ...withSlots,
      authAccounts: { 'Bad Name!': { authRef: 'keyring:x', addedAt: '2026-08-07T00:00:00.000Z' } },
    };
    writeFileSync(path, registryWith(malformed));
    expect(loadRegistry(path).providers).toHaveLength(0);
  });

  it('fences older writers: slot registries persist at schema v2, slot-free at v1', () => {
    writeFileSync(path, registryWith(withSlots));
    const loaded = loadRegistry(path);
    withRegistryWriteLockSync(() => saveRegistry(loaded, path), { lockPath: `${path}.lock` });
    // Older builds throw on an unknown schema version in every mutating path,
    // so they cannot strip the slots and save the providers back slot-less.
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(2);
    expect(loadRegistryStrict(path).providers[0]!.authAccounts).toEqual(withSlots.authAccounts);

    const slotFree = { ...loaded, providers: [{ ...loaded.providers[0]!, authAccounts: undefined }] };
    delete (slotFree.providers[0] as Record<string, unknown>).authAccounts;
    withRegistryWriteLockSync(() => saveRegistry(slotFree, path), { lockPath: `${path}.lock` });
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(1);

    writeFileSync(path, `${JSON.stringify({ schemaVersion: 9, providers: [] })}\n`);
    expect(() => loadRegistryStrict(path)).toThrow(/unsupported schema version/);
  });

  it('migrates a v3 selection, round-trips v5, and gives an old launch the selected identity', () => {
    writeFileSync(path, registryWith({ ...withSlots, activeAuthAccount: 'alt' }, 3));
    const loaded = loadRegistry(path);
    expect(loaded.providers[0]).toMatchObject({
      activeAuthAccount: 'alt',
      authRef: withSlots.authAccounts!.alt!.authRef,
      defaultAuthRef: base.authRef,
    });
    withRegistryWriteLockSync(() => saveRegistry(loaded, path), { lockPath: `${path}.lock` });
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    expect(persisted.schemaVersion).toBe(5);
    expect(persisted.providers[0]).toMatchObject({
      activeAuthAccount: 'alt',
      authRef: withSlots.authAccounts!.alt!.authRef,
      defaultAuthRef: base.authRef,
    });
    expect(loadRegistryStrict(path).providers[0]).toEqual(loaded.providers[0]);

    // Model the pre-selector lenient parser: it ignores schemaVersion and the
    // two selector fields, but retains authRef. The downgraded launch therefore
    // uses the selected identity instead of silently reverting to the default.
    expect({ authRef: persisted.providers[0].authRef }).toEqual({
      authRef: withSlots.authAccounts!.alt!.authRef,
    });

    const loadedAgain = loadRegistry(path);
    expect(loadedAgain.providers[0]).toEqual(loadRegistryStrict(path).providers[0]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(persisted);
  });

  it('fails closed when selected-identity migration cannot persist beside a malformed sibling', () => {
    const legacy = `${JSON.stringify({
      schemaVersion: 3,
      providers: [
        { ...withSlots, activeAuthAccount: 'alt' },
        {
          id: 'malformed-sibling',
          templateId: 'openai',
          name: 'Malformed sibling',
          enabled: true,
          // Missing authRef: the lenient parser drops this sibling, while the
          // authoritative strict reread under the migration lock rejects it.
          authType: 'api',
          api: { npm: '@ai-sdk/openai', url: 'https://api.example.test/v1' },
          addedAt: '2026-08-09T00:00:00.000Z',
        },
      ],
    }, null, 2)}\n`;
    writeFileSync(path, legacy);

    expect(() => loadRegistry(path)).toThrow(
      new RegExp(
        `Could not safely persist the selected OAuth account before launch.*${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
        + `.*invalid provider entry.*Repair it or restore ${`${path}.bak`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        's',
      ),
    );
    expect(readFileSync(path, 'utf8')).toBe(legacy);
  });

  it('classifies migration durability from the locked winner, not the stale pre-lock registry', async () => {
    const renameOnly = registryWith({ ...base, id: 'openai' });
    const selectedWinner = `${JSON.stringify({
      schemaVersion: 3,
      providers: [
        { ...withSlots, activeAuthAccount: 'alt' },
        { ...withSlots, id: 'broken-selector', activeAuthAccount: 'ghost' },
      ],
    }, null, 2)}\n`;
    writeFileSync(path, renameOnly);

    await expect(replaceRegistryWhileMigrationWaits(
      selectedWinner,
      () => loadRegistry(path),
    )).rejects.toThrow(/invalid OAuth account selection storage.*Repair it or restore.*providers\.json\.bak/s);
    expect(readFileSync(path, 'utf8')).toBe(selectedWinner);
  });

  it('gives registry-repair guidance for deterministic v5 publication validation failures', () => {
    const legacy = `${JSON.stringify({
      schemaVersion: 3,
      providers: [
        { ...withSlots, activeAuthAccount: 'alt' },
        { ...withSlots, id: 'broken-selector', activeAuthAccount: 'ghost' },
      ],
    }, null, 2)}\n`;
    writeFileSync(path, legacy);

    expect(() => loadRegistry(path)).toThrow(
      /invalid OAuth account selection storage.*Repair it or restore.*providers\.json\.bak/s,
    );
    expect(readFileSync(path, 'utf8')).toBe(legacy);
  });

  it('fails closed when a strict-invalid locked winner still contains a selected identity', async () => {
    const renameOnly = registryWith({ ...base, id: 'openai' });
    const selectedWinner = `${JSON.stringify({
      schemaVersion: 3,
      providers: [
        { ...withSlots, activeAuthAccount: 'alt' },
        {
          id: 'malformed-sibling',
          templateId: 'openai',
          name: 'Malformed sibling',
          enabled: true,
          authType: 'api',
          api: { npm: '@ai-sdk/openai', url: 'https://api.example.test/v1' },
          addedAt: '2026-08-09T00:00:00.000Z',
        },
      ],
    }, null, 2)}\n`;
    writeFileSync(path, renameOnly);

    await expect(replaceRegistryWhileMigrationWaits(
      selectedWinner,
      () => loadRegistry(path),
    )).rejects.toThrow(/Could not safely persist the selected OAuth account before launch/);
    expect(readFileSync(path, 'utf8')).toBe(selectedWinner);
  });

  it('fails closed when a strict-invalid v5 winner already materializes a selected identity', async () => {
    const renameOnly = registryWith({ ...base, id: 'openai' });
    const selectedWinner = `${JSON.stringify({
      schemaVersion: 5,
      providers: [
        {
          ...withSlots,
          activeAuthAccount: 'alt',
          authRef: withSlots.authAccounts!.alt!.authRef,
          defaultAuthRef: base.authRef,
        },
        {
          id: 'malformed-sibling',
          templateId: 'openai',
          name: 'Malformed sibling',
          enabled: true,
          authType: 'api',
          api: { npm: '@ai-sdk/openai', url: 'https://api.example.test/v1' },
          addedAt: '2026-08-09T00:00:00.000Z',
        },
      ],
    }, null, 2)}\n`;
    writeFileSync(path, renameOnly);

    await expect(replaceRegistryWhileMigrationWaits(
      selectedWinner,
      () => loadRegistry(path),
    )).rejects.toThrow(
      /Could not safely persist the selected OAuth account before launch.*invalid provider entry/s,
    );
    expect(readFileSync(path, 'utf8')).toBe(selectedWinner);
  });

  it('returns the locked winner when only its presentation migration cannot persist', async () => {
    const selectedInitial = registryWith({ ...withSlots, activeAuthAccount: 'alt' }, 3);
    const renameOnlyWinner = `${JSON.stringify({
      schemaVersion: 3,
      providers: [
        { ...base, id: 'openai' },
        { ...withSlots, id: 'broken-selector', activeAuthAccount: 'ghost' },
      ],
    }, null, 2)}\n`;
    writeFileSync(path, selectedInitial);

    const loaded = await replaceRegistryWhileMigrationWaits(
      renameOnlyWinner,
      () => loadRegistry(path),
    );

    expect(loaded.providers.map(provider => provider.id)).toEqual([
      'openai-oauth',
      'broken-selector',
    ]);
    expect(loaded.providers[0]?.defaultAuthRef).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe(renameOnlyWinner);
  });

  it('migrates v4 using only the selected slot cache and never claims an ambiguous top cache', () => {
    const selectedCache = modelsCache('selected-proven');
    const legacy = {
      ...withSlots,
      activeAuthAccount: 'work',
      modelsCache: modelsCache('ambiguous-top'),
      refreshedAt: '2026-08-09T01:00:00.000Z',
      authAccounts: {
        ...withSlots.authAccounts,
        work: { ...withSlots.authAccounts!.work!, modelsCache: selectedCache },
      },
    };
    writeFileSync(path, registryWith(legacy, 4));

    const loaded = loadRegistry(path).providers[0]!;
    expect(loaded.authRef).toBe(withSlots.authAccounts!.work!.authRef);
    expect(loaded.defaultAuthRef).toBe(base.authRef);
    expect(loaded.modelsCache).toEqual(selectedCache);
    expect(loaded.refreshedAt).toBe(selectedCache.fetchedAt);
    expect(loaded.authAccounts?.work?.modelsCache).toEqual(selectedCache);
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(5);
  });

  it('clears an unproven v3/v4 top cache when the selected slot has no owned cache', () => {
    for (const schemaVersion of [3, 4]) {
      writeFileSync(path, registryWith({
        ...withSlots,
        activeAuthAccount: 'work',
        modelsCache: modelsCache(`ambiguous-v${schemaVersion}`),
        refreshedAt: '2026-08-09T01:00:00.000Z',
      }, schemaVersion));

      const loaded = loadRegistry(path).providers[0]!;
      expect(loaded.defaultAuthRef).toBe(base.authRef);
      expect(loaded.authRef).toBe(withSlots.authAccounts!.work!.authRef);
      expect(loaded.modelsCache).toBeUndefined();
      expect(loaded.refreshedAt).toBeUndefined();
      expect(loaded.authAccounts?.work?.modelsCache).toBeUndefined();
    }
  });

  it('rejects a slot cache that appears before the v4 ownership fence', () => {
    const premature = {
      ...withSlots,
      activeAuthAccount: 'work',
      authAccounts: {
        ...withSlots.authAccounts,
        work: { ...withSlots.authAccounts!.work!, modelsCache: modelsCache('unfenced') },
      },
    };
    writeFileSync(path, registryWith(premature, 3));

    expect(loadRegistry(path).providers).toEqual([]);
    expect(() => loadRegistryStrict(path)).toThrow(/invalid provider entry/);
  });

  it.each([3, 4])(
    'never treats a present-invalid authType as a dormant selector in schema v%s',
    schemaVersion => {
      writeFileSync(path, registryWith({
        ...withSlots,
        authType: 'oath',
        activeAuthAccount: 'alt',
      }, schemaVersion));

      expect(loadRegistry(path).providers).toEqual([]);
      expect(() => loadRegistryStrict(path)).toThrow(/invalid provider entry/);
    },
  );

  it('keeps a stale-but-well-formed selection loadable so the provider can be repaired', () => {
    // Rejecting it at load would drop the provider record entirely, so the
    // account would vanish from `clodex providers` — the one screen that can
    // fix it. It has to survive the load and fail when a launch applies it.
    writeFileSync(path, registryWith({ ...withSlots, activeAuthAccount: 'ghost' }, 3));
    const loaded = loadRegistry(path);
    expect(loaded.providers).toHaveLength(1);
    expect(loaded.providers[0]!.activeAuthAccount).toBe('ghost');
    expect(loaded.providers[0]!.defaultAuthRef).toBeUndefined();
    expect(loaded.providers[0]!.authRef).toBe(base.authRef);
    // No v5 bytes are published without a selected slot to project.
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(3);
    expect(() => applySelectedOAuthAccount(loaded.providers[0]!, undefined)).toThrow(/no longer exists/);
  });

  it('does not migrate or auto-write a missing prototype-named legacy slot', () => {
    const legacy = registryWith({ ...withSlots, activeAuthAccount: 'constructor' }, 3);
    writeFileSync(path, legacy);

    const loaded = loadRegistry(path);

    expect(readFileSync(path, 'utf8')).toBe(legacy);
    expect(loaded.providers[0]).toMatchObject({
      activeAuthAccount: 'constructor',
      authRef: base.authRef,
    });
    expect(loaded.providers[0]?.defaultAuthRef).toBeUndefined();
    expect(() => applySelectedOAuthAccount(loaded.providers[0]!, undefined))
      .toThrow(/no longer exists/);
  });

  it('migrates a legitimate own prototype-named slot', () => {
    const constructorSlot = {
      authRef: 'keyring:oauth:provider:openai-oauth:account:constructor::credential::v1:c',
      addedAt: '2026-08-09T00:00:00.000Z',
    };
    writeFileSync(path, registryWith({
      ...withSlots,
      activeAuthAccount: 'constructor',
      authAccounts: { ...withSlots.authAccounts, constructor: constructorSlot },
    }, 3));

    const loaded = loadRegistry(path).providers[0]!;

    expect(loaded).toMatchObject({
      activeAuthAccount: 'constructor',
      authRef: constructorSlot.authRef,
      defaultAuthRef: base.authRef,
    });
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(5);
  });

  it('fails closed on a selection the picker could never have written', () => {
    writeFileSync(path, registryWith({ ...withSlots, activeAuthAccount: 'Bad Name!' }, 3));
    expect(loadRegistry(path).providers).toHaveLength(0);
    expect(() => loadRegistryStrict(path)).toThrow();
  });

  it('fences materialized selection storage behind schema v5', () => {
    // Version 2 is not a fence for this: a build from before the selector
    // existed ACCEPTS 2, parses the slots, drops the unknown
    // `activeAuthAccount`, and saves back without it — after which every
    // launch quietly reverts to the provider default. Only a version that
    // build rejects actually protects the selection.
    const registry = {
      schemaVersion: 3,
      providers: [{ ...withSlots, activeAuthAccount: 'alt' } as RegistryProvider],
    };
    withRegistryWriteLockSync(() => saveRegistry(registry, path), { lockPath: `${path}.lock` });
    const selected = JSON.parse(readFileSync(path, 'utf8'));
    expect(selected.schemaVersion).toBe(5);
    expect(selected.providers[0]).toMatchObject({
      activeAuthAccount: 'alt',
      authRef: withSlots.authAccounts!.alt!.authRef,
      defaultAuthRef: base.authRef,
    });
    expect(loadRegistryStrict(path).providers[0]!.activeAuthAccount).toBe('alt');

    // Clearing the selection returns to the slot version, so older builds
    // interoperate again the moment no selector state exists.
    const cleared = { ...emptyRegistry(), providers: [structuredClone(withSlots)] };
    withRegistryWriteLockSync(() => saveRegistry(cleared, path), { lockPath: `${path}.lock` });
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(2);
  });

  it('rejects a schema version newer than this build understands', () => {
    writeFileSync(path, `${JSON.stringify({ schemaVersion: 6, providers: [] })}\n`);
    expect(() => loadRegistryStrict(path)).toThrow(/unsupported schema version/);
  });

  it.each([
    ['missing parked default', {
      ...withSlots,
      activeAuthAccount: 'alt',
      authRef: withSlots.authAccounts!.alt!.authRef,
    }],
    ['parked default without selector', { ...withSlots, defaultAuthRef: base.authRef }],
    ['missing selected slot', {
      ...withSlots,
      activeAuthAccount: 'ghost',
      authRef: withSlots.authAccounts!.alt!.authRef,
      defaultAuthRef: base.authRef,
    }],
    ['missing own prototype-named slot', {
      ...withSlots,
      activeAuthAccount: 'constructor',
      authRef: withSlots.authAccounts!.alt!.authRef,
      defaultAuthRef: base.authRef,
    }],
    ['top ref does not match selected slot', {
      ...withSlots,
      activeAuthAccount: 'alt',
      authRef: withSlots.authAccounts!.work!.authRef,
      defaultAuthRef: base.authRef,
    }],
    ['top cache is not owned by selected slot', {
      ...withSlots,
      activeAuthAccount: 'alt',
      authRef: withSlots.authAccounts!.alt!.authRef,
      defaultAuthRef: base.authRef,
      modelsCache: modelsCache('wrong-owner'),
    }],
  ])('fails closed on malformed v5 selection storage: %s', (_name, provider) => {
    writeFileSync(path, registryWith(provider, 5));
    expect(loadRegistry(path).providers).toEqual([]);
    expect(() => loadRegistryStrict(path)).toThrow(/invalid provider entry/);
  });

  it('refuses to serialize an unmaterialized selector instead of guessing its default', () => {
    const ambiguous = {
      schemaVersion: 2,
      providers: [{ ...withSlots, activeAuthAccount: 'alt' } as RegistryProvider],
    };
    expect(() => withRegistryWriteLockSync(
      () => saveRegistry(ambiguous, path),
      { lockPath: `${path}.lock` },
    )).toThrow(/invalid OAuth account selection storage/);
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });

  it('validates the exact serialized provider shape before publication', () => {
    const missingAuthRef = { ...base, authRef: undefined } as unknown as RegistryProvider;
    expect(() => withRegistryWriteLockSync(
      () => saveRegistry({ schemaVersion: 1, providers: [missingAuthRef] }, path),
      { lockPath: `${path}.lock` },
    )).toThrow(/invalid provider entry/);
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });

  it('allows a dormant non-OAuth selector alongside a materialized OAuth provider', () => {
    const selected: RegistryProvider = {
      ...withSlots,
      activeAuthAccount: 'alt',
      authRef: withSlots.authAccounts!.alt!.authRef,
      defaultAuthRef: base.authRef,
    };
    const dormant: RegistryProvider = {
      ...withSlots,
      id: 'dormant-api',
      authType: 'api',
      activeAuthAccount: 'ghost',
    };
    const registry = { schemaVersion: 5, providers: [selected, dormant] };

    withRegistryWriteLockSync(() => saveRegistry(registry, path), { lockPath: `${path}.lock` });

    const loaded = loadRegistryStrict(path);
    expect(loaded.schemaVersion).toBe(5);
    expect(loaded.providers[1]).toMatchObject({
      id: 'dormant-api',
      activeAuthAccount: 'ghost',
      authRef: base.authRef,
    });
    expect(loaded.providers[1]?.defaultAuthRef).toBeUndefined();
  });

  it('slot credentials count as live references for reconciliation', () => {
    const selected: RegistryProvider = {
      ...withSlots,
      activeAuthAccount: 'alt',
      authRef: withSlots.authAccounts!.alt!.authRef,
      defaultAuthRef: base.authRef,
    };
    const registry = { schemaVersion: 5, providers: [selected] };
    expect(credentialIsReferenced(registry, withSlots.authAccounts!.work!.authRef)).toBe(true);
    expect(credentialIsReferenced(registry, withSlots.authAccounts!.alt!.authRef)).toBe(true);
    expect(credentialIsReferenced(registry, base.authRef)).toBe(true);
    expect(credentialIsReferenced(registry, 'keyring:oauth:provider:openai-oauth:account:gone::credential::v1:x')).toBe(false);
  });
});

describe('oauthProviderIdFromAccount', () => {
  it('collapses a named slot to the base provider id used by token refresh', () => {
    // refreshStoredOAuthCredential supports exact provider ids only; a slot
    // suffix leaking through meant named accounts failed with "OAuth refresh
    // not implemented" the first time their access token expired.
    expect(oauthProviderIdFromAccount('oauth:provider:openai-oauth:account:work::credential::v1:w')).toBe('openai-oauth');
    expect(oauthProviderIdFromAccount('oauth:provider:openai-oauth:account:work')).toBe('openai-oauth');
    expect(oauthProviderIdFromAccount('oauth:provider:openai-oauth')).toBe('openai-oauth');
    expect(oauthProviderIdFromAccount('provider:openai')).toBeNull();
  });
});

describe('shouldOfferAccountSwitch', () => {
  it('offers the switch when slots exist', () => {
    expect(shouldOfferAccountSwitch({ authAccounts: { zachspartofaday: { authRef: 'k', addedAt: 'x' } } })).toBe(true);
  });

  it('offers the switch for an ORPHANED selector, so the advertised repair is reachable', () => {
    // Launch now throws for this state and tells the user to fix it with
    // `clodex providers`. Gating the action on slots would hide that repair and
    // leave re-authenticating or hand-editing the registry as the only ways out.
    expect(shouldOfferAccountSwitch({ activeAuthAccount: 'zachspartofaday' })).toBe(true);
    expect(shouldOfferAccountSwitch({ authAccounts: {}, activeAuthAccount: 'zachspartofaday' })).toBe(true);
  });

  it('stays hidden for a provider with neither', () => {
    expect(shouldOfferAccountSwitch({})).toBe(false);
    expect(shouldOfferAccountSwitch({ authAccounts: {} })).toBe(false);
  });
});

describe('resolveActiveAccount', () => {
  const oauth = { ...withSlots, activeAuthAccount: 'alt' } as RegistryProvider;

  it('reports the stored selection when nothing overrides it', () => {
    expect(resolveActiveAccount(oauth, {})).toEqual({ kind: 'slot', name: 'alt', fromEnvironment: false });
  });

  it('reports the environment override, which is what a launch will use', () => {
    expect(resolveActiveAccount(oauth, { CLODEX_OAUTH_ACCOUNT: 'work' }))
      .toEqual({ kind: 'slot', name: 'work', fromEnvironment: true });
  });

  it('reports BROKEN for a selector the launch will throw on', () => {
    // The state the previous shape could not express. Returning a plain name
    // here promised a launch that does not happen: the detail hint read it as
    // "every launch uses ghost" while applySelectedOAuthAccount threw.
    expect(resolveActiveAccount({ ...withSlots, activeAuthAccount: 'ghost' }, {}))
      .toEqual({ kind: 'broken', name: 'ghost', fromEnvironment: false });
    expect(resolveActiveAccount(oauth, { CLODEX_OAUTH_ACCOUNT: 'ghost' }))
      .toEqual({ kind: 'broken', name: 'ghost', fromEnvironment: true });
  });

  it('never calls a selection fine when a launch would throw on it', () => {
    // One-directional on purpose. `applySelectedOAuthAccount` deliberately does
    // NOT throw for a provider that cannot launch — a stale selector must not
    // take down a catalog load — but such a selection is equally unhonourable,
    // and calling it fine means the listing looks healthy right up until the
    // provider is enabled. So: anything that would throw is reported broken;
    // not everything reported broken throws today.
    const cases: Array<[string, RegistryProvider, NodeJS.ProcessEnv]> = [
      ['healthy stored', oauth, {}],
      ['healthy env', oauth, { CLODEX_OAUTH_ACCOUNT: 'work' }],
      ['orphaned stored, slots remain', { ...withSlots, activeAuthAccount: 'ghost' }, {}],
      ['env names a missing slot', oauth, { CLODEX_OAUTH_ACCOUNT: 'ghost' }],
      ['orphaned stored, no slots', { ...base, activeAuthAccount: 'ghost' }, {}],
      ['no selection at all', withSlots, {}],
      ['env on a provider with no slots', base, { CLODEX_OAUTH_ACCOUNT: 'work' }],
      ['disabled provider, orphaned', { ...withSlots, enabled: false, activeAuthAccount: 'ghost' }, {}],
      ['non-oauth provider, orphaned', { ...withSlots, authType: 'api', activeAuthAccount: 'ghost' }, {}],
    ];
    for (const [label, provider, env] of cases) {
      const shown = resolveActiveAccount(provider, env);
      let launchThrew = false;
      try {
        applySelectedOAuthAccount(provider, env.CLODEX_OAUTH_ACCOUNT);
      } catch {
        launchThrew = true;
      }
      if (launchThrew) {
        expect(shown.kind, `${label}: launch throws, so the display must say broken`).toBe('broken');
      }
    }
  });

  it('reports a latent orphan on a provider that cannot launch yet', () => {
    // The gap this closes: the early return for a disabled or non-OAuth
    // provider handed back `{ kind: 'slot' }` without checking membership, so
    // an orphaned selection was invisible until someone enabled the provider
    // and every launch began failing.
    for (const [provider, inactiveReason] of [
      [{ ...withSlots, enabled: false, activeAuthAccount: 'ghost' }, 'disabled'],
      [{ ...withSlots, authType: 'api' as const, activeAuthAccount: 'ghost' }, 'non-oauth'],
    ] as const) {
      expect(resolveActiveAccount(provider as RegistryProvider, {}))
        .toEqual({ kind: 'broken', name: 'ghost', fromEnvironment: false, inactiveReason });
      // ...and it still does not throw, which is why the property above is
      // one-directional rather than an iff.
      expect(() => applySelectedOAuthAccount(provider as RegistryProvider, undefined)).not.toThrow();
    }
    // A healthy selection on a disabled provider is still just a slot.
    expect(resolveActiveAccount({ ...withSlots, enabled: false, activeAuthAccount: 'work' } as RegistryProvider, {}))
      .toEqual({ kind: 'slot', name: 'work', fromEnvironment: false, inactiveReason: 'disabled' });
  });

  it('keeps a stored orphan visible when an override is masking it', () => {
    // The override hides the breakage only while the variable is set. Reporting
    // just the live answer made the listing and the hint read healthy right up
    // until someone opened a shell without it, at which point every launch
    // failed on a selection nothing had ever mentioned.
    const masked = { ...withSlots, activeAuthAccount: 'ghost' } as RegistryProvider;
    expect(resolveActiveAccount(masked, { CLODEX_OAUTH_ACCOUNT: 'work' }))
      .toEqual({ kind: 'slot', name: 'work', fromEnvironment: true, latentOrphan: 'ghost' });
    // Unset the variable and the same registry is openly broken.
    expect(resolveActiveAccount(masked, {}))
      .toEqual({ kind: 'broken', name: 'ghost', fromEnvironment: false });
  });

  it('keeps BOTH failures visible when the override is broken too', () => {
    // Two independent breakages at once. Reporting only the override meant
    // unsetting the variable traded one unexplained failure for another —
    // the stored selection behind it was never mentioned.
    const both = { ...withSlots, activeAuthAccount: 'ghost' } as RegistryProvider;
    expect(resolveActiveAccount(both, { CLODEX_OAUTH_ACCOUNT: 'phantom' }))
      .toEqual({ kind: 'broken', name: 'phantom', fromEnvironment: true, latentOrphan: 'ghost' });
    // The hint says both, so fixing the variable is not a surprise halfway.
    expect(accountSwitchHint(
      { activeAuthAccount: 'ghost' },
      { kind: 'broken', name: 'phantom', fromEnvironment: true, latentOrphan: 'ghost' },
    )).toContain('stored "ghost" is missing too');
  });

  it('does not duplicate the name when only the stored selection is broken', () => {
    // The broken name IS the stored one here; repeating it as a latent orphan
    // would report one failure as two.
    expect(resolveActiveAccount({ ...withSlots, activeAuthAccount: 'ghost' } as RegistryProvider, {}))
      .toEqual({ kind: 'broken', name: 'ghost', fromEnvironment: false });
  });

  it('does not invent a latent orphan for a healthy stored selection', () => {
    expect(resolveActiveAccount(oauth, { CLODEX_OAUTH_ACCOUNT: 'work' }))
      .toEqual({ kind: 'slot', name: 'work', fromEnvironment: true });
  });

  it('phrases a dormant provider as saved state, not a live outcome', () => {
    // "every launch fails" is untrue of a provider that is not launching:
    // applySelectedOAuthAccount returns it untouched and materialization
    // excludes it. The selection still matters — it will start failing the
    // moment the provider is enabled — so it is reported, differently.
    const dormant = resolveActiveAccount(
      { ...withSlots, enabled: false, activeAuthAccount: 'ghost' } as RegistryProvider, {},
    );
    expect(dormant).toMatchObject({ kind: 'broken', inactiveReason: 'disabled' });
    const hint = accountSwitchHint({ activeAuthAccount: 'ghost' }, dormant);
    expect(hint).toContain('enabling this provider will fail');
    expect(hint).not.toContain('every launch fails');
  });

  it('does not report one broken selection as two', () => {
    // Stored and override naming the SAME missing slot is a single failure.
    // Carrying it as a latent orphan as well rendered `ghost` twice and made
    // the hint say the stored account was missing "too".
    const both = { ...withSlots, activeAuthAccount: 'ghost' } as RegistryProvider;
    expect(resolveActiveAccount(both, { CLODEX_OAUTH_ACCOUNT: 'ghost' }))
      .toEqual({ kind: 'broken', name: 'ghost', fromEnvironment: true });
    // Two DIFFERENT missing names remain two failures.
    expect(resolveActiveAccount(both, { CLODEX_OAUTH_ACCOUNT: 'phantom' }))
      .toEqual({ kind: 'broken', name: 'phantom', fromEnvironment: true, latentOrphan: 'ghost' });
  });

  it('reports the provider default as its own kind, never as a name', () => {
    expect(resolveActiveAccount(withSlots, {})).toEqual({ kind: 'default' });
  });

  it('reports the provider credential override without calling an OAuth account active', () => {
    const effective = resolveActiveAccount(oauth, {
      CLODEX_KEY_OPENAI_OAUTH: 'provider-override-token',
    });
    expect(effective).toMatchObject({
      kind: 'credential-override',
      credentialOverride: {
        variable: 'CLODEX_KEY_OPENAI_OAUTH',
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      selection: { kind: 'slot', name: 'alt', fromEnvironment: false },
    });
    expect(JSON.stringify(effective)).not.toContain('provider-override-token');
  });

  it('keeps a broken OAuth selector authoritative over the provider credential override', () => {
    const effective = resolveActiveAccount(
      { ...withSlots, activeAuthAccount: 'ghost' },
      { CLODEX_KEY_OPENAI_OAUTH: 'provider-override-token' },
    );
    expect(effective).toMatchObject({
      kind: 'broken',
      name: 'ghost',
      credentialOverride: { variable: 'CLODEX_KEY_OPENAI_OAUTH' },
    });
  });

  it('applies no-auth markers in the same order as runtime account selection', () => {
    const env = { CLODEX_KEY_OPENAI_OAUTH: 'stale-provider-override' };
    // A valid OAuth slot swaps authRef before credential resolution, so its
    // non-none reference makes the provider override reachable at runtime.
    expect(resolveActiveAccount({
      ...withSlots,
      authRef: 'none:anonymous',
      authType: 'oauth',
      activeAuthAccount: 'work',
    }, env).kind).toBe('credential-override');
    // authType none prevents account selection and credential resolution.
    expect(resolveActiveAccount({
      ...withSlots,
      authType: 'none',
      activeAuthAccount: 'work',
    }, env).kind).toBe('slot');
  });

  it('exhausts the auth-type/enabled/slots/stored/account-env/provider-key grid', () => {
    const authTypes: Array<RegistryProvider['authType']> = ['oauth', 'api', 'none', undefined];
    const slotStates = [false, true];
    const storedStates = [undefined, 'work', 'ghost'];
    const environmentStates = [undefined, 'work', 'ghost'];
    const providerOverrideStates = [false, true];
    let cases = 0;

    for (const authType of authTypes) {
      for (const enabled of [false, true]) {
        for (const hasSlots of slotStates) {
          for (const activeAuthAccount of storedStates) {
            for (const environmentAccount of environmentStates) {
              for (const providerOverride of providerOverrideStates) {
                cases++;
                const provider: RegistryProvider = {
                  ...base,
                  enabled,
                  authType,
                  ...(hasSlots ? { authAccounts: withSlots.authAccounts } : { authAccounts: undefined }),
                  ...(activeAuthAccount ? { activeAuthAccount } : { activeAuthAccount: undefined }),
                };
                const env: NodeJS.ProcessEnv = {
                  ...(environmentAccount ? { CLODEX_OAUTH_ACCOUNT: environmentAccount } : {}),
                  ...(providerOverride ? { CLODEX_KEY_OPENAI_OAUTH: `provider-override-${cases}` } : {}),
                };
                const shown = resolveActiveAccount(provider, env);
                const selection = shown.kind === 'credential-override' ? shown.selection : shown;

                if (authType === 'oauth' && enabled) {
                  expect(shown.inactiveReason, `active OAuth case ${cases}`).toBeUndefined();
                  try {
                    const applied = applySelectedOAuthAccount(provider, environmentAccount);
                    const selectedSlot = Object.entries(provider.authAccounts ?? {})
                      .find(([, slot]) => slot.authRef === applied.authRef)?.[0];
                    if (providerOverride && applied.authRef !== 'none:anonymous') {
                      expect(shown.kind, `overridden OAuth case ${cases}`).toBe('credential-override');
                    } else {
                      expect(shown.kind, `active OAuth case ${cases}`).toBe(selectedSlot ? 'slot' : 'default');
                    }
                    expect(selection.kind, `selected OAuth case ${cases}`).toBe(selectedSlot ? 'slot' : 'default');
                    if (selection.kind === 'slot') expect(selection.name).toBe(selectedSlot);
                  } catch {
                    expect(shown.kind, `throwing OAuth case ${cases}`).toBe('broken');
                    if (providerOverride) expect(shown.credentialOverride).toBeDefined();
                  }
                  continue;
                }

                if (authType === 'oauth') {
                  expect(shown.inactiveReason, `disabled OAuth case ${cases}`).toBe('disabled');
                  let wouldThrow = false;
                  try {
                    applySelectedOAuthAccount({ ...provider, enabled: true }, environmentAccount);
                  } catch {
                    wouldThrow = true;
                  }
                  if (wouldThrow) {
                    expect(shown.kind, `future broken OAuth case ${cases}`).toBe('broken');
                  } else if (providerOverride) {
                    expect(shown.kind, `future overridden OAuth case ${cases}`).toBe('credential-override');
                  }
                  expect(selection.inactiveReason).toBe('disabled');
                  continue;
                }

                expect(shown.inactiveReason, `non-OAuth case ${cases}`).toBe('non-oauth');
                if (providerOverride && authType !== 'none') {
                  expect(shown.kind, `overridden non-OAuth case ${cases}`).toBe('credential-override');
                }
                expect(selection.inactiveReason).toBe('non-oauth');
                if (selection.kind !== 'default') expect(selection.fromEnvironment).toBe(false);
              }
            }
          }
        }
      }
    }

    expect(cases).toBe(288);
  });
});

describe('accountSwitchHint', () => {
  it('says the launch fails when the selection is broken', () => {
    expect(accountSwitchHint({ activeAuthAccount: 'ghost' }, { kind: 'broken', name: 'ghost', fromEnvironment: false }))
      .toContain('every launch fails');
    expect(accountSwitchHint({ activeAuthAccount: 'alt' }, { kind: 'broken', name: 'ghost', fromEnvironment: true }))
      .toContain('names no such account');
  });

  it('flags a masked stored orphan in the hint', () => {
    const hint = accountSwitchHint(
      { activeAuthAccount: 'ghost' },
      { kind: 'slot', name: 'work', fromEnvironment: true, latentOrphan: 'ghost' },
    );
    expect(hint).toContain('stored "ghost" no longer exists');
    expect(hint).toContain('will fail without it');
  });

  it('names the live account otherwise', () => {
    expect(accountSwitchHint({ activeAuthAccount: 'alt' }, { kind: 'slot', name: 'alt', fromEnvironment: false }))
      .toContain('currently uses alt');
    expect(accountSwitchHint({}, { kind: 'default' })).toContain('(provider default)');
  });

  it('does not call an account credential active when the provider key wins', () => {
    const hint = accountSwitchHint({ activeAuthAccount: 'work' }, {
      kind: 'credential-override',
      credentialOverride: { variable: 'CLODEX_KEY_OPENAI_OAUTH', fingerprint: 'a'.repeat(64) },
      selection: { kind: 'slot', name: 'work', fromEnvironment: false },
    });
    expect(hint).toContain('CLODEX_KEY_OPENAI_OAUTH is configured for account work');
    expect(hint).toContain('launches are blocked because it has no isolated model catalog');
  });
});

describe('accountSwitchOutcome', () => {
  it('warns instead of confirming when the saved choice still cannot launch', () => {
    // Persisting succeeds under the write lock while a nonblank
    // CLODEX_OAUTH_ACCOUNT naming a missing slot still makes every launch
    // throw. Reporting the picker choice back verbatim confirmed a repair that
    // had not happened.
    const outcome = accountSwitchOutcome('OpenAI', 'work', {
      kind: 'broken', name: 'ghost', fromEnvironment: true,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('names no such account');
    expect(outcome.message).toContain('every launch fails');
  });

  it('flags an override that shadows what was just saved', () => {
    const outcome = accountSwitchOutcome('OpenAI', 'work', {
      kind: 'slot', name: 'alt', fromEnvironment: true,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('overrides it in this shell');
  });

  it('reports that the provider key shadows the saved account credential', () => {
    const outcome = accountSwitchOutcome('OpenAI', 'work', {
      kind: 'credential-override',
      credentialOverride: { variable: 'CLODEX_KEY_OPENAI_OAUTH', fingerprint: 'b'.repeat(64) },
      selection: { kind: 'slot', name: 'work', fromEnvironment: false },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('CLODEX_KEY_OPENAI_OAUTH has no isolated model catalog');
    expect(outcome.message).toContain('launches are blocked');
    expect(outcome.message).toContain('unset the variable');
    expect(outcome.message).not.toContain('will launch as work');
  });

  it('confirms plainly when the saved choice is what will launch', () => {
    expect(accountSwitchOutcome('OpenAI', 'work', { kind: 'slot', name: 'work', fromEnvironment: false }))
      .toEqual({ ok: true, message: 'OpenAI will launch as work.', confirmsLaunch: true });
    // An override naming the SAME account is not worth a caveat.
    expect(accountSwitchOutcome('OpenAI', 'work', { kind: 'slot', name: 'work', fromEnvironment: true }).ok)
      .toBe(true);
    expect(accountSwitchOutcome('OpenAI', undefined, { kind: 'default' }).message)
      .toContain('(provider default)');
  });

  it('never confirms an outcome the resolver calls broken', () => {
    // The property, not the phrasing: this is the third surface to have decided
    // a launch outcome on its own, so the guard is that ok tracks the resolver.
    for (const effective of [
      { kind: 'broken', name: 'ghost', fromEnvironment: true },
      { kind: 'broken', name: 'ghost', fromEnvironment: false },
    ] as const) {
      expect(accountSwitchOutcome('OpenAI', 'work', effective).ok).toBe(false);
    }
    for (const effective of [
      { kind: 'default' },
      { kind: 'slot', name: 'work', fromEnvironment: false },
      { kind: 'slot', name: 'alt', fromEnvironment: true },
    ] as const) {
      expect(accountSwitchOutcome('OpenAI', 'work', effective).ok).toBe(true);
    }
  });

  it('uses saved-state wording for disabled providers and projects environment failures', () => {
    expect(accountSwitchOutcome('OpenAI', 'work', {
      kind: 'slot', name: 'work', fromEnvironment: false, inactiveReason: 'disabled',
    })).toEqual({ ok: true, message: 'Saved work for OpenAI (provider disabled).' });

    const broken = accountSwitchOutcome('OpenAI', 'work', {
      kind: 'broken', name: 'ghost', fromEnvironment: true, inactiveReason: 'disabled',
    });
    expect(broken.ok).toBe(false);
    expect(broken.message).toContain('enabling it in this shell will fail');
    expect(broken.message).not.toContain('every launch fails');
  });

  it('does not describe a non-OAuth provider as disabled', () => {
    const effective = resolveActiveAccount({
      ...withSlots, authType: 'api', activeAuthAccount: 'work',
    } as RegistryProvider, { CLODEX_OAUTH_ACCOUNT: 'ghost' });
    expect(effective).toMatchObject({
      kind: 'slot', name: 'work', fromEnvironment: false, inactiveReason: 'non-oauth',
    });
    expect(accountSwitchHint({ activeAuthAccount: 'work' }, effective)).toContain('not configured for OAuth');
    expect(accountSwitchHint({ activeAuthAccount: 'work' }, effective)).not.toContain('disabled');
  });
});

describe('accountSwitchServerRestartWarning', () => {
  it('warns for each live standalone server snapshot', () => {
    expect(accountSwitchServerRestartWarning(1)).toContain('Restart 1 running standalone clodex server');
    expect(accountSwitchServerRestartWarning(1)).toContain('retains the previous provider and credential snapshot');
    expect(accountSwitchServerRestartWarning(2)).toContain('Restart 2 running standalone clodex servers');
  });

  it('stays silent when no live standalone server is advertised', () => {
    expect(accountSwitchServerRestartWarning(0)).toBeNull();
  });

  it('stays silent for a no-op selection even when a server is live', () => {
    expect(accountSwitchServerRestartWarning(1, false)).toBeNull();
  });
});
