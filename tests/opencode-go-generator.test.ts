import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import snapshot from '../src/data/opencode-go-cli-snapshot.json';
// The updater is a maintainer-facing JavaScript entry point, intentionally not
// part of the published TypeScript API surface.
// @ts-expect-error no declaration file for the maintenance script
import {
  assertResolvedModels,
  assertSnapshotMeta,
  canonicalizeResolvedModels,
  convertResolvedModels,
  crossCheckTemperatureSupport,
  crossCheckTransports,
  resolvedModelsSha256,
  run,
} from '../scripts/update-opencode-go-models.mjs';

const CATALOG_PATH = 'src/data/opencode-go-models.json';
const SNAPSHOT_PATH = 'src/data/opencode-go-cli-snapshot.json';
const CONSTANTS_PATH = 'src/data/opencode-go-models.ts';

/** Every id the reviewed catalog routes, in committed order. */
const REVIEWED_IDS = [
  'deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.1', 'glm-5.2', 'gpt-5.6-luna',
  'hy3', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3', 'mimo-v2.5', 'mimo-v2.5-pro',
  'minimax-m2.7', 'minimax-m3', 'qwen3.6-plus', 'qwen3.7-max', 'qwen3.7-plus',
  'qwen3.8-max',
];

type ResolvedModel = Record<string, any>;

function resolvedModel(id: string, npm: string, overrides: ResolvedModel = {}): ResolvedModel {
  return {
    api: { id, npm, url: 'https://opencode.ai/zen/go/v1' },
    capabilities: {
      attachment: false,
      input: { audio: false, image: false, pdf: false, text: true, video: false },
      interleaved: false,
      output: { audio: false, image: false, pdf: false, text: true, video: false },
      reasoning: true,
      temperature: true,
      toolcall: true,
    },
    cost: { cache: { read: 0.25, write: 0 }, input: 1, output: 2 },
    family: id.split('-')[0],
    headers: {},
    id,
    limit: { context: 200_000, output: 10_000 },
    name: id,
    options: {},
    providerID: 'opencode-go',
    release_date: '2026-08-09',
    status: 'active',
    variants: {},
    ...overrides,
  };
}

/** The snapshot rows for the three models whose transport is overridden. */
function overriddenRows(): ResolvedModel[] {
  return snapshot.models
    .filter(model => ['gpt-5.6-luna', 'minimax-m2.7', 'qwen3.6-plus'].includes(model.id))
    .map(model => structuredClone(model) as ResolvedModel);
}

describe('OpenCode Go resolver snapshot generator', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pins the exact committed capture and its recorded row digest', () => {
    expect(snapshot._meta).toMatchObject({
      capturedAt: '2026-08-09T17:47:18Z',
      openCodeVersion: '1.18.15',
      provider: 'opencode-go',
      releaseAsset: 'opencode-darwin-arm64.zip',
      releaseAssetSha256: 'bd60b57cb9fe0494a5352c807424d36d6d7853cf6dbddb97065c7ccd3c5d391c',
      releaseCommit: 'd7b115f623760e68a4749d16508a9eca350f246f',
      releaseTag: 'v1.18.15',
      schemaVersion: 1,
      sourceCommand: 'opencode --pure models opencode-go --verbose',
    });
    expect(snapshot.models).toHaveLength(18);
    expect(snapshot.models.filter(model => model.api.npm === '@ai-sdk/openai-compatible')).toHaveLength(10);
    expect(snapshot.models.filter(model => model.api.npm === '@ai-sdk/anthropic')).toHaveLength(6);
    expect(snapshot.models.filter(model => model.api.npm === '@ai-sdk/openai')).toHaveLength(2);
    // The digest is over the snapshot's OWN rows, so a hand-edit to the
    // committed bytes cannot pass its own recorded normalization.
    expect(resolvedModelsSha256(snapshot.models))
      .toBe('fa41e01da5fe41fb08e75b37adf1c5404902489c4dc76d390e5209f555897cb4');
    expect(snapshot._meta.normalizedModelsSha256).toBe(resolvedModelsSha256(snapshot.models));
  });

  it('canonicalizes by code unit rather than host locale ordering', () => {
    const rows = [{ id: 'a0', b: 1, a: 2 }, { id: 'a.' }, { id: 'a-' }];
    const canonical = canonicalizeResolvedModels(rows);
    expect(JSON.parse(canonical).map((row: { id: string }) => row.id)).toEqual(['a-', 'a.', 'a0']);
    expect(canonical.endsWith('\n')).toBe(true);
    expect(canonical).toContain('{"a":2,"b":1,"id":"a0"}');
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(resolvedModelsSha256(rows));
  });

  it('conserves all 17 reviewed ids and every current transport, and drops the Responses-routed model', () => {
    const { supported, unmapped } = convertResolvedModels(snapshot.models);
    expect(supported.map((model: { id: string }) => model.id)).toEqual(REVIEWED_IDS);
    expect(unmapped).toEqual(['grok-4.5']);

    const byId = new Map(supported.map((model: { id: string }) => [model.id, model]));
    for (const id of ['minimax-m3', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.8-max']) {
      expect(byId.get(id), id).toMatchObject({
        modelFormat: 'anthropic',
        npm: '@ai-sdk/anthropic',
        apiUrl: 'https://opencode.ai/zen/go',
      });
    }
    for (const id of REVIEWED_IDS.filter(entry => !['minimax-m3', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.8-max'].includes(entry))) {
      expect(byId.get(id), id).toMatchObject({
        modelFormat: 'openai',
        npm: '@ai-sdk/openai-compatible',
        apiUrl: 'https://opencode.ai/zen/go/v1',
      });
    }
  });

  it('regenerates the committed catalog from the committed snapshot', async () => {
    const committed = JSON.parse(await readFile(CATALOG_PATH, 'utf8'));
    const { supported } = convertResolvedModels(snapshot.models);
    expect(committed).toEqual(supported);
    // Byte-for-byte, not just deeply equal: the committed file is this exact
    // serialization, so a hand-edit cannot survive `--check`.
    expect(await readFile(CATALOG_PATH, 'utf8')).toBe(`${JSON.stringify(supported, null, 2)}\n`);
  });

  it('takes family and the interleaved reasoning field from the resolver, and nothing else', () => {
    const resolvedById = new Map(snapshot.models.map(model => [model.id, model]));
    const { supported } = convertResolvedModels(snapshot.models);
    for (const model of supported as Array<Record<string, any>>) {
      const resolved = resolvedById.get(model.id)!;
      expect(model.family, model.id).toBe(resolved.family);
      expect(model.interleavedReasoningField, model.id)
        .toBe(resolved.capabilities.interleaved === false ? undefined : resolved.capabilities.interleaved.field);
      // Metadata the resolver also publishes, conserved exactly.
      expect(model.name, model.id).toBe(resolved.name);
      expect(model.contextWindow, model.id).toBe(resolved.limit.context);
      expect(model.cost.input, model.id).toBe(resolved.cost.input);
      expect(model.cost.output, model.id).toBe(resolved.cost.output);
      expect(model.cost.cache_read, model.id).toBe(resolved.cost.cache?.read || undefined);
      expect(model.cost.cache_write, model.id).toBe(resolved.cost.cache?.write || undefined);
      // Routing stays local. The resolver emits /zen/go/v1 for every row,
      // including the Messages ones, which the Anthropic SDK must not be given.
      expect(resolved.api.url, model.id).toBe('https://opencode.ai/zen/go/v1');
      expect(model.apiUrl, model.id)
        .toBe(model.modelFormat === 'anthropic' ? 'https://opencode.ai/zen/go' : 'https://opencode.ai/zen/go/v1');
    }
  });

  it('accepts exactly the three reviewed transport divergences with their stated reasons', () => {
    const applied: string[] = crossCheckTransports(snapshot.models);
    expect(applied).toHaveLength(3);
    expect(applied.find(entry => entry.startsWith('gpt-5.6-luna:')))
      .toMatch(/snapshot openai-responses -> runtime openai-completions .*conserved/s);
    expect(applied.find(entry => entry.startsWith('minimax-m2.7:')))
      .toMatch(/snapshot anthropic-messages -> runtime openai-completions .*conserved/s);
    expect(applied.find(entry => entry.startsWith('qwen3.6-plus:')))
      .toMatch(/snapshot anthropic-messages -> runtime openai-completions .*conserved/s);
  });

  it('rejects a local temperature exclusion that the resolver snapshot does not support', () => {
    const mutated = snapshot.models.map(model => (model.id === 'kimi-k3'
      ? {
          ...structuredClone(model),
          capabilities: { ...model.capabilities, temperature: true },
        }
      : model));

    expect(() => convertResolvedModels(mutated))
      .toThrow(/kimi-k3: PATCHES disables temperature, but resolver snapshot does not/);
  });

  it('reports snapshot temperature exclusions without a local patch', () => {
    const notes: string[] = crossCheckTemperatureSupport(snapshot.models);

    expect(notes).toEqual([
      'gpt-5.6-luna: resolver snapshot rejects temperature; transport override is awaiting live validation before a local PATCHES entry',
    ]);
    expect(notes.join('\n')).not.toContain('missing local PATCHES entry');
  });

  it('rejects an unreviewed transport divergence before anything is generated', () => {
    // kimi-k3 is Chat Completions in both the snapshot and TRANSPORTS. Flip the
    // snapshot alone and the update must stop: nobody has reviewed that route.
    const mutated = snapshot.models.map(model => (model.id === 'kimi-k3'
      ? { ...structuredClone(model), api: { ...model.api, npm: '@ai-sdk/anthropic' } }
      : model));
    expect(() => convertResolvedModels(mutated))
      .toThrow(/kimi-k3: resolver snapshot routes anthropic-messages but clodex routes openai-completions/);
  });

  it('rejects a reviewed override whose divergence no longer matches the snapshot', () => {
    const agreeing = overriddenRows().map(model => ({
      ...model,
      api: { ...model.api, npm: '@ai-sdk/openai-compatible' },
    }));
    expect(() => crossCheckTransports(agreeing)).toThrow(/transport override is stale/);

    const moved = overriddenRows().map(model => (model.id === 'minimax-m2.7'
      ? { ...model, api: { ...model.api, npm: '@ai-sdk/openai' } }
      : model));
    expect(() => crossCheckTransports(moved))
      .toThrow(/minimax-m2\.7: transport override expects the snapshot to route anthropic-messages/);
  });

  it('leaves prototype-named and unreviewed ids out of the catalog', () => {
    const hostile = ['__proto__', 'constructor', 'hasOwnProperty', 'toString'];
    const rows = [
      ...snapshot.models.map(model => structuredClone(model) as ResolvedModel),
      ...hostile.map(id => resolvedModel(id, '@ai-sdk/openai-compatible')),
    ];
    const { supported, unmapped } = convertResolvedModels(rows);
    expect(supported.map((model: { id: string }) => model.id)).toEqual(REVIEWED_IDS);
    expect(unmapped).toEqual(['__proto__', 'constructor', 'grok-4.5', 'hasOwnProperty', 'toString']);
  });

  it.each([
    ['an Authorization header', (model: ResolvedModel) => { model.headers.Authorization = 'Bearer secret'; }, /headers: must be empty, found forbidden key/],
    ['a request option', (model: ResolvedModel) => { model.options.apiKey = 'secret'; }, /options: must be empty, found forbidden key/],
    ['URL credentials', (model: ResolvedModel) => { model.api.url = 'https://user:pass@opencode.ai/zen/go/v1'; }, /api\.url must be exactly/],
    ['an unknown SDK package', (model: ResolvedModel) => { model.api.npm = '@ai-sdk/future'; }, /unsupported SDK transport/],
    ['an unknown row field', (model: ResolvedModel) => { model.telemetry = 'unexpected'; }, /unsupported key telemetry/],
    ['a withdrawn status', (model: ResolvedModel) => { model.status = 'deprecated'; }, /status must be active/],
    ['a string cost', (model: ResolvedModel) => { model.cost.input = '1'; }, /non-negative finite number/],
    ['a control-character id', (model: ResolvedModel) => { model.id = 'bad\nid'; model.api.id = 'bad\nid'; }, /printable non-empty string/],
    ['a row with a malformed tool capability', (model: ResolvedModel) => { model.capabilities.toolcall = 'false'; }, /capabilities\.toolcall: expected a boolean/],
    ['a duplicate id', (model: ResolvedModel) => { model.id = 'kimi-k3'; model.api.id = 'kimi-k3'; }, /duplicate id kimi-k3/],
  ])('rejects %s at the committed snapshot boundary', (_label, mutate, expected) => {
    const rows = snapshot.models.map(model => structuredClone(model) as ResolvedModel);
    const extra = resolvedModel('unreviewed-row', '@ai-sdk/openai-compatible');
    mutate(extra);
    expect(() => assertResolvedModels([...rows, extra])).toThrow(expected);
  });

  it.each([
    ['text input', (model: ResolvedModel) => { model.capabilities.input.text = false; }],
    ['text output', (model: ResolvedModel) => { model.capabilities.output.text = false; }],
    ['tool calls', (model: ResolvedModel) => { model.capabilities.toolcall = false; }],
  ])('rejects a mapped row without %s', (_label, mutate) => {
    const rows = snapshot.models.map(model => structuredClone(model) as ResolvedModel);
    const mapped = rows.find(model => model.id === 'deepseek-v4-flash')!;
    mutate(mapped);
    expect(() => convertResolvedModels(rows))
      .toThrow(/deepseek-v4-flash: supported models must declare text input, text output, and tool calls/);
  });

  it.each([
    ['text/tool-capable', resolvedModel('unmapped-text-tools', '@ai-sdk/openai-compatible')],
    ['audio/image/non-tool', resolvedModel('unmapped-audio-image', '@ai-sdk/openai-compatible', {
      capabilities: {
        attachment: false,
        input: { audio: true, image: true, pdf: false, text: false, video: false },
        interleaved: false,
        output: { audio: true, image: true, pdf: false, text: false, video: false },
        reasoning: false,
        temperature: false,
        toolcall: false,
      },
    })],
  ])('reports a valid unmapped %s row without generating it', (_label, extra) => {
    const rows = [
      ...snapshot.models.map(model => structuredClone(model) as ResolvedModel),
      extra,
    ];
    const { supported, unmapped } = convertResolvedModels(rows);
    expect(supported.map((model: { id: string }) => model.id)).toEqual(REVIEWED_IDS);
    expect(unmapped).toEqual(['grok-4.5', extra.id]);
    expect(supported.map((model: { id: string }) => model.id)).not.toContain(extra.id);
  });

  it('rejects a capture whose release tag and version disagree', () => {
    expect(() => assertSnapshotMeta({ ...snapshot._meta, releaseTag: 'v1.18.14' }))
      .toThrow(/release-tag must equal v<openCodeVersion>/);
    expect(() => assertSnapshotMeta({ ...snapshot._meta, normalizedModelsSha256: 'NOTHEX' }))
      .toThrow(/expected 64 lowercase hex characters/);
  });

  it('verifies the committed catalog offline, with no fetch and no write', async () => {
    const before = await Promise.all([CATALOG_PATH, SNAPSHOT_PATH, CONSTANTS_PATH].map(async path => ({
      bytes: await readFile(path),
      mtimeMs: (await stat(path)).mtimeMs,
    })));
    // Any network reach during --check is a defect, not a slow path.
    const fetchSpy = vi.fn(() => {
      throw new Error('--check must not reach the network');
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(run(['--check'])).resolves.toBeUndefined();
    // The documented invocation is `pnpm update:opencode-go -- --check`, which
    // forwards the separator; it must reach the same offline path.
    await expect(run(['--', '--check'])).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    const after = await Promise.all([CATALOG_PATH, SNAPSHOT_PATH, CONSTANTS_PATH].map(async path => ({
      bytes: await readFile(path),
      mtimeMs: (await stat(path)).mtimeMs,
    })));
    expect(after.map(entry => entry.bytes.toString('hex'))).toEqual(before.map(entry => entry.bytes.toString('hex')));
    expect(after.map(entry => entry.mtimeMs)).toEqual(before.map(entry => entry.mtimeMs));
  });

  it.each<[string, (rows: ResolvedModel[]) => string]>([
    ['compact JSON with the same object values', rows => JSON.stringify(rows)],
    [
      'reordered keys with the same values',
      rows => {
        const [first, ...rest] = rows;
        return `${JSON.stringify([Object.fromEntries(Object.entries(first).reverse()), ...rest], null, 2)}\n`;
      },
    ],
    ['missing trailing newline', rows => `${JSON.stringify(rows, null, 2)}`],
  ])('rejects serialization-only catalog drift without writing for %s', async (_label, serializeDrift) => {
    const workspace = mkdtempSync(join(tmpdir(), 'clodex-opencode-go-byte-drift-'));
    try {
      mkdirSync(join(workspace, 'src', 'data'), { recursive: true });
      copyFileSync(CATALOG_PATH, join(workspace, 'src', 'data', 'opencode-go-models.json'));
      copyFileSync(CONSTANTS_PATH, join(workspace, 'src', 'data', 'opencode-go-models.ts'));
      const noNetwork = join(workspace, 'no-network.mjs');
      writeFileSync(
        noNetwork,
        "globalThis.fetch = () => { throw new Error('this mode must not reach the network'); };\n",
      );
      const catalogPath = join(workspace, 'src', 'data', 'opencode-go-models.json');
      const original = await readFile(catalogPath, 'utf8');
      const drifted = serializeDrift(JSON.parse(original));
      expect(drifted).not.toBe(original);
      writeFileSync(catalogPath, drifted);
      const beforeMtime = (await stat(catalogPath)).mtimeMs;

      const checked = spawnSync(
        process.execPath,
        ['--import', pathToFileURL(noNetwork).href, resolve('scripts/update-opencode-go-models.mjs'), '--check'],
        { cwd: workspace, encoding: 'utf8' },
      );

      expect(checked.error).toBeUndefined();
      expect(checked.status).not.toBe(0);
      expect(checked.stderr).toContain('OpenCode Go catalog is out of date with its committed resolver snapshot');
      expect(await readFile(catalogPath, 'utf8')).toBe(drifted);
      expect((await stat(catalogPath)).mtimeMs).toBe(beforeMtime);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('regenerates and verifies the committed files with the maintained command, offline', async () => {
    // The maintained command itself, not an approximation of it: if a flag is
    // ever added to package.json, the default path this proves stops being the
    // one a maintainer actually runs.
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    expect(pkg.scripts['update:opencode-go']).toBe('node scripts/update-opencode-go-models.mjs');
    const [node, ...scriptArgs] = pkg.scripts['update:opencode-go'].split(' ');
    expect(node).toBe('node');
    const commandArgv = [resolve(scriptArgs[0]!), ...scriptArgs.slice(1)];

    const committedCatalog = await readFile(CATALOG_PATH);
    const committedConstants = await readFile(CONSTANTS_PATH);
    const workspace = mkdtempSync(join(tmpdir(), 'clodex-opencode-go-offline-'));
    try {
      mkdirSync(join(workspace, 'src', 'data'), { recursive: true });
      // Seeded with the committed provenance module, because regeneration
      // rewrites it in place — reproducing it byte for byte is the proof that
      // nothing on the write path reads a clock or the network.
      copyFileSync(CONSTANTS_PATH, join(workspace, 'src', 'data', 'opencode-go-models.ts'));
      const noNetwork = join(workspace, 'no-network.mjs');
      writeFileSync(
        noNetwork,
        "globalThis.fetch = () => { throw new Error('this mode must not reach the network'); };\n",
      );
      const preload = ['--import', pathToFileURL(noNetwork).href];

      const regenerated = spawnSync(process.execPath, [...preload, ...commandArgv], {
        cwd: workspace,
        encoding: 'utf8',
      });
      expect(regenerated.error).toBeUndefined();
      expect(regenerated.status, regenerated.stderr).toBe(0);
      expect(regenerated.stdout).toContain('committed resolver snapshot');
      expect(regenerated.stdout).toContain('Effort ladders not cross-checked');

      const catalogPath = join(workspace, 'src', 'data', 'opencode-go-models.json');
      const constantsPath = join(workspace, 'src', 'data', 'opencode-go-models.ts');
      expect(await readFile(catalogPath)).toEqual(committedCatalog);
      expect(await readFile(constantsPath)).toEqual(committedConstants);

      // ...and the offline verifier agrees, from a cwd that is not the repo.
      const before = [catalogPath, constantsPath].map(path => stat(path));
      const beforeMtimes = (await Promise.all(before)).map(entry => entry.mtimeMs);
      const checked = spawnSync(process.execPath, [...preload, ...commandArgv, '--check'], {
        cwd: workspace,
        encoding: 'utf8',
      });
      expect(checked.status, checked.stderr).toBe(0);
      expect(checked.stdout).toContain('matches the committed resolver snapshot');
      const afterMtimes = await Promise.all(
        [catalogPath, constantsPath].map(async path => (await stat(path)).mtimeMs),
      );
      expect(afterMtimes).toEqual(beforeMtimes);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'the feed is unreachable',
      () => {
        throw new Error('models.dev is down');
      },
      /models\.dev is down/,
    ],
    [
      'the feed has dropped a model this catalog still routes',
      async () => ({ ok: true, json: async () => ({ 'opencode-go': { models: { 'kimi-k3': {} } } }) }),
      /Transport-mapped models missing from models\.dev: /,
    ],
    [
      'the feed publishes a narrower ladder than a local map sends',
      async () => ({
        ok: true,
        json: async () => ({
          'opencode-go': {
            models: Object.fromEntries(REVIEWED_IDS.map(id => [id, {
              reasoning_options: [{ type: 'effort', values: ['low'] }],
            }])),
          },
        }),
      }),
      /models\.dev does not publish/,
    ],
  ])('--verify-ladders fails before any write when %s', async (_label, stub, expected) => {
    const before = await Promise.all([CATALOG_PATH, CONSTANTS_PATH].map(async path => ({
      bytes: await readFile(path),
      mtimeMs: (await stat(path)).mtimeMs,
    })));
    vi.stubGlobal('fetch', vi.fn(stub));

    await expect(run(['--verify-ladders'])).rejects.toThrow(expected);

    const after = await Promise.all([CATALOG_PATH, CONSTANTS_PATH].map(async path => ({
      bytes: await readFile(path),
      mtimeMs: (await stat(path)).mtimeMs,
    })));
    expect(after).toEqual(before);
  });

  it('refuses to combine the offline verifier with the networked one', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('mode validation must fail before any fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(run(['--check', '--verify-ladders'])).rejects.toThrow(/pick one/);
    await expect(run(['--', '--check', '--verify-ladders'])).rejects.toThrow(/pick one/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown flag instead of falling through to a live refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('argument parsing must fail before any fetch');
    }));
    await expect(run(['--refresh-everything'])).rejects.toThrow(/Unknown option/);
  });

  it('keeps the resolver snapshot out of the shipped runtime', async () => {
    // Mechanical, not a spot-check: the runtime must name its provenance
    // through the mirrored constants, never by bundling an 18-model resolver
    // dump that carries routes this provider deliberately does not serve.
    const loadsSnapshot = /(?:^|[^\w])(?:from|import|require)\s*\(?\s*['"][^'"]*opencode-go-cli-snapshot[^'"]*['"]/;
    const referencing: string[] = [];
    for (const entry of await readdir('src', { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const path = join(entry.parentPath ?? entry.path, entry.name);
      if (loadsSnapshot.test(await readFile(path, 'utf8'))) referencing.push(path);
    }
    expect(referencing).toEqual([]);
  });
});
