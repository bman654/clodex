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
  assertEffortMapsIdempotent,
  assertResolvedModels,
  assertSnapshotMeta,
  buildEffortProfiles,
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
const EFFORT_PROFILES_PATH = 'src/data/opencode-go-effort-profiles.json';

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
    ['a dual-representation effort variant', (model: ResolvedModel) => {
      model.variants.both = { reasoningEffort: 'high', thinking: { type: 'enabled' } };
    }, /variants\.both: reasoningEffort and thinking cannot both be declared/],
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
    const before = await Promise.all([CATALOG_PATH, SNAPSHOT_PATH, CONSTANTS_PATH, EFFORT_PROFILES_PATH].map(async path => ({
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
    const after = await Promise.all([CATALOG_PATH, SNAPSHOT_PATH, CONSTANTS_PATH, EFFORT_PROFILES_PATH].map(async path => ({
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
      copyFileSync(EFFORT_PROFILES_PATH, join(workspace, 'src', 'data', 'opencode-go-effort-profiles.json'));
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
    const committedProfiles = await readFile(EFFORT_PROFILES_PATH);
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
      const profilesPath = join(workspace, 'src', 'data', 'opencode-go-effort-profiles.json');
      expect(await readFile(catalogPath)).toEqual(committedCatalog);
      expect(await readFile(constantsPath)).toEqual(committedConstants);
      expect(await readFile(profilesPath)).toEqual(committedProfiles);

      // ...and the offline verifier agrees, from a cwd that is not the repo.
      const before = [catalogPath, constantsPath, profilesPath].map(path => stat(path));
      const beforeMtimes = (await Promise.all(before)).map(entry => entry.mtimeMs);
      const checked = spawnSync(process.execPath, [...preload, ...commandArgv, '--check'], {
        cwd: workspace,
        encoding: 'utf8',
      });
      expect(checked.status, checked.stderr).toBe(0);
      expect(checked.stdout).toContain('matches the committed resolver snapshot');
      const afterMtimes = await Promise.all(
        [catalogPath, constantsPath, profilesPath].map(async path => (await stat(path)).mtimeMs),
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
    const before = await Promise.all([CATALOG_PATH, CONSTANTS_PATH, EFFORT_PROFILES_PATH].map(async path => ({
      bytes: await readFile(path),
      mtimeMs: (await stat(path)).mtimeMs,
    })));
    vi.stubGlobal('fetch', vi.fn(stub));

    await expect(run(['--verify-ladders'])).rejects.toThrow(expected);

    const after = await Promise.all([CATALOG_PATH, CONSTANTS_PATH, EFFORT_PROFILES_PATH].map(async path => ({
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

/**
 * The validated effort table, one row per reviewed model: id, the route clodex
 * runs, and every global effort level that route can actually execute paired
 * with the exact value it puts on the wire.
 *
 * A per-model table rather than a spot-check, and deliberately redundant with
 * `PATCHES`: this is the reviewed statement of what the global effort policy is
 * allowed to resolve to. A regeneration that widens a ladder, drops a level, or
 * lets a resolver variant reach the wire should fail here with the id named.
 */
const EXECUTABLE_INTERSECTION: Array<[string, string, Array<[string, string]>]> = [
  ['deepseek-v4-flash', 'openai-completions', [['high', 'high'], ['max', 'max']]],
  ['deepseek-v4-pro', 'openai-completions', [['high', 'high'], ['max', 'max']]],
  ['glm-5.1', 'openai-completions', []],
  ['glm-5.2', 'openai-completions', [['high', 'high'], ['max', 'max']]],
  ['gpt-5.6-luna', 'openai-completions', [
    ['off', 'none'], ['low', 'low'], ['medium', 'medium'],
    ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max'],
  ]],
  ['hy3', 'openai-completions', [['off', 'none'], ['low', 'low'], ['high', 'high']]],
  ['kimi-k2.6', 'openai-completions', []],
  ['kimi-k2.7-code', 'openai-completions', []],
  ['kimi-k3', 'openai-completions', [['max', 'max']]],
  ['mimo-v2.5', 'openai-completions', []],
  ['mimo-v2.5-pro', 'openai-completions', []],
  ['minimax-m2.7', 'openai-completions', []],
  ['minimax-m3', 'anthropic-messages', []],
  ['qwen3.6-plus', 'openai-completions', [
    ['low', 'low'], ['medium', 'medium'], ['high', 'high'],
    ['xhigh', 'xhigh'], ['max', 'max'],
  ]],
  ['qwen3.7-max', 'anthropic-messages', []],
  ['qwen3.7-plus', 'anthropic-messages', []],
  ['qwen3.8-max', 'anthropic-messages', []],
];

type EffortProfileTable = {
  schemaVersion: number;
  provider: string;
  profiles: Array<{
    modelId: string;
    transport: string;
    defaultLevel: string | null;
    levels: Array<{ level: string; native: { kind: string; value: string } }>;
  }>;
  disagreements: Array<{
    modelId: string;
    variant: string | null;
    advertised: Record<string, unknown> | null;
    reason: string;
  }>;
};

function generatedProfiles(): EffortProfileTable {
  return convertResolvedModels(snapshot.models).effortProfiles as EffortProfileTable;
}

describe('OpenCode Go validated effort profiles', () => {
  it('regenerates the committed profile table byte for byte', async () => {
    const committed = await readFile(EFFORT_PROFILES_PATH, 'utf8');
    expect(committed).toBe(`${JSON.stringify(generatedProfiles(), null, 2)}\n`);
    expect(JSON.parse(committed)).toMatchObject({ schemaVersion: 1, provider: 'opencode-go' });
  });

  it('exposes exactly the levels the reviewed wire maps can execute', () => {
    const table = generatedProfiles();
    expect(table.profiles.map(profile => profile.modelId))
      .toEqual(EXECUTABLE_INTERSECTION.map(([id]) => id));
    const byId = new Map(table.profiles.map(profile => [profile.modelId, profile]));
    for (const [id, transport, levels] of EXECUTABLE_INTERSECTION) {
      const profile = byId.get(id)!;
      expect(profile.transport, id).toBe(transport);
      expect(profile.levels.map(entry => [entry.level, entry.native.value]), id).toEqual(levels);
      for (const entry of profile.levels) {
        expect(entry.native.kind, `${id}.${entry.level}`).toBe('reasoning-effort');
      }
    }
  });

  it('declares no default for any model, because the resolver declares none', () => {
    // The snapshot names variants but never a default among them, and inventing
    // one here would silently change every request that omits an effort.
    for (const profile of generatedProfiles().profiles) {
      expect(profile.defaultLevel, profile.modelId).toBeNull();
    }
  });

  it('denies every Anthropic thinking representation the running transport cannot carry', () => {
    const denied = generatedProfiles().disagreements
      .filter(entry => entry.advertised?.kind === 'anthropic-thinking')
      .map(entry => `${entry.modelId}/${entry.variant}`);

    // qwen3.6-plus is the case where the resolver advertises Anthropic budgets
    // for a model clodex runs over Chat Completions: the budgets are denied, and
    // the reviewed effort map — not the snapshot — governs that route.
    expect(denied).toEqual([
      'minimax-m3/none', 'minimax-m3/thinking',
      'qwen3.6-plus/high', 'qwen3.6-plus/max',
      'qwen3.7-max/high', 'qwen3.7-max/max',
      'qwen3.7-plus/high', 'qwen3.7-plus/max',
      'qwen3.8-max/high', 'qwen3.8-max/max',
    ]);
    const qwen36 = generatedProfiles().profiles.find(profile => profile.modelId === 'qwen3.6-plus')!;
    for (const entry of qwen36.levels) {
      expect(entry.native.kind).toBe('reasoning-effort');
      expect(entry.native).not.toHaveProperty('thinking');
    }
  });

  it('reports an advertised variant the reviewed map cannot execute instead of exposing it', () => {
    const table = generatedProfiles();
    // The resolver advertises `low` for DeepSeek V4 Flash; the reviewed map sends
    // nothing for it, so the level must not reach the profile.
    expect(table.disagreements).toContainEqual({
      modelId: 'deepseek-v4-flash',
      variant: 'low',
      advertised: { kind: 'reasoning-effort', value: 'low' },
      reason: 'the reviewed wire map sends this value for no global effort level',
    });
    const flash = table.profiles.find(profile => profile.modelId === 'deepseek-v4-flash')!;
    expect(flash.levels.map(entry => entry.level)).not.toContain('low');
  });

  it('reports executable levels the resolver snapshot does not advertise', () => {
    expect(generatedProfiles().disagreements).toContainEqual({
      modelId: 'qwen3.6-plus',
      variant: null,
      advertised: null,
      reason: 'the reviewed wire map executes low/medium/high/xhigh/max, which the resolver snapshot does not advertise',
    });
  });

  it('records every disagreement and nothing else', () => {
    const table = generatedProfiles();
    expect(table.disagreements).toHaveLength(12);
    expect(new Set(table.disagreements.map(entry => entry.modelId))).toEqual(new Set([
      'deepseek-v4-flash', 'minimax-m3', 'qwen3.6-plus',
      'qwen3.7-max', 'qwen3.7-plus', 'qwen3.8-max',
    ]));
  });

  it('accepts the committed maps as idempotent and injective', () => {
    expect(assertEffortMapsIdempotent()).toBe(true);
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    [
      // The double-map hazard exactly: the SDK path would send low as `high`,
      // and the post-serialization transform would then translate that `high`
      // again into `max`.
      'a map that re-maps one of its own outputs',
      { 'deepseek-v4-flash': { reasoningEffortMap: { low: 'high', high: 'max' } } },
      /is not idempotent/,
    ],
    [
      'a map that sends one native value for two levels',
      { 'gpt-5.6-luna': { reasoningEffortMap: { high: 'high', xhigh: 'high' } } },
      /sends "high" for both high and xhigh/,
    ],
    [
      'a map keyed on a level outside the global vocabulary',
      { hy3: { reasoningEffortMap: { turbo: 'high' } } },
      /is not a global effort level/,
    ],
    [
      'a map that blanks a level instead of disabling it',
      { 'kimi-k3': { reasoningEffortMap: { max: '  ' } } },
      /must be null or a non-empty string/,
    ],
  ])('refuses to generate from %s', (_label, patches, expected) => {
    expect(() => assertEffortMapsIdempotent(patches)).toThrow(expected);
  });

  it('refuses a catalog row that states neither a map nor an explicit suppression', () => {
    expect(() => buildEffortProfiles(snapshot.models, [{ id: 'kimi-k3', compatibility: {} }]))
      .toThrow(/kimi-k3: has neither a reviewed reasoningEffortMap nor an explicit/);
  });

  it('rejects stale committed profile bytes offline, without writing', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'clodex-opencode-go-profile-drift-'));
    try {
      mkdirSync(join(workspace, 'src', 'data'), { recursive: true });
      copyFileSync(CATALOG_PATH, join(workspace, 'src', 'data', 'opencode-go-models.json'));
      copyFileSync(CONSTANTS_PATH, join(workspace, 'src', 'data', 'opencode-go-models.ts'));
      const profilesPath = join(workspace, 'src', 'data', 'opencode-go-effort-profiles.json');
      const stale = JSON.parse(await readFile(EFFORT_PROFILES_PATH, 'utf8')) as EffortProfileTable;
      // Exactly the widening this table exists to prevent: a hand-added level
      // that no reviewed wire map executes.
      stale.profiles.find(profile => profile.modelId === 'deepseek-v4-flash')!.levels
        .unshift({ level: 'low', native: { kind: 'reasoning-effort', value: 'low' } });
      writeFileSync(profilesPath, `${JSON.stringify(stale, null, 2)}\n`);
      const beforeMtime = (await stat(profilesPath)).mtimeMs;
      const noNetwork = join(workspace, 'no-network.mjs');
      writeFileSync(
        noNetwork,
        "globalThis.fetch = () => { throw new Error('this mode must not reach the network'); };\n",
      );

      const checked = spawnSync(
        process.execPath,
        ['--import', pathToFileURL(noNetwork).href, resolve('scripts/update-opencode-go-models.mjs'), '--check'],
        { cwd: workspace, encoding: 'utf8' },
      );

      expect(checked.error).toBeUndefined();
      expect(checked.status).not.toBe(0);
      expect(checked.stderr).toContain('opencode-go-effort-profiles.json disagrees with the resolver snapshot');
      expect((await stat(profilesPath)).mtimeMs).toBe(beforeMtime);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
