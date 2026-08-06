import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyLocalPatches,
  applyLocalPatchSet,
  inspectLocalPatchSource,
} from '../src/local-patches.js';

describe('applyLocalPatchSet', () => {
  it('commits every local site when the complete set succeeds', () => {
    expect(applyLocalPatchSet('patched-built-ins', [
      {
        id: 'first',
        apply: (source, { marker }) => `${source}\n${marker}first`,
      },
      {
        id: 'second',
        apply: (source, { marker }) => `${source}\n${marker}second`,
      },
    ])).toEqual({
      content: [
        'patched-built-ins',
        '/*clodex-local:first*/first',
        '/*clodex-local:second*/second',
      ].join('\n'),
      results: [
        { status: 'OK', name: 'LOCAL first' },
        { status: 'OK', name: 'LOCAL second' },
      ],
    });
  });

  it('skips a local site whose marker is already present', () => {
    const apply = vi.fn((source: string) => source);
    const source = 'patched-built-ins\n/*clodex-local:existing*/';

    expect(applyLocalPatchSet(source, [{ id: 'existing', apply }])).toEqual({
      content: source,
      results: [
        {
          status: 'SKIP',
          name: 'LOCAL existing',
          extra: 'already patched',
        },
      ],
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects a duplicated pre-existing site marker', () => {
    const apply = vi.fn((source: string) => source);
    const source = [
      'patched-built-ins',
      '/*clodex-local:existing*/',
      '/*clodex-local:existing*/',
    ].join('\n');

    expect(applyLocalPatchSet(source, [{ id: 'existing', apply }])).toEqual({
      content: source,
      results: [
        {
          status: 'FAIL',
          name: 'LOCAL existing',
          extra: 'existing marker appears more than once',
        },
      ],
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('rolls back every local site when one does not emit its marker', () => {
    const source = 'patched-built-ins';

    expect(applyLocalPatchSet(source, [
      {
        id: 'first',
        apply: (content, { marker }) => `${content}\n${marker}`,
      },
      {
        id: 'missing-anchor',
        apply: content => content,
      },
      {
        id: 'not-run',
        apply: (content, { marker }) => `${content}\n${marker}`,
      },
    ])).toEqual({
      content: source,
      results: [
        {
          status: 'SKIP',
          name: 'LOCAL first',
          extra: 'rolled back after LOCAL missing-anchor failed',
        },
        {
          status: 'FAIL',
          name: 'LOCAL missing-anchor',
          extra: 'transform did not emit /*clodex-local:missing-anchor*/',
        },
        {
          status: 'SKIP',
          name: 'LOCAL not-run',
          extra: 'not run after LOCAL missing-anchor failed',
        },
      ],
    });
  });

  it('contains a thrown transform and reports the complete transaction', () => {
    const source = 'patched-built-ins';

    expect(applyLocalPatchSet(source, [
      {
        id: 'first',
        apply: (content, { marker }) => `${content}\n${marker}`,
      },
      {
        id: 'throws',
        apply: () => {
          throw new TypeError('unsupported bundle shape');
        },
      },
      {
        id: 'not-run',
        apply: (content, { marker }) => `${content}\n${marker}`,
      },
    ])).toEqual({
      content: source,
      results: [
        {
          status: 'SKIP',
          name: 'LOCAL first',
          extra: 'rolled back after LOCAL throws failed',
        },
        {
          status: 'FAIL',
          name: 'LOCAL throws',
          extra: 'TypeError: unsupported bundle shape',
        },
        {
          status: 'SKIP',
          name: 'LOCAL not-run',
          extra: 'not run after LOCAL throws failed',
        },
      ],
    });
  });

  it('rejects unsafe site ids before executing any local code', () => {
    const apply = vi.fn((source: string) => source);

    expect(applyLocalPatchSet('patched-built-ins', [
      { id: 'unsafe*/id', apply },
    ])).toEqual({
      content: 'patched-built-ins',
      results: [
        {
          status: 'FAIL',
          name: 'LOCAL PATCH SET',
          extra: 'invalid id at index 0: "unsafe*/id"',
        },
      ],
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects duplicate site ids before executing any local code', () => {
    const apply = vi.fn((source: string) => source);

    expect(applyLocalPatchSet('patched-built-ins', [
      { id: 'duplicate', apply },
      { id: 'duplicate', apply },
    ])).toEqual({
      content: 'patched-built-ins',
      results: [
        {
          status: 'FAIL',
          name: 'LOCAL PATCH SET',
          extra: 'duplicate id at index 1: "duplicate"',
        },
      ],
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'adds',
      apply: (source: string, marker: string) => `${source}\n${marker}\n/*ccpatch:foreign*/`,
    },
    {
      name: 'removes',
      apply: (source: string, marker: string) => `${source.replace('/*ccpatch:ctx*/', '')}\n${marker}`,
    },
  ])('rolls back a local site that $name a reserved built-in marker', ({ apply }) => {
    const source = 'patched-built-ins\n/*ccpatch:ctx*/';

    expect(applyLocalPatchSet(source, [
      {
        id: 'reserved-marker',
        apply: (content, { marker }) => apply(content, marker),
      },
    ])).toEqual({
      content: source,
      results: [
        {
          status: 'FAIL',
          name: 'LOCAL reserved-marker',
          extra: 'transform changed reserved /*ccpatch: markers',
        },
      ],
    });
  });

  it('reports a non-string transform result as a local failure', () => {
    const source = 'patched-built-ins';

    expect(applyLocalPatchSet(source, [
      {
        id: 'bad-return',
        apply: (() => ({ content: source })) as unknown as (
          source: string,
          context: { marker: string },
        ) => string,
      },
    ])).toEqual({
      content: source,
      results: [
        {
          status: 'FAIL',
          name: 'LOCAL bad-return',
          extra: 'transform returned object instead of a string',
        },
      ],
    });
  });

  it('requires each successful site to emit exactly one generated marker', () => {
    const source = 'patched-built-ins';

    expect(applyLocalPatchSet(source, [
      {
        id: 'duplicate-marker',
        apply: (content, { marker }) => `${content}\n${marker}\n${marker}`,
      },
    ])).toEqual({
      content: source,
      results: [
        {
          status: 'FAIL',
          name: 'LOCAL duplicate-marker',
          extra: 'transform must emit exactly one /*clodex-local:duplicate-marker*/ marker',
        },
      ],
    });
  });

  it('rolls back when a later site removes an earlier local marker', () => {
    const source = 'patched-built-ins';

    expect(applyLocalPatchSet(source, [
      {
        id: 'first',
        apply: (content, { marker }) => `${content}\n${marker}`,
      },
      {
        id: 'second',
        apply: (content, { marker }) => (
          `${content.replace('/*clodex-local:first*/', '')}\n${marker}`
        ),
      },
    ])).toEqual({
      content: source,
      results: [
        {
          status: 'SKIP',
          name: 'LOCAL first',
          extra: 'rolled back after LOCAL second failed',
        },
        {
          status: 'FAIL',
          name: 'LOCAL second',
          extra: 'transform changed another local patch marker',
        },
      ],
    });
  });
});

describe('inspectLocalPatchSource', () => {
  const previousHome = process.env.CLODEX_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-local-patches-'));
    process.env.CLODEX_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('ignores the predefined module until local patches are enabled', () => {
    const path = join(home, 'local-patches.mjs');
    writeFileSync(path, 'throw new Error("must not execute");\n');

    expect(inspectLocalPatchSource(false)).toEqual({
      enabled: false,
      path,
    });
  });

  it('captures and hashes the exact enabled module bytes', () => {
    const path = join(home, 'local-patches.mjs');
    const source = 'export default [];\n';
    writeFileSync(path, source);

    const first = inspectLocalPatchSource(true);
    expect(first).toEqual({
      enabled: true,
      path,
      configIdentity: `v1:${createHash('sha256').update(source).digest('hex')}`,
      source,
    });
    expect(inspectLocalPatchSource(true)).toEqual(first);

    writeFileSync(path, 'export default [{ id: "changed" }];\n');
    expect(inspectLocalPatchSource(true)).not.toEqual(first);
  });
});

describe('applyLocalPatches', () => {
  const previousHome = process.env.CLODEX_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'clodex-local-module-'));
    process.env.CLODEX_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('loads the captured module and applies it after built-in markers exist', async () => {
    writeFileSync(join(home, 'local-patches.mjs'), `
      export default [{
        id: 'after-built-ins',
        apply(source, { marker }) {
          if (!source.includes('/*ccpatch:ctx*/')) throw new Error('built-ins missing');
          return source + '\\n' + marker + 'local-change';
        },
      }];
    `);
    const source = 'patched-built-ins\n/*ccpatch:ctx*/';

    await expect(
      applyLocalPatches(source, inspectLocalPatchSource(true)),
    ).resolves.toEqual({
      content: `${source}\n/*clodex-local:after-built-ins*/local-change`,
      results: [{ status: 'OK', name: 'LOCAL after-built-ins' }],
    });
  });

  it('re-evaluates an immutable snapshot when a module mutates its exported array', async () => {
    writeFileSync(join(home, 'local-patches.mjs'), `
      const patches = [
        {
          id: 'first',
          apply(source, { marker }) {
            patches.length = 1;
            patches[0].id = 'mutated';
            return source + '\\n' + marker;
          },
        },
        {
          id: 'second',
          apply(source, { marker }) { return source + '\\n' + marker; },
        },
      ];
      export default patches;
    `);

    const localSource = inspectLocalPatchSource(true);
    const expected = {
      content: [
        'patched-built-ins',
        '/*clodex-local:first*/',
        '/*clodex-local:second*/',
      ].join('\n'),
      results: [
        { status: 'OK', name: 'LOCAL first' },
        { status: 'OK', name: 'LOCAL second' },
      ],
    };

    await expect(applyLocalPatches('patched-built-ins', localSource)).resolves.toEqual(expected);
    await expect(applyLocalPatches('patched-built-ins', localSource)).resolves.toEqual(expected);
  });

  it('redacts the source-bearing data URL from module errors', async () => {
    const sentinel = 'private-module-sentinel';
    const moduleSource = `
      // ${sentinel}
      throw new Error(import.meta.url);
      export default [];
    `;
    writeFileSync(join(home, 'local-patches.mjs'), moduleSource);

    const outcome = await applyLocalPatches(
      'patched-built-ins',
      inspectLocalPatchSource(true),
    );

    expect(outcome).toEqual({
      content: 'patched-built-ins',
      results: [{
        status: 'FAIL',
        name: 'LOCAL PATCH SET',
        extra: 'Error: <local-patches.mjs>',
      }],
    });
    expect(JSON.stringify(outcome)).not.toContain('data:text/javascript');
    expect(JSON.stringify(outcome)).not.toContain(sentinel);
    expect(JSON.stringify(outcome)).not.toContain(Buffer.from(moduleSource).toString('base64').slice(0, 24));
  });

  it.each([
    {
      source: 'export default {};\n',
      extra: 'default export must be an array',
    },
    {
      source: 'export default [null];\n',
      extra: 'entry at index 0 must be an object',
    },
    {
      source: 'export default [{ id: "missing-apply" }];\n',
      extra: 'entry "missing-apply" must have an apply function',
    },
  ])('contains an invalid module contract: $extra', async ({ source, extra }) => {
    writeFileSync(join(home, 'local-patches.mjs'), source);

    await expect(
      applyLocalPatches('patched-built-ins', inspectLocalPatchSource(true)),
    ).resolves.toEqual({
      content: 'patched-built-ins',
      results: [{ status: 'FAIL', name: 'LOCAL PATCH SET', extra }],
    });
  });
});
