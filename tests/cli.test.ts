// tests/cli.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as p from '@clack/prompts';
import { parseArgs, rootHelpText, claudeHelpText, serverHelpText, modelsHelpText, patchHelpText, main, runClaudeCommand } from '../src/cli.js';
import { VERSION } from '../src/constants.js';
import { fetchProviderCatalog, resolveLocalProviderApiKey } from '../src/provider-catalog.js';
import { startProxy } from '../src/proxy.js';
import { launchClaude } from '../src/launch.js';

vi.mock('../src/launch.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/launch.js')>();
  return {
    ...actual,
    findClaudeBinary: vi.fn(() => '/fake/claude'),
    launchClaude: vi.fn(async () => 0),
  };
});

vi.mock('../src/proxy.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/proxy.js')>();
  return { ...actual, startProxy: vi.fn() };
});

vi.mock('../src/first-run.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/first-run.js')>();
  return { ...actual, needsFirstRunSetup: vi.fn(async () => false) };
});

vi.mock('../src/patcher.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/patcher.js')>();
  return { ...actual, runLaunchPatchCheck: vi.fn(async () => undefined) };
});

vi.mock('../src/provider-catalog.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/provider-catalog.js')>();
  return {
    ...actual,
    fetchProviderCatalog: vi.fn(),
    resolveLocalProviderApiKey: vi.fn(),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseArgs', () => {
  it('parses bare root command without launching claude', () => {
    expect(parseArgs([])).toEqual({
      command: 'root',
      showHelp: true,
      showVersion: false,
      dryRun: false,
      trace: false,
      claudeArgs: [],
    });
  });

  it('parses root help and version', () => {
    expect(parseArgs(['--help'])).toMatchObject({ command: 'root', showHelp: true });
    expect(parseArgs(['-h'])).toMatchObject({ command: 'root', showHelp: true });
    expect(parseArgs(['--version'])).toMatchObject({ command: 'root', showVersion: true });
    expect(parseArgs(['-v'])).toMatchObject({ command: 'root', showVersion: true });
  });

  it('parses claude command with no passthrough args', () => {
    expect(parseArgs(['claude'])).toMatchObject({
      command: 'claude',
      showHelp: false,
      dryRun: false,
      trace: false,
      claudeArgs: [],
    });
  });

  it('parses bridge-mode flags on claude and server', () => {
    expect(parseArgs(['claude', '--proxy', '-c'])).toMatchObject({
      command: 'claude',
      bridgeMode: 'proxy',
      claudeArgs: ['-c'],
    });
    expect(parseArgs(['claude', '--endpoint'])).toMatchObject({
      command: 'claude',
      bridgeMode: 'endpoint',
    });
    expect(parseArgs(['server', '--proxy'])).toMatchObject({
      command: 'server',
      bridgeMode: 'proxy',
    });
    expect(parseArgs(['server', '--endpoint'])).toMatchObject({
      command: 'server',
      bridgeMode: 'endpoint',
    });
    // bare commands leave bridgeMode undefined so the saved default applies
    expect(parseArgs(['claude']).bridgeMode).toBeUndefined();
    expect(parseArgs(['server']).bridgeMode).toBeUndefined();
  });

  it('rejects the removed --http-proxy alias', () => {
    // claude passes unknown flags through to Claude Code rather than erroring
    expect(parseArgs(['claude', '--http-proxy'])).toMatchObject({
      command: 'claude',
      claudeArgs: ['--http-proxy'],
    });
    expect(parseArgs(['claude', '--http-proxy']).bridgeMode).toBeUndefined();
    expect(parseArgs(['server', '--http-proxy'])).toMatchObject({
      error: 'Unknown server option: --http-proxy',
    });
  });

  it('parses --save-mode only together with a bridge-mode flag', () => {
    expect(parseArgs(['claude', '--proxy', '--save-mode'])).toMatchObject({
      command: 'claude',
      bridgeMode: 'proxy',
      saveBridgeMode: true,
    });
    expect(parseArgs(['server', '--endpoint', '--save-mode'])).toMatchObject({
      command: 'server',
      bridgeMode: 'endpoint',
      saveBridgeMode: true,
    });
    // order does not matter
    expect(parseArgs(['server', '--save-mode', '--proxy'])).toMatchObject({
      bridgeMode: 'proxy',
      saveBridgeMode: true,
    });
    // --save-mode without a mode flag is an error with guidance
    expect(parseArgs(['claude', '--save-mode']).error).toContain('--endpoint or --proxy');
    expect(parseArgs(['server', '--save-mode']).error).toContain('--endpoint or --proxy');
  });

  it('parses claude dry-run, trace, and passthrough flags', () => {
    expect(parseArgs(['claude', '--dry-run', '-c'])).toMatchObject({
      command: 'claude',
      dryRun: true,
      claudeArgs: ['-c'],
    });
    expect(parseArgs(['claude', '--trace', '--resume', 'abc-123'])).toMatchObject({
      command: 'claude',
      trace: true,
      claudeArgs: ['--resume', 'abc-123'],
    });
    expect(parseArgs(['claude', '--', '--print', 'hello'])).toMatchObject({
      command: 'claude',
      claudeArgs: ['--print', 'hello'],
    });
    // --fast is a clodex launch flag (Codex fast mode), never forwarded to the child CLI.
    expect(parseArgs(['claude', '--fast', '-c'])).toMatchObject({
      command: 'claude',
      fast: true,
      claudeArgs: ['-c'],
    });
  });

  it('parses claude boot provider/model flags', () => {
    expect(parseArgs(['claude', '--provider', 'openai-oauth', '--model', 'gpt-5.6-sol'])).toMatchObject({
      command: 'claude',
      launchProvider: 'openai-oauth',
      launchModel: 'gpt-5.6-sol',
      claudeArgs: [],
    });
    expect(parseArgs(['claude', '--provider=openai', '--model=gpt-5.5'])).toMatchObject({
      launchProvider: 'openai',
      launchModel: 'gpt-5.5',
    });
    expect(parseArgs(['claude', '--provider'])).toMatchObject({
      error: 'Missing value for --provider',
    });
  });

  it('parses server options', () => {
    expect(parseArgs(['server', '--quick'])).toMatchObject({ command: 'server', serverQuick: true });
    expect(parseArgs(['server', '--listen', 'network'])).toMatchObject({ serverListenMode: 'network' });
    expect(parseArgs(['server', '--listen=bogus'])).toMatchObject({ error: '--listen must be "local" or "network"' });
    expect(parseArgs(['server', '--providers', 'favorites'])).toMatchObject({ serverProvidersMode: 'favorites' });
    expect(parseArgs(['server', '--providers=openai,openai-oauth'])).toMatchObject({
      serverProvidersMode: 'specific',
      serverProviderIds: ['openai', 'openai-oauth'],
    });
    expect(parseArgs(['server', '--password', 'pw'])).toMatchObject({ serverPassword: 'pw' });
    expect(parseArgs(['server', '--port', '8080'])).toMatchObject({ serverPort: 8080 });
    expect(parseArgs(['server', '--port', '99999'])).toMatchObject({ error: '--port must be an integer between 1 and 65535' });
    expect(parseArgs(['server', '--no-discovery'])).toMatchObject({ command: 'server', serverNoDiscovery: true });
    const proxyNoDiscovery = parseArgs(['server', '--proxy', '--no-discovery']);
    expect(proxyNoDiscovery).toMatchObject({ bridgeMode: 'proxy', serverNoDiscovery: true });
    expect(proxyNoDiscovery.error).toBeUndefined();
    expect(parseArgs(['server', '--bogus'])).toMatchObject({ error: 'Unknown server option: --bogus' });
  });

  it('parses models/favorites options', () => {
    expect(parseArgs(['models'])).toMatchObject({ command: 'models' });
    expect(parseArgs(['favorites'])).toMatchObject({ command: 'models' });
    expect(parseArgs(['models', '--list'])).toMatchObject({ favoritesList: true });
    expect(parseArgs(['models', '--alias', 'sol=clodex:openai-oauth:gpt-5.6-sol'])).toMatchObject({
      favoritesAlias: 'sol=clodex:openai-oauth:gpt-5.6-sol',
    });
    expect(parseArgs(['models', '--unalias', 'sol'])).toMatchObject({ favoritesUnalias: 'sol' });
    expect(parseArgs(['models', '--effort-policy', 'up'])).toMatchObject({ effortPolicy: 'up' });
    expect(parseArgs(['models', '--effort-policy=exact'])).toMatchObject({ effortPolicy: 'exact' });
    expect(parseArgs(['models', '--effort-policy', 'nearest']).error)
      .toBe('--effort-policy must be one of: provider-default, up, down, exact');
    // Saving a policy is not a favorites edit, and combining the two would make
    // the success message describe only one of them.
    expect(parseArgs(['models', '--effort-policy', 'up', '--list']).error)
      .toBe('--effort-policy cannot be combined with --list, --alias, or --unalias');
    expect(parseArgs(['models', '--agy'])).toMatchObject({ error: 'Unknown models option: --agy' });
  });

  it('parses the patch command', () => {
    expect(parseArgs(['patch'])).toMatchObject({ command: 'patch', showHelp: false });
    expect(parseArgs(['patch', '--restore'])).toMatchObject({ command: 'patch', patchRestore: true });
    expect(parseArgs(['patch', '--enable-local-patches'])).toMatchObject({
      command: 'patch',
      patchLocalPatches: true,
    });
    expect(parseArgs(['patch', '--disable-local-patches'])).toMatchObject({
      command: 'patch',
      patchLocalPatches: false,
    });
    expect(parseArgs([
      'patch',
      '--enable-local-patches',
      '--disable-local-patches',
    ])).toMatchObject({
      error: '--enable-local-patches and --disable-local-patches cannot be combined',
    });
    expect(parseArgs(['patch', '--restore', '--enable-local-patches'])).toMatchObject({
      error: '--restore cannot be combined with local-patch settings',
    });
    expect(parseArgs(['patch', '--help'])).toMatchObject({ command: 'patch', showHelp: true });
    expect(parseArgs(['patch', '--bogus'])).toMatchObject({ error: 'Unknown patch option: --bogus' });
  });

  it('rejects stripped commands', () => {
    for (const cmd of ['ui', 'gemini', 'codex', 'codex-app', 'chatgpt', 'agy', 'antigravity', 'antigravity-ide', 'claude-app']) {
      expect(parseArgs([cmd]).error, cmd).toBe(`Unknown command: ${cmd}`);
    }
  });

  it('rejects unknown root options', () => {
    expect(parseArgs(['--ai']).error).toBe('Unknown root option: --ai');
  });
});

describe('runClaudeCommand', () => {
  it('composes --fast before the dry-run preview and overrides the ambient tier', async () => {
    const previousClaudePath = process.env.CLODEX_CLAUDE_PATH;
    const previousTier = process.env.CLODEX_SERVICE_TIER;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.env.CLODEX_CLAUDE_PATH = process.execPath;
      process.env.CLODEX_SERVICE_TIER = 'flex';

      const code = await runClaudeCommand(parseArgs(['claude', '--fast', '--dry-run']));

      expect(code).toBe(0);
      expect(process.env.CLODEX_SERVICE_TIER).toBe('fast');
      expect(log.mock.calls.some(call => String(call[0]).includes('DRY RUN'))).toBe(true);
    } finally {
      if (previousClaudePath === undefined) delete process.env.CLODEX_CLAUDE_PATH;
      else process.env.CLODEX_CLAUDE_PATH = previousClaudePath;
      if (previousTier === undefined) delete process.env.CLODEX_SERVICE_TIER;
      else process.env.CLODEX_SERVICE_TIER = previousTier;
    }
  });
});

describe('help text', () => {
  const helps = [rootHelpText(), claudeHelpText(), serverHelpText(), modelsHelpText(), patchHelpText()];

  it('brands every help screen as clodex', () => {
    for (const help of helps) {
      expect(help).toContain('clodex');
      expect(help).not.toContain('relay-ai');
      expect(help).not.toContain('relay:');
      expect(help).not.toContain('Relay AI');
    }
    expect(rootHelpText()).toContain(`v${VERSION}`);
  });

  it('mentions no stripped features anywhere in help', () => {
    for (const help of helps) {
      expect(help).not.toContain('antigravity');
      expect(help).not.toContain('Gemini');
      expect(help).not.toContain('Zen');
      expect(help).not.toContain('--vertex');
      expect(help).not.toContain('subscription tier');
    }
  });

  it('documents the kept commands and bridge modes', () => {
    const root = rootHelpText();
    expect(root).toContain('clodex claude');
    expect(root).toContain('clodex server');
    expect(root).toContain('clodex patch');
    expect(root).toContain('clodex models');
    expect(root).toContain('clodex providers');
    expect(root).toContain('OpenCode Go');
    expect(root).toContain('--endpoint');
    expect(root).toContain('--proxy');
    expect(root).toContain('--save-mode');
    expect(claudeHelpText()).toContain('--save-mode');
    expect(claudeHelpText()).toContain('--fast');
    expect(claudeHelpText()).toContain('warns if the SDK omits it');
    expect(serverHelpText()).toContain('--save-mode');
    expect(claudeHelpText()).toContain('clodex:<provider-id>:<model-id>');
    expect(serverHelpText()).toContain('--no-discovery');
    expect(patchHelpText()).toContain('--restore');
    expect(patchHelpText()).toContain('--enable-local-patches');
    expect(patchHelpText()).toContain('--disable-local-patches');
    expect(patchHelpText()).toContain('local-patches.mjs');
    expect(patchHelpText()).toContain('executes trusted JavaScript');
  });

  it('no longer mentions the removed --http-proxy alias', () => {
    for (const help of helps) {
      expect(help).not.toContain('--http-proxy');
    }
  });
});

describe('main dispatch', () => {
  it('prints version for --version', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['--version']);
    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(VERSION);
  });

  it('prints root help for unknown commands and returns 1', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['gemini']);
    expect(code).toBe(1);
    expect(error.mock.calls.some(call => String(call[0]).includes('Unknown command: gemini'))).toBe(true);
    expect(log.mock.calls.some(call => String(call[0]).includes('clodex'))).toBe(true);
  });

  it('keeps an unrelated provider launchable while preserving a blocked provider diagnostic', async () => {
    const blockedReason = 'CLODEX_KEY_OPENAI_OAUTH is a process-scoped credential with no isolated model catalog for provider "openai-oauth".';
    const catalog = Object.assign([
      {
        id: 'groq',
        name: 'Groq',
        apiKey: 'stored-groq-key',
        authType: 'api' as const,
        models: [{
          id: 'llama-test',
          name: 'Llama Test',
          family: 'llama',
          brand: 'Meta',
          modelFormat: 'openai' as const,
          upstreamModelId: 'llama-test',
          npm: '@ai-sdk/openai-compatible',
        }],
      },
    ], { blockedProviders: new Map([['openai-oauth', blockedReason]]) });
    vi.mocked(fetchProviderCatalog).mockResolvedValue(catalog);
    const error = vi.spyOn(p.log, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(main([
      'claude',
      '--endpoint',
      '--dry-run',
      '--provider', 'openai-oauth',
      '--model', 'gpt-test',
    ])).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(blockedReason);
    expect(error.mock.calls.flat().join('\n')).not.toContain('Provider/model not found');

    await expect(main([
      'claude',
      '--endpoint',
      '--dry-run',
      '--provider', 'groq',
      '--model', 'llama-test',
    ])).resolves.toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('DRY RUN — would execute');
  });

  it('routes API-key Anthropic models without count_tokens support through the local estimator proxy', async () => {
    vi.clearAllMocks();
    const compatibility = { supportsCountTokens: false };
    const model = {
      id: 'opencode-go/qwen3.8-max',
      name: 'Qwen 3.8 Max',
      family: 'qwen',
      brand: 'Qwen',
      modelFormat: 'anthropic' as const,
      upstreamModelId: 'qwen3.8-max',
      baseUrl: 'https://api.opencode.ai',
      compatibility,
    };
    const provider = {
      id: 'opencode-go',
      name: 'OpenCode Go',
      apiKey: 'catalog-api-key',
      authType: 'api' as const,
      models: [model],
    };
    const catalog = Object.assign([provider], { blockedProviders: new Map() });
    const close = vi.fn();
    vi.mocked(fetchProviderCatalog).mockResolvedValue(catalog);
    vi.mocked(resolveLocalProviderApiKey).mockResolvedValue('opencode-api-key');
    vi.mocked(startProxy).mockResolvedValue({ port: 43123, token: 'proxy-token', close });
    vi.mocked(launchClaude).mockResolvedValue(0);

    const code = await runClaudeCommand(parseArgs([
      'claude',
      '--endpoint',
      '--provider', 'opencode-go',
      '--model', 'opencode-go/qwen3.8-max',
    ]));

    expect(code).toBe(0);
    expect(startProxy).toHaveBeenCalledWith(
      'https://api.opencode.ai',
      'opencode-go/qwen3.8-max',
      false,
      undefined,
      expect.objectContaining({
        authType: 'api',
        modelFormat: 'anthropic',
        compatibility,
      }),
      'opencode-api-key',
      // Every routed launch carries the startup effort-policy snapshot.
      'provider-default',
    );
    expect(launchClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:43123',
        ANTHROPIC_API_KEY: 'proxy-token',
      }),
      'opencode-go/qwen3.8-max',
      [],
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps API-key Anthropic models with unset count_tokens capability direct and beta-gated', async () => {
    vi.clearAllMocks();
    const model = {
      id: 'anthropic-direct-model',
      name: 'Anthropic Direct Model',
      family: 'claude',
      brand: 'Anthropic',
      modelFormat: 'anthropic' as const,
      upstreamModelId: 'anthropic-direct-model',
      baseUrl: 'https://api.anthropic.com',
    };
    const provider = {
      id: 'anthropic-api',
      name: 'Anthropic API',
      apiKey: 'anthropic-api-key',
      authType: 'api' as const,
      models: [model],
    };
    const catalog = Object.assign([provider], { blockedProviders: new Map() });
    vi.mocked(fetchProviderCatalog).mockResolvedValue(catalog);
    vi.mocked(resolveLocalProviderApiKey).mockResolvedValue('anthropic-api-key');
    vi.mocked(launchClaude).mockResolvedValue(0);

    const code = await runClaudeCommand(parseArgs([
      'claude',
      '--endpoint',
      '--provider', 'anthropic-api',
      '--model', 'anthropic-direct-model',
    ]));

    expect(code).toBe(0);
    expect(startProxy).not.toHaveBeenCalled();
    expect(launchClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_API_KEY: 'anthropic-api-key',
        CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      }),
      'anthropic-direct-model',
      [],
    );
  });

  it('routes an Anthropic provider with configured headers through the local proxy', async () => {
    vi.clearAllMocks();
    // A configured Anthropic-Beta is only emitted at clodex's own routed
    // boundary. Launching direct would point the child at the provider base URL
    // clodex never sees, so the configured contract would never be applied.
    const model = {
      id: 'anthropic-configured',
      name: 'Anthropic Configured',
      family: 'claude',
      brand: 'Anthropic',
      modelFormat: 'anthropic' as const,
      upstreamModelId: 'anthropic-configured',
      baseUrl: 'https://api.anthropic.com',
    };
    const provider = {
      id: 'anthropic-api',
      name: 'Anthropic API',
      apiKey: 'anthropic-api-key',
      authType: 'api' as const,
      headers: { 'Anthropic-Beta': 'cfg-a', 'X-Plan': 'coding' },
      models: [model],
    };
    const catalog = Object.assign([provider], { blockedProviders: new Map() });
    const close = vi.fn();
    vi.mocked(fetchProviderCatalog).mockResolvedValue(catalog);
    vi.mocked(resolveLocalProviderApiKey).mockResolvedValue('anthropic-api-key');
    vi.mocked(startProxy).mockResolvedValue({ port: 43123, token: 'proxy-token', close });
    vi.mocked(launchClaude).mockResolvedValue(0);

    const code = await runClaudeCommand(parseArgs([
      'claude',
      '--endpoint',
      '--provider', 'anthropic-api',
      '--model', 'anthropic-configured',
    ]));

    expect(code).toBe(0);
    expect(startProxy).toHaveBeenCalledWith(
      'https://api.anthropic.com',
      'anthropic-configured',
      false,
      undefined,
      expect.objectContaining({
        authType: 'api',
        modelFormat: 'anthropic',
        // Configured headers reach the routed boundary intact.
        headers: { 'Anthropic-Beta': 'cfg-a', 'X-Plan': 'coding' },
      }),
      'anthropic-api-key',
      'provider-default',
    );
    const [childEnv] = vi.mocked(launchClaude).mock.calls[0]!;
    expect(childEnv).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:43123',
      ANTHROPIC_API_KEY: 'proxy-token',
    });
    // Child suppression belongs to the DIRECT path only: on the proxy path it
    // would disable the tool-search betas the local route depends on.
    expect(childEnv).not.toHaveProperty('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS');
  });

  it.each(['oauth', 'none'] as const)(
    'keeps %s Anthropic providers on the proxy path without child suppression',
    async authType => {
      vi.clearAllMocks();
      const provider = {
        id: `anthropic-${authType}`,
        name: `Anthropic ${authType}`,
        apiKey: authType === 'none' ? '' : 'provider-token',
        authType,
        models: [{
          id: `anthropic-${authType}-model`,
          name: 'Anthropic Model',
          family: 'claude',
          brand: 'Anthropic',
          modelFormat: 'anthropic' as const,
          upstreamModelId: `anthropic-${authType}-model`,
          baseUrl: 'https://api.anthropic.com',
        }],
      };
      const catalog = Object.assign([provider], { blockedProviders: new Map() });
      const close = vi.fn();
      vi.mocked(fetchProviderCatalog).mockResolvedValue(catalog);
      vi.mocked(resolveLocalProviderApiKey).mockResolvedValue(
        authType === 'none' ? '' : 'provider-token',
      );
      vi.mocked(startProxy).mockResolvedValue({ port: 43123, token: 'proxy-token', close });
      vi.mocked(launchClaude).mockResolvedValue(0);

      const code = await runClaudeCommand(parseArgs([
        'claude',
        '--endpoint',
        '--provider', provider.id,
        '--model', provider.models[0]!.id,
      ]));

      expect(code).toBe(0);
      expect(startProxy).toHaveBeenCalledOnce();
      const [childEnv] = vi.mocked(launchClaude).mock.calls[0]!;
      expect(childEnv).not.toHaveProperty('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS');
    },
  );

  it('prints patch help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['patch', '--help']);
    expect(code).toBe(0);
    expect(log.mock.calls.some(call => String(call[0]).includes('clodex patch'))).toBe(true);
  });
});
