import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as p from '@clack/prompts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runModelsCommand } from '../src/cli.js';
import { loadPreferences, savePreferences } from '../src/config.js';
import { getConfigPath } from '../src/paths.js';

let tempHome: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clodex-effort-policy-command-'));
  process.env['CLODEX_HOME'] = tempHome;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempHome, { recursive: true, force: true });
  delete process.env['CLODEX_HOME'];
});

describe('models effort-policy command', () => {
  it('saves and reports the current global policy without opening the manager', async () => {
    const success = vi.spyOn(p.log, 'success').mockImplementation(() => {});
    const info = vi.spyOn(p.log, 'info').mockImplementation(() => {});

    expect(await runModelsCommand({ effortPolicy: 'up' })).toBe(0);

    expect(loadPreferences().effortPolicy).toBe('up');
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).effortPolicy).toBe('up');
    expect(success).toHaveBeenCalledWith('Current global unsupported-effort policy: up (saved).');
    expect(info).toHaveBeenCalledWith(
      'Running clodex processes keep their startup policy snapshot; restart them to apply this change.',
    );
  });

  it('rejects a policy change combined with another models operation without changing config', async () => {
    const error = vi.spyOn(p.log, 'error').mockImplementation(() => {});
    savePreferences({ effortPolicy: 'down' });

    expect(await runModelsCommand({ effortPolicy: 'exact', list: true })).toBe(1);

    expect(loadPreferences().effortPolicy).toBe('down');
    expect(error).toHaveBeenCalledWith(
      '--effort-policy cannot be combined with --list, --alias, or --unalias.',
    );
  });
});
