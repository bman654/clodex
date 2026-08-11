// Review-only end-to-end mutation harness for PATCH 10 local-proof enforcement.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const tweakccMocks = vi.hoisted(() => ({
  tryDetectInstallation: vi.fn(),
  readContent: vi.fn(),
  writeContent: vi.fn(),
}));
vi.mock('tweakcc', () => tweakccMocks);

import { applyPatch } from '../src/patcher.js';

let cleanup: string | undefined;
const priorHome = process.env.CLODEX_HOME;
const priorTweakccHome = process.env.TWEAKCC_CONFIG_DIR;

afterEach(() => {
  if (priorHome === undefined) delete process.env.CLODEX_HOME;
  else process.env.CLODEX_HOME = priorHome;
  if (priorTweakccHome === undefined) delete process.env.TWEAKCC_CONFIG_DIR;
  else process.env.TWEAKCC_CONFIG_DIR = priorTweakccHome;
  if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  cleanup = undefined;
  vi.clearAllMocks();
});

it('currently publishes a local patch that restores the returned merge to process.env', async () => {
  cleanup = mkdtempSync(join(import.meta.dirname, '..', '.audit-proof-'));
  const binaryPath = join(cleanup, 'claude');
  const tweakccHome = join(cleanup, 'tweakcc-home');
  mkdirSync(tweakccHome, { recursive: true });
  writeFileSync(binaryPath, 'pristine-native');
  process.env.CLODEX_HOME = join(cleanup, 'clodex-home');
  process.env.TWEAKCC_CONFIG_DIR = tweakccHome;

  const bundle = readFileSync(join(
    process.env['REVIEW_BUNDLE_DIR'] ?? '',
    'claude-2.1.226-013a1cf17df5ff1d.js',
  ), 'utf8');
  let sourceSentToRepacker = '';
  tweakccMocks.tryDetectInstallation.mockImplementation(async ({ path }: { path: string }) => ({
    path,
    version: '2.1.226',
    kind: 'native',
  }));
  tweakccMocks.readContent.mockResolvedValue(bundle);
  tweakccMocks.writeContent.mockImplementation(async ({ path }: { path: string }, content: string) => {
    sourceSentToRepacker = content;
    writeFileSync(path, 'patched-native');
  });

  const localSource = `export default [{
    id: 'break-child-env',
    apply(source, { marker }) {
      return source.replace(
        'let u={..._clodexChildEnv,...tTs,...e,...n}',
        marker + 'let u={...process.env,...tTs,...e,...n}',
      );
    },
  }];`;
  const outcome = await applyPatch(
    binaryPath,
    '2.1.226',
    {
      config: {
        'clodex:openai:gpt-5.6-sol': { alias: 'sol', context: 272000, display: 'GPT-5.6 Sol' },
      },
      unknownWindows: [],
    },
    'audit-config',
    {
      trace: false,
      manifest: null,
      localPatches: {
        enabled: true,
        path: join(cleanup, 'local-patches.mjs'),
        configIdentity: 'v1:audit',
        source: localSource,
      },
    },
  );

  expect(outcome.ok).toBe(true);
  expect(sourceSentToRepacker).toContain('/*clodex-local:break-child-env*/');
  expect(sourceSentToRepacker).not.toContain('let u={..._clodexChildEnv,...tTs,...e,...n}');
  expect(sourceSentToRepacker).toContain('let u={...process.env,...tTs,...e,...n}');
});
