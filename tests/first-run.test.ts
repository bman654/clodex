import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { needsFirstRunSetup } from '../src/first-run.js';
import { emptyRegistry, saveRegistry } from '../src/registry/io.js';

describe('needsFirstRunSetup', () => {
  let home: string;
  const prevHome = process.env.CLODEX_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-first-run-'));
    process.env.CLODEX_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('returns true when the registry is empty', async () => {
    expect(await needsFirstRunSetup()).toBe(true);
  });

  it('returns false when registry has providers', async () => {
    const registry = emptyRegistry();
    registry.providers.push({
      id: 'openai-oauth',
      templateId: 'openai',
      name: 'OpenAI (ChatGPT)',
      enabled: true,
      authRef: 'keyring:oauth:provider:openai-oauth',
      authType: 'oauth',
      api: { npm: '@ai-sdk/openai' },
      addedAt: new Date().toISOString(),
    });
    saveRegistry(registry);
    expect(await needsFirstRunSetup()).toBe(false);
  });
});
