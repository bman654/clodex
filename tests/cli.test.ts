// tests/cli.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseArgs, rootHelpText, claudeHelpText, serverHelpText, modelsHelpText, patchHelpText, main } from '../src/cli.js';
import { VERSION } from '../src/constants.js';

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
    expect(parseArgs(['models', '--agy'])).toMatchObject({ error: 'Unknown models option: --agy' });
  });

  it('parses the patch command', () => {
    expect(parseArgs(['patch'])).toMatchObject({ command: 'patch', showHelp: false });
    expect(parseArgs(['patch', '--restore'])).toMatchObject({ command: 'patch', patchRestore: true });
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
      expect(help).not.toContain('OpenCode');
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
    expect(root).toContain('--endpoint');
    expect(root).toContain('--proxy');
    expect(root).toContain('--save-mode');
    expect(claudeHelpText()).toContain('--save-mode');
    expect(serverHelpText()).toContain('--save-mode');
    expect(claudeHelpText()).toContain('clodex:<provider-id>:<model-id>');
    expect(serverHelpText()).toContain('--no-discovery');
    expect(patchHelpText()).toContain('--restore');
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

  it('prints patch help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['patch', '--help']);
    expect(code).toBe(0);
    expect(log.mock.calls.some(call => String(call[0]).includes('clodex patch'))).toBe(true);
  });
});
