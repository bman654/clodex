import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPreferences, savePreferences } from '../src/config.js';
import { emptyRegistry, saveRegistry } from '../src/registry/io.js';
import { withRegistryWriteLockSync } from '../src/registry/lock.js';
import { resetContextStops } from '../src/context-modes.js';
import { main, runModelsCommand } from '../src/cli.js';
import type { ProviderRegistry } from '../src/registry/types.js';

/**
 * These drive the real command against an isolated CLODEX_HOME rather than
 * asserting the flags appear in help text. A help-text pin proves a flag is
 * documented; it cannot notice the feature behind it being deleted.
 */

let tempHome: string;

function seedRegistry(): void {
  const registry = emptyRegistry();
  registry.providers.push({
    id: 'openai-oauth',
    templateId: 'openai',
    name: 'OpenAI (ChatGPT)',
    enabled: true,
    authRef: 'keyring:provider:openai-oauth',
    authType: 'oauth',
    api: { npm: '@ai-sdk/openai' },
    addedAt: '2026-08-21T00:00:00.000Z',
    modelsCache: {
      fetchedAt: '2026-08-21T00:00:00.000Z',
      models: [
        {
          id: 'gpt-5.6-sol',
          name: 'GPT-5.6 Sol',
          upstreamModelId: 'gpt-5.6-sol',
          contextWindow: 272_000,
          modelFormat: 'openai',
          npm: '@ai-sdk/openai',
        },
      ],
    },
  } as unknown as ProviderRegistry['providers'][number]);
  withRegistryWriteLockSync(() => saveRegistry(registry));
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clodex-context-command-'));
  process.env['CLODEX_HOME'] = tempHome;
  resetContextStops();
  seedRegistry();
  savePreferences({
    favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
    modelAliases: [{ name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
  });
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  delete process.env['CLODEX_HOME'];
  resetContextStops();
});

function captureJson(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation(msg => { stdout.push(String(msg)); });
  const err = vi.spyOn(console, 'error').mockImplementation(msg => { stderr.push(String(msg)); });
  return { stdout, stderr, restore: () => { log.mockRestore(); err.mockRestore(); } };
}

describe('models --json', () => {
  it('emits the resolved catalog rather than an empty array', async () => {
    const cap = captureJson();
    try {
      expect(await runModelsCommand({ json: true })).toBe(0);
    } finally {
      cap.restore();
    }
    const parsed = JSON.parse(cap.stdout.join('')) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!['id']).toBe('clodex:openai-oauth:gpt-5.6-sol');
    expect(parsed[0]!['alias']).toBe('sol');
    const context = parsed[0]!['context'] as Record<string, unknown>;
    expect(context['effective']).toBe(272_000);
    expect(context['max']).toBe(872_000);
    expect(parsed[0]!['pricingBoundary']).toBe(272_000);
  });

  // Two output surfaces of one command, in one process, must not disagree: stdout
  // is machine-read and stderr is what the user is shown.
  it('reports the session stop on stdout, matching its own stderr', async () => {
    const cap = captureJson();
    try {
      expect(await main(['models', '--context', 'sol=max', '--json'])).toBe(0);
    } finally {
      cap.restore();
    }
    const parsed = JSON.parse(cap.stdout.join('')) as Array<Record<string, unknown>>;
    const context = parsed[0]!['context'] as Record<string, unknown>;
    expect(context['stop']).toBe('max');
    expect(context['effective']).toBe(872_000);
    expect(cap.stderr.join('\n')).toContain('872,000');
    // Session-scoped: nothing was written to preferences.
    expect(loadPreferences().modelContextModes ?? {}).toEqual({});
  });
});

describe('--context assignments', () => {
  it('saves a stop that reaches preferences and the resolved catalog', async () => {
    const cap = captureJson();
    try {
      expect(await main(['models', '--context', 'sol=max', '--save'])).toBe(0);
    } finally {
      cap.restore();
    }
    expect(loadPreferences().modelContextModes)
      .toEqual({ 'openai-oauth:gpt-5.6-sol': 'max' });

    const after = captureJson();
    try {
      expect(await runModelsCommand({ json: true })).toBe(0);
    } finally {
      after.restore();
    }
    const parsed = JSON.parse(after.stdout.join('')) as Array<Record<string, unknown>>;
    expect((parsed[0]!['context'] as Record<string, unknown>)['effective']).toBe(872_000);
  });

  it('warns when the selected stop can reach the higher-rate band', async () => {
    const cap = captureJson();
    try {
      await main(['models', '--context', 'sol=max', '--json']);
    } finally {
      cap.restore();
    }
    expect(cap.stderr.join('\n')).toMatch(/272,000-token pricing boundary|pricing boundary/);
  });

  it('rejects an unknown target rather than silently continuing', async () => {
    const cap = captureJson();
    try {
      expect(await main(['models', '--context', 'nope=max', '--json'])).toBe(1);
    } finally {
      cap.restore();
    }
    expect(loadPreferences().modelContextModes ?? {}).toEqual({});
  });

  // `--save` is consumed by the models branch only; on the launch path it would be
  // forwarded to the child, which ignores it, so a user following the hint gets
  // no error and no saved stop.
  it('names a command that works when a launch-scoped stop is applied', async () => {
    const cap = captureJson();
    try {
      await main(['claude', '--context', 'sol=max', '--dry-run']);
    } finally {
      cap.restore();
    }
    const all = [...cap.stdout, ...cap.stderr].join('\n');
    expect(all).toContain('872,000');
    expect(all).not.toContain('Add --save');
    expect(all).toContain('clodex models --context');
  });

  // Help is the whole point of `--help`; a stop report must not precede it, and a
  // bad target must not suppress it.
  it('prints claude help without a stop report in front of it', async () => {
    const cap = captureJson();
    try {
      expect(await main(['claude', '--context', 'sol=max', '--help'])).toBe(0);
    } finally {
      cap.restore();
    }
    expect(cap.stderr.join('\n')).not.toContain('872,000');
    expect(cap.stdout.join('\n')).toContain('--context');
  });

  it('still prints claude help when the target is unknown', async () => {
    const cap = captureJson();
    try {
      expect(await main(['claude', '--context', 'nope=max', '--help'])).toBe(0);
    } finally {
      cap.restore();
    }
    expect(cap.stdout.join('\n')).toContain('--context');
  });
});
