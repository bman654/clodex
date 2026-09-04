import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildFakeNativeClaude } from './bun-blob-fixture.js';
import { CLAUDE_FIXTURE } from './fixtures/claude-bundle.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

describe('the full patch-mechanism probe', () => {
  it('fails a fake bundle whose compact prompt is missing one strict marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-probe-integration-'));
    try {
      const binary = join(dir, 'claude');
      const scratch = join(dir, 'scratch');
      const hook = join(dir, 'resolve-hook.mjs');
      const fakeTweakcc = join(dir, 'fake-tweakcc.mjs');
      const fixtureModule = pathToFileURL(join(REPO, 'tests/bun-blob-fixture.ts')).href;

      // Independent oracle copied from an extracted bundle: importing the production values would
      // let one bad edit change both the implementation and the integration fixture.
      const strictStart = 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.';
      const source = [CLAUDE_FIXTURE, strictStart, 'x'.repeat(1_000_000)].join('\n');
      writeFileSync(binary, buildFakeNativeClaude('test-version', [
        { name: '/$bunfs/root/claude', contents: source },
      ]));

      writeFileSync(fakeTweakcc, `
import { readFileSync, writeFileSync } from 'node:fs';
import { parseBunBlob, rebuildFakeNativeClaude } from ${JSON.stringify(fixtureModule)};
export async function tryDetectInstallation({ path }) {
  return { path, version: 'test-version', kind: 'native' };
}
export async function readContent(installation) {
  return parseBunBlob(readFileSync(installation.path)).contents[0];
}
export async function writeContent(installation, content) {
  const binary = readFileSync(installation.path);
  writeFileSync(
    installation.path,
    rebuildFakeNativeClaude(binary, 'test-version', (index, previous) =>
      index === 0 ? content : previous),
  );
}
`);
      writeFileSync(hook, `
import { registerHooks } from 'node:module';
const fakeTweakcc = new URL('./fake-tweakcc.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'tweakcc') return { shortCircuit: true, url: fakeTweakcc };
    return nextResolve(specifier, context);
  },
});
`);

      const result = spawnSync(process.execPath, [
        '--import', hook,
        join(REPO, 'scripts/probe-patch-mechanism.mjs'),
        binary,
        '--json',
        '--scratch', scratch,
      ], {
        cwd: REPO,
        encoding: 'utf8',
        env: {
          ...process.env,
          TWEAKCC_CONFIG_DIR: join(dir, 'tweakcc-config'),
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toMatch(/\n\s+at /);
      const report: unknown = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        verdict: 'fail',
        compactPromptMarkers: { missing: ['end'] },
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: 'compact-prompt-markers',
            ok: false,
            detail: 'missing strict compaction prompt marker(s): end',
          }),
        ]),
      });
      const serialized = JSON.stringify(report);
      expect(serialized).toContain('Compaction-prompt drift is not a patch failure');
      expect(serialized).toContain('no patch site is broken');
      expect(serialized).toContain('Claude Code reworded its');
      expect(serialized).toContain('compaction prompt');
      expect(serialized).toContain('bundle-reader omission has the same symptom');
      expect(serialized).toContain("clodex's text-only guard from firing");
      expect(serialized).toContain('auto-compaction then fails on OpenAI models');
      expect(serialized).toContain(String.raw`long sessions die with \"Prompt is too long\"`);
      expect(serialized).toContain('src/claude-code-compact-prompt.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
