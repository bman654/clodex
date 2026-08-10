import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  isLikelyPlaceholderKey,
  isPlaceholderProviderKey,
  refreshCredentialSnapshot,
  resolveRefreshCredential,
  resolveRefreshCredentialWithSource,
} from '../src/registry/refresh-credentials.js';
import type { RegistryProvider } from '../src/registry/types.js';

function makeProvider(overrides: Partial<RegistryProvider> = {}): RegistryProvider {
  return {
    id: 'openai',
    templateId: 'openai',
    name: 'OpenAI',
    enabled: true,
    authRef: 'keyring:global:openai-oauth',
    authType: 'oauth',
    api: {},
    addedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('isPlaceholderProviderKey', () => {
  it('detects OpenCode placeholder keys', () => {
    expect(isPlaceholderProviderKey('anything')).toBe(true);
    expect(isPlaceholderProviderKey('ollama')).toBe(true);
    expect(isPlaceholderProviderKey('local')).toBe(true);
  });

  it('accepts real-looking keys', () => {
    expect(isPlaceholderProviderKey('sk-ant-api03-abc123')).toBe(false);
    expect(isPlaceholderProviderKey('nvapi-abc123def456')).toBe(false);
  });

  it('treats empty as placeholder', () => {
    expect(isPlaceholderProviderKey('')).toBe(true);
    expect(isPlaceholderProviderKey(null)).toBe(true);
  });

  it('treats very short keys as likely placeholders', () => {
    expect(isLikelyPlaceholderKey('a')).toBe(true);
    expect(isLikelyPlaceholderKey('ok')).toBe(true);
  });
});

describe('resolveRefreshCredential', () => {
  it('captures only redaction-safe provider override provenance in the snapshot', () => {
    const previous = process.env.CLODEX_KEY_OPENAI;
    const credential = 'snapshot-provider-override-secret';
    process.env.CLODEX_KEY_OPENAI = credential;
    try {
      const snapshot = refreshCredentialSnapshot(makeProvider(), null);
      expect(snapshot.credentialOverride).toEqual({
        variable: 'CLODEX_KEY_OPENAI',
        fingerprint: createHash('sha256').update(credential).digest('hex'),
      });
      expect(JSON.stringify(snapshot)).not.toContain(credential);
    } finally {
      if (previous === undefined) delete process.env.CLODEX_KEY_OPENAI;
      else process.env.CLODEX_KEY_OPENAI = previous;
    }
  });

  it('can deliberately resolve the persisted store without attributing CLODEX_KEY_*', async () => {
    const previous = process.env.CLODEX_KEY_OPENAI;
    process.env.CLODEX_KEY_OPENAI = 'temporary-provider-key';
    try {
      const provider = makeProvider();
      expect(refreshCredentialSnapshot(provider, null, { ignoreProviderOverride: true }))
        .toMatchObject({ ignoreProviderOverride: true });
      expect(refreshCredentialSnapshot(provider, null, { ignoreProviderOverride: true }).credentialOverride)
        .toBeUndefined();
      await expect(resolveRefreshCredentialWithSource(
        provider,
        async () => 'persisted-oauth-token',
        null,
        { ignoreProviderOverride: true },
      )).resolves.toEqual({ credential: 'persisted-oauth-token' });
    } finally {
      if (previous === undefined) delete process.env.CLODEX_KEY_OPENAI;
      else process.env.CLODEX_KEY_OPENAI = previous;
    }
  });

  it('does not capture or resolve an override when either no-auth marker is authoritative', async () => {
    const previous = process.env.CLODEX_KEY_OPENAI;
    process.env.CLODEX_KEY_OPENAI = 'stale-provider-override';
    try {
      for (const provider of [
        makeProvider({ authRef: 'none:anonymous' }),
        makeProvider({ authType: 'none' }),
      ]) {
        expect(refreshCredentialSnapshot(provider, null).credentialOverride).toBeUndefined();
        const resolveKey = async () => 'must-not-resolve';
        await expect(resolveRefreshCredential(provider, resolveKey, null)).resolves.toBeNull();
      }
    } finally {
      if (previous === undefined) delete process.env.CLODEX_KEY_OPENAI;
      else process.env.CLODEX_KEY_OPENAI = previous;
    }
  });

  it('returns the resolved key when it looks real', async () => {
    const key = await resolveRefreshCredential(makeProvider(), async () => 'sk-real-key-123456');
    expect(key).toBe('sk-real-key-123456');
  });

  it('swallows an exception from resolveKey (e.g. OAuth refresh 401) instead of throwing', async () => {
    const previous = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    try {
      const key = await resolveRefreshCredential(makeProvider(), async () => {
        throw new Error('OpenAI token refresh failed (401)');
      });
      expect(key).toBeNull();
    } finally {
      if (previous === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previous;
    }
  });

  it('falls through to env fallback when resolveKey throws and an env var is set', async () => {
    const prev = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-from-env';
    try {
      const key = await resolveRefreshCredential(makeProvider(), async () => {
        throw new Error('OpenAI token refresh failed (401)');
      });
      expect(key).toBe('sk-from-env');
    } finally {
      if (prev === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = prev;
    }
  });

  it('does not resolve credentials or environment fallbacks for anonymous access', async () => {
    const previous = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-from-env';
    try {
      let called = false;
      const key = await resolveRefreshCredential(
        makeProvider({ authRef: 'none:anonymous', authType: 'none' }),
        async () => {
          called = true;
          return 'stale-key';
        },
      );
      expect(key).toBeNull();
      expect(called).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previous;
    }
  });

  it('resolves the stored OAuth account slot instead of the provider default', async () => {
    const provider = makeProvider({
      id: 'openai-oauth',
      activeAuthAccount: 'work',
      authAccounts: {
        work: { authRef: 'keyring:oauth:work', addedAt: '2026-08-09T00:00:00.000Z' },
        alt: { authRef: 'keyring:oauth:alt', addedAt: '2026-08-09T00:00:00.000Z' },
      },
    });
    const seen: string[] = [];
    await resolveRefreshCredential(provider, async selected => {
      seen.push(selected.authRef);
      return 'selected-work-token';
    }, undefined);
    expect(seen).toEqual(['keyring:oauth:work']);
    expect(refreshCredentialSnapshot(provider, null)).toMatchObject({
      authRef: 'keyring:oauth:work',
      activeAuthAccount: 'work',
      selectedAccount: {
        name: 'work',
        authRef: 'keyring:oauth:work',
        addedAt: '2026-08-09T00:00:00.000Z',
      },
    });
  });

  it('lets the environment account override the stored slot for refresh', async () => {
    const provider = makeProvider({
      id: 'openai-oauth',
      activeAuthAccount: 'work',
      authAccounts: {
        work: { authRef: 'keyring:oauth:work', addedAt: '2026-08-09T00:00:00.000Z' },
        alt: { authRef: 'keyring:oauth:alt', addedAt: '2026-08-09T00:00:00.000Z' },
      },
    });
    const seen: string[] = [];
    await resolveRefreshCredential(provider, async selected => {
      seen.push(selected.authRef);
      return 'selected-alt-token';
    }, 'alt');
    expect(seen).toEqual(['keyring:oauth:alt']);
    expect(refreshCredentialSnapshot(provider, 'alt')).toMatchObject({
      authRef: 'keyring:oauth:alt',
      activeAuthAccount: 'work',
      environmentAccount: 'alt',
      selectedAccount: {
        name: 'alt',
        authRef: 'keyring:oauth:alt',
        addedAt: '2026-08-09T00:00:00.000Z',
      },
    });
  });

  it('projects a disabled provider through its stored OAuth account', async () => {
    const provider = makeProvider({
      id: 'openai-oauth',
      enabled: false,
      activeAuthAccount: 'work',
      authAccounts: {
        work: { authRef: 'keyring:oauth:work', addedAt: '2026-08-09T00:00:00.000Z' },
        alt: { authRef: 'keyring:oauth:alt', addedAt: '2026-08-09T00:00:00.000Z' },
      },
    });
    const seen: string[] = [];

    await resolveRefreshCredential(provider, async selected => {
      seen.push(selected.authRef);
      return 'selected-work-token';
    }, null);

    expect(seen).toEqual(['keyring:oauth:work']);
    expect(refreshCredentialSnapshot(provider, null)).toMatchObject({
      authRef: 'keyring:oauth:work',
      activeAuthAccount: 'work',
      provider: { enabled: false },
      selectedAccount: { name: 'work', authRef: 'keyring:oauth:work' },
    });
  });

  it('projects an environment override for a disabled provider and fails closed when missing', async () => {
    const provider = makeProvider({
      id: 'openai-oauth',
      enabled: false,
      activeAuthAccount: 'work',
      authAccounts: {
        work: { authRef: 'keyring:oauth:work', addedAt: '2026-08-09T00:00:00.000Z' },
        alt: { authRef: 'keyring:oauth:alt', addedAt: '2026-08-09T00:00:00.000Z' },
      },
    });
    const seen: string[] = [];

    await resolveRefreshCredential(provider, async selected => {
      seen.push(selected.authRef);
      return 'selected-alt-token';
    }, 'alt');

    expect(seen).toEqual(['keyring:oauth:alt']);
    await expect(resolveRefreshCredential(provider, async () => 'default-token', 'ghost'))
      .rejects.toThrow(/no account named "ghost"/);
  });

  it('keeps an explicitly captured absent override stable if process.env later changes', async () => {
    const provider = makeProvider({
      id: 'openai-oauth',
      activeAuthAccount: 'work',
      authAccounts: {
        work: { authRef: 'keyring:oauth:work', addedAt: '2026-08-09T00:00:00.000Z' },
      },
    });
    const previous = process.env['CLODEX_OAUTH_ACCOUNT'];
    process.env['CLODEX_OAUTH_ACCOUNT'] = 'ghost';
    try {
      expect(refreshCredentialSnapshot(provider, null)).toMatchObject({
        authRef: 'keyring:oauth:work',
        activeAuthAccount: 'work',
      });
      const seen: string[] = [];
      await resolveRefreshCredential(provider, async selected => {
        seen.push(selected.authRef);
        return 'selected-work-token';
      }, null);
      expect(seen).toEqual(['keyring:oauth:work']);
    } finally {
      if (previous === undefined) delete process.env['CLODEX_OAUTH_ACCOUNT'];
      else process.env['CLODEX_OAUTH_ACCOUNT'] = previous;
    }
  });

  it('fails closed when the selected OAuth account no longer exists', async () => {
    const provider = makeProvider({
      id: 'openai-oauth',
      activeAuthAccount: 'ghost',
      authAccounts: {
        work: { authRef: 'keyring:oauth:work', addedAt: '2026-08-09T00:00:00.000Z' },
      },
    });
    await expect(resolveRefreshCredential(provider, async () => 'default-token', undefined))
      .rejects.toThrow(/no longer exists/);
  });
});
