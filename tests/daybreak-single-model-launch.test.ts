// `clodex claude --endpoint --provider … --model …` (or print mode) serves ONE
// model and answers every model id it does not know with it. A Daybreak alias
// must not ride that fallback without its program. Runs the real launch path;
// the provider catalog, the child process and model generation are the seams.
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { launchClaude } from '../src/launch.js';
import { generateAnthropicResponse } from '../src/sdk-adapter.js';
import { fetchProviderCatalog, resolveLocalProviderApiKey } from '../src/provider-catalog.js';
import { parseArgs, runClaudeCommand } from '../src/cli.js';
import { savePreferences } from '../src/config.js';
import type { CyberAccessProgram } from '../src/daybreak.js';
import type { LocalProvider, ModelAlias } from '../src/types.js';

vi.mock('../src/launch.js', async original => ({
  ...await original<typeof import('../src/launch.js')>(),
  findClaudeBinary: vi.fn(() => '/fake/claude'),
  launchClaude: vi.fn(async () => 0),
}));
vi.mock('../src/first-run.js', async original => ({
  ...await original<typeof import('../src/first-run.js')>(),
  needsFirstRunSetup: vi.fn(async () => false),
}));
vi.mock('../src/patcher.js', async original => ({
  ...await original<typeof import('../src/patcher.js')>(),
  runLaunchPatchCheck: vi.fn(async () => undefined),
}));
vi.mock('../src/provider-catalog.js', async original => ({
  ...await original<typeof import('../src/provider-catalog.js')>(),
  fetchProviderCatalog: vi.fn(),
  resolveLocalProviderApiKey: vi.fn(),
}));
vi.mock('../src/provider-factory.js', async original => ({
  ...await original<typeof import('../src/provider-factory.js')>(),
  createLanguageModel: vi.fn(async (spec: unknown) => ({ spec })),
}));
vi.mock('../src/sdk-adapter.js', async original => ({
  ...await original<typeof import('../src/sdk-adapter.js')>(),
  generateAnthropicResponse: vi.fn(async (_model: unknown, _params: unknown, model: string) => ({
    id: 'msg_test', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  })),
}));

type Reply = { status: number; body: { error?: { message?: string } } };

function post(env: NodeJS.ProcessEnv, model: string): Promise<Reply> {
  const url = new URL('/v1/messages', env.ANTHROPIC_BASE_URL!);
  const body = JSON.stringify({ model, max_tokens: 16, stream: false, messages: [{ role: 'user', content: 'hi' }] });
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-api-key': env.ANTHROPIC_API_KEY!,
      },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function provider(lunaPrograms: CyberAccessProgram[]): LocalProvider {
  const model = (id: string, cyberAccessPrograms: CyberAccessProgram[]) => ({
    id, upstreamModelId: id, name: id, family: 'gpt', brand: 'OpenAI',
    modelFormat: 'openai' as const, npm: '@ai-sdk/openai', contextWindow: 272_000, cyberAccessPrograms,
  });
  return {
    id: 'openai-oauth', name: 'OpenAI (ChatGPT)', apiKey: 'tok', authType: 'oauth',
    models: [model('gpt-6-luna', lunaPrograms), model('gpt-6-sol', ['standard', 'daybreak_blue'])],
  };
}

const SAVED_ALIASES: ModelAlias[] = [
  { name: 'blue', providerId: 'openai-oauth', modelId: 'gpt-6-luna', daybreak: true },
  { name: 'sol-blue', providerId: 'openai-oauth', modelId: 'gpt-6-sol', daybreak: true },
  { name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-6-sol' },
];

/** Launch gpt-6-luna on its own and send one request for `model` from the child. */
async function launchAndSend(
  lunaPrograms: CyberAccessProgram[],
  model: string,
  modelAliases: ModelAlias[] = SAVED_ALIASES,
): Promise<Reply> {
  savePreferences({
    favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-6-luna' }],
    modelAliases,
  });
  vi.mocked(fetchProviderCatalog).mockResolvedValue(
    Object.assign([provider(lunaPrograms)], { blockedProviders: new Map() }),
  );
  vi.mocked(resolveLocalProviderApiKey).mockResolvedValue('tok');
  let reply: Reply | undefined;
  vi.mocked(launchClaude).mockImplementation(async env => {
    reply = await post(env, model);
    return 0;
  });
  const code = await runClaudeCommand(parseArgs([
    'claude', '--endpoint', '--provider', 'openai-oauth', '--model', 'gpt-6-luna', '--', '-p', 'hi',
  ]));
  expect(code).toBe(0);
  return reply!;
}

function servedProgram(): unknown {
  const model = vi.mocked(generateAnthropicResponse).mock.calls.at(-1)?.[0] as unknown as
    { spec: { accessPrograms?: unknown } } | undefined;
  return model?.spec.accessPrograms;
}

afterEach(() => vi.clearAllMocks());

describe('Daybreak aliases on a single-model endpoint launch', () => {
  it('send the program for an alias of the launched model', async () => {
    expect((await launchAndSend(['standard', 'daybreak_blue'], 'blue')).status).toBe(200);
    expect(servedProgram()).toEqual({ cyber: 'daybreak_blue' });
  }, 60_000);

  it('refuse an alias whose model does not offer Daybreak', async () => {
    const reply = await launchAndSend(['standard'], 'blue');
    expect(reply.status).toBe(400);
    expect(reply.body.error?.message).toContain("Daybreak isn't available for gpt-6-luna");
    expect(generateAnthropicResponse).not.toHaveBeenCalled();
  }, 60_000);

  it('refuse a Daybreak alias for a model this launch does not serve', async () => {
    const reply = await launchAndSend(['standard', 'daybreak_blue'], 'sol-blue');
    expect(reply.status).toBe(400);
    expect(reply.body.error?.message).toContain('this launch serves only clodex:openai-oauth:gpt-6-luna');
    expect(generateAnthropicResponse).not.toHaveBeenCalled();
  }, 60_000);

  // A rejected saved name that asked for Daybreak must still be refused rather
  // than fall back to the plain launched model.
  it.each([
    ['spellings that conflict', [
      { name: 'blue', providerId: 'openai-oauth', modelId: 'gpt-6-luna', daybreak: true },
      { name: 'BLUE', providerId: 'openai-oauth', modelId: 'gpt-6-luna' },
    ], 'conflicting targets'],
    ['a daybreak value that is not a boolean', [
      { name: 'blue', providerId: 'openai-oauth', modelId: 'gpt-6-luna', daybreak: 'true' },
    ], '"daybreak" must be true or false'],
  ])('refuse a Daybreak name with %s', async (_label, saved, reason) => {
    const reply = await launchAndSend(['standard', 'daybreak_blue'], 'blue', saved as ModelAlias[]);
    expect(reply.status).toBe(400);
    expect(reply.body.error?.message).toContain(reason);
    expect(generateAnthropicResponse).not.toHaveBeenCalled();
  }, 60_000);

  it('leave other aliases on the single-model fallback, without a program', async () => {
    expect((await launchAndSend(['standard', 'daybreak_blue'], 'sol')).status).toBe(200);
    expect(servedProgram()).toBeUndefined();
  }, 60_000);
});
