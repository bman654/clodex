import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProvidersAdd, runProvidersCommand } from '../src/providers-command.js';
import { loadRegistry } from '../src/registry/io.js';
import {
  loadPendingCredentialDeletes,
  queueCredentialDelete,
} from '../src/registry/credential-cleanup-journal.js';
import * as env from '../src/env.js';
import type { RegistryProvider } from '../src/registry/types.js';

const selectMock = vi.hoisted(() => vi.fn());
const textMock = vi.hoisted(() => vi.fn());
const passwordMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());
const spinnerStartMock = vi.hoisted(() => vi.fn());
const spinnerStopMock = vi.hoisted(() => vi.fn());
const cancelMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());
const logInfoMock = vi.hoisted(() => vi.fn());
const logSuccessMock = vi.hoisted(() => vi.fn());
const warnMock = vi.hoisted(() => vi.fn());
const addCustomMock = vi.hoisted(() => vi.fn());
// clack's own cancel symbol is private to @clack/core, so the mock defines its own.
const CANCEL = vi.hoisted(() => Symbol('cancel'));

vi.mock('@clack/prompts', async importOriginal => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return {
    ...actual,
    isCancel: (value: unknown) => value === CANCEL,
    select: selectMock,
    text: textMock,
    password: passwordMock,
    confirm: confirmMock,
    cancel: cancelMock,
    spinner: () => ({ start: spinnerStartMock, stop: spinnerStopMock }),
    log: {
      ...actual.log,
      error: logErrorMock,
      info: logInfoMock,
      success: logSuccessMock,
      warn: warnMock,
    },
  };
});

// Wraps the real registry function so most tests run it for real; a test that
// only cares what the prompts hand it replaces the result with mockResolvedValueOnce.
vi.mock('../src/registry/custom-endpoint.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/registry/custom-endpoint.js')>(),
  addCustomEndpointProvider: addCustomMock,
}));

const CLEANUP_PENDING =
  'Credential cleanup is pending and will be retried by the next provider command.';

function fakeProvider(partial: Partial<RegistryProvider> = {}): RegistryProvider {
  return {
    id: 'custom-openrouter',
    templateId: 'custom-openai',
    name: 'OpenRouter',
    enabled: true,
    authRef: 'keyring:provider:custom-openrouter',
    authType: 'api',
    api: { npm: '@ai-sdk/openai-compatible', url: 'https://openrouter.ai/api/v1' },
    addedAt: '2026-09-18T00:00:00.000Z',
    ...partial,
  };
}

/** Prompt answers for one pass through the custom flow. */
function answerCustomFlow(name: string, url: string, key: string): void {
  selectMock.mockResolvedValue('custom');
  textMock.mockResolvedValueOnce(name).mockResolvedValueOnce(url);
  passwordMock.mockResolvedValue(key);
}

describe('providers add: custom OpenAI-compatible server', () => {
  let home: string;
  const prevHome = process.env.CLODEX_HOME;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'clodex-providers-custom-'));
    process.env.CLODEX_HOME = home;
    for (const mock of [
      selectMock, textMock, passwordMock, confirmMock, spinnerStartMock, spinnerStopMock,
      cancelMock, logErrorMock, logInfoMock, logSuccessMock, warnMock, addCustomMock,
    ]) mock.mockReset();
    const actual = await vi.importActual<typeof import('../src/registry/custom-endpoint.js')>(
      '../src/registry/custom-endpoint.js',
    );
    addCustomMock.mockImplementation(actual.addCustomEndpointProvider);
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CLODEX_HOME;
    else process.env.CLODEX_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('is the last entry of the add menu and is offered even when every built-in is configured', async () => {
    selectMock.mockResolvedValue('noop');

    await runProvidersAdd();

    const options = selectMock.mock.calls[0]?.[0].options as Array<{ value: string; label: string; hint: string }>;
    expect(options.at(-1)).toMatchObject({
      value: 'custom',
      label: 'Custom OpenAI-compatible server',
      hint: 'OpenRouter, Together, LM Studio, vLLM — any base URL',
    });
  });

  it('hands the trimmed answers to the registry as an OpenAI-kind endpoint', async () => {
    answerCustomFlow('  OpenRouter  ', '  https://openrouter.ai/api/v1  ', '  sk-or-test  ');
    addCustomMock.mockResolvedValueOnce({ added: true, provider: fakeProvider(), modelCount: 3 });

    await expect(runProvidersAdd()).resolves.toBe(0);

    expect(addCustomMock).toHaveBeenCalledTimes(1);
    expect(addCustomMock).toHaveBeenCalledWith({
      displayName: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test',
      kind: 'openai',
      allowInsecureLocal: false,
    });
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('reports the provider name and how many models were found', async () => {
    answerCustomFlow('OpenRouter', 'https://openrouter.ai/api/v1', 'sk-or-test');
    addCustomMock.mockResolvedValueOnce({
      added: true,
      provider: fakeProvider({ name: 'Router X' }),
      modelCount: 3,
    });

    await runProvidersAdd();

    // A spinner left running owns the line the success message prints on.
    expect(spinnerStartMock).toHaveBeenCalledTimes(1);
    expect(spinnerStopMock).toHaveBeenCalledTimes(1);
    expect(logSuccessMock).toHaveBeenCalledTimes(1);
    const line = String(logSuccessMock.mock.calls[0]?.[0]).replace(/\x1b\[[0-9;]*m/g, '');
    expect(line).toContain('Router X');
    expect(line).toContain('3 models');
  });

  it('refuses an empty name and an empty URL in the prompts', async () => {
    answerCustomFlow('OpenRouter', 'https://openrouter.ai/api/v1', '');
    addCustomMock.mockResolvedValueOnce({ added: true, provider: fakeProvider(), modelCount: 1 });

    await runProvidersAdd();

    const nameOptions = textMock.mock.calls[0]?.[0];
    const urlOptions = textMock.mock.calls[1]?.[0];
    expect(nameOptions.validate('   ')).toBe('Name is required');
    expect(nameOptions.validate('OpenRouter')).toBeUndefined();
    expect(urlOptions.validate('')).toBe('URL is required');
    expect(urlOptions.validate('https://openrouter.ai/api/v1')).toBeUndefined();
  });

  it('tells the user the provider id and how its models are named', async () => {
    answerCustomFlow('OpenRouter', 'https://openrouter.ai/api/v1', 'sk-or-test');
    addCustomMock.mockResolvedValueOnce({ added: true, provider: fakeProvider(), modelCount: 3 });

    await runProvidersAdd();

    expect(logInfoMock).toHaveBeenCalledWith(
      'Provider id: custom-openrouter. Its models are named clodex:custom-openrouter:<model>.',
    );
  });

  it('asks before allowing plain http and forwards the answer', async () => {
    answerCustomFlow('LM Studio', 'http://192.168.1.20:1234/v1', '');
    confirmMock.mockResolvedValue(true);
    addCustomMock.mockResolvedValueOnce({
      added: true,
      provider: fakeProvider({ id: 'custom-lm-studio', name: 'LM Studio' }),
      modelCount: 1,
    });

    await runProvidersAdd();

    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('HTTP is not encrypted'));
    expect(confirmMock.mock.calls[0]?.[0]).toMatchObject({ initialValue: true });
    expect(addCustomMock).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'http://192.168.1.20:1234/v1',
      apiKey: '',
      allowInsecureLocal: true,
    }));
  });

  it('treats an upper-case HTTP:// scheme as plain http too', async () => {
    answerCustomFlow('LM Studio', 'HTTP://192.168.1.20:1234/v1', '');
    confirmMock.mockResolvedValue(true);
    addCustomMock.mockResolvedValueOnce({ added: true, provider: fakeProvider(), modelCount: 1 });

    await runProvidersAdd();

    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it('does not allow plain http when the user declines', async () => {
    answerCustomFlow('LM Studio', 'http://192.168.1.20:1234/v1', '');
    confirmMock.mockResolvedValue(false);
    addCustomMock.mockResolvedValueOnce({
      added: false,
      error: 'Plain HTTP endpoints are blocked.',
      hint: 'Use https.',
    });

    await expect(runProvidersAdd()).resolves.toBe(1);

    expect(addCustomMock).toHaveBeenCalledWith(expect.objectContaining({ allowInsecureLocal: false }));
  });

  it('returns 1 and shows the error and hint when the registry refuses', async () => {
    answerCustomFlow('OpenRouter', 'https://openrouter.ai/api/v1', 'bad-key');
    addCustomMock.mockResolvedValueOnce({
      added: false,
      error: 'API key was rejected.',
      hint: 'Check the key.',
    });

    await expect(runProvidersAdd()).resolves.toBe(1);

    expect(logErrorMock).toHaveBeenCalledWith('API key was rejected.');
    expect(logInfoMock).toHaveBeenCalledWith('Check the key.');
    expect(logSuccessMock).not.toHaveBeenCalled();
  });

  it('prints no control character from a server-supplied error or hint', async () => {
    const ESC = String.fromCharCode(0x1b);
    const BEL = String.fromCharCode(0x07);
    const CSI = String.fromCharCode(0x9b);
    answerCustomFlow('Odd Server', 'https://odd.example/v1', 'k');
    addCustomMock.mockResolvedValueOnce({
      added: false,
      error: `Provider returned HTTP 500.${ESC}[2J`,
      hint: `${ESC}[2J${ESC}]0;PWNED${BEL}ERROR: session expired${CSI}31m`,
    });

    await expect(runProvidersAdd()).resolves.toBe(1);

    const printed = [...logErrorMock.mock.calls, ...logInfoMock.mock.calls].map(call => String(call[0]));
    expect(printed).toEqual([
      'Provider returned HTTP 500. [2J',
      '[2J ]0;PWNED ERROR: session expired 31m',
    ]);
    for (const line of printed) {
      for (const ch of line) {
        const code = ch.charCodeAt(0);
        expect(code < 0x20 || (code >= 0x7f && code <= 0x9f)).toBe(false);
      }
    }
  });

  it.each([
    { at: 'the name', answer: () => textMock.mockResolvedValueOnce(CANCEL) },
    {
      at: 'the URL',
      answer: () => textMock.mockResolvedValueOnce('OpenRouter').mockResolvedValueOnce(CANCEL),
    },
    {
      at: 'the API key',
      answer: () => {
        textMock.mockResolvedValueOnce('OpenRouter').mockResolvedValueOnce('https://openrouter.ai/api/v1');
        passwordMock.mockResolvedValue(CANCEL);
      },
    },
    {
      at: 'the plain-http confirmation',
      answer: () => {
        textMock.mockResolvedValueOnce('LM Studio').mockResolvedValueOnce('http://localhost:1234/v1');
        confirmMock.mockResolvedValue(CANCEL);
      },
    },
  ])('cancelling at $at adds nothing and exits 0', async ({ answer }) => {
    selectMock.mockResolvedValue('custom');
    answer();

    await expect(runProvidersAdd()).resolves.toBe(0);

    expect(cancelMock).toHaveBeenCalledWith('Cancelled.');
    expect(addCustomMock).not.toHaveBeenCalled();
    expect(loadRegistry().providers).toEqual([]);
  });

  it('reports pending credential cleanup through `clodex providers add`', async () => {
    answerCustomFlow('OpenRouter', 'https://openrouter.ai/api/v1', 'sk-or-test');
    addCustomMock.mockResolvedValueOnce({
      added: true,
      provider: fakeProvider(),
      modelCount: 3,
      credentialCleanupPending: true,
      credentialCleanupReconciled: true,
    });

    await expect(runProvidersCommand(['add'])).resolves.toBe(0);

    expect(warnMock).toHaveBeenCalledWith(CLEANUP_PENDING);
  });

  it('reports pending credential cleanup even when the custom add is refused', async () => {
    answerCustomFlow('OpenRouter', 'https://openrouter.ai/api/v1', 'sk-or-test');
    addCustomMock.mockResolvedValueOnce({
      added: false,
      error: 'Could not save API key to the credential store.',
      credentialCleanupPending: true,
      credentialCleanupReconciled: true,
    });

    await expect(runProvidersCommand(['add'])).resolves.toBe(1);

    expect(warnMock).toHaveBeenCalledWith(CLEANUP_PENDING);
  });

  it('prints no hint line when the hint is only control characters', async () => {
    answerCustomFlow('Odd Server', 'https://odd.example/v1', 'k');
    addCustomMock.mockResolvedValueOnce({
      added: false,
      error: 'Provider returned HTTP 500.',
      hint: `${String.fromCharCode(0x1b)}${String.fromCharCode(0x9b)}${String.fromCharCode(0x7f)}`,
    });

    await expect(runProvidersAdd()).resolves.toBe(1);

    expect(logErrorMock).toHaveBeenCalledWith('Provider returned HTTP 500.');
    expect(logInfoMock).not.toHaveBeenCalled();
  });

  it('retries queued cleanup when the custom add is refused before it mutates anything', async () => {
    const authRef = `helper:v1:${'a'.repeat(64)}:provider:retired`;
    await queueCredentialDelete(authRef);
    const deleteSpy = vi.spyOn(env, 'deleteProviderCredential').mockResolvedValue(true);
    answerCustomFlow('OpenRouter', 'https://openrouter.ai/api/v1', 'sk-or-test');
    addCustomMock.mockResolvedValueOnce({ added: false, error: 'No models returned.' });

    await expect(runProvidersCommand(['add'])).resolves.toBe(1);

    expect(deleteSpy).toHaveBeenCalledWith(authRef);
    await expect(loadPendingCredentialDeletes()).resolves.toEqual([]);
    expect(warnMock).not.toHaveBeenCalled();
  });

  describe('against a real registry and a local OpenAI-compatible server', () => {
    let server: Server;
    let baseUrl: string;
    let requests: Array<{ url?: string; headers: IncomingHttpHeaders }>;
    let listedModels: Array<{ id: string; name?: string }>;
    let failureBody: string | undefined;

    beforeEach(async () => {
      requests = [];
      listedModels = [{ id: 'moonshotai/kimi-k3' }, { id: 'deepseek/deepseek-v4.1-flash' }];
      failureBody = undefined;
      server = createServer((req, res) => {
        requests.push({ url: req.url, headers: req.headers });
        if (failureBody !== undefined) {
          res.statusCode = 500;
          res.end(failureBody);
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: listedModels }));
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    });

    afterEach(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
    });

    it('saves a keyless server as a custom-openai provider with its model list', async () => {
      answerCustomFlow('Local Server', baseUrl, '');
      confirmMock.mockResolvedValue(true);

      await expect(runProvidersAdd()).resolves.toBe(0);

      const [provider] = loadRegistry().providers;
      expect(provider).toMatchObject({
        id: 'custom-local-server',
        templateId: 'custom-openai',
        name: 'Local Server',
        enabled: true,
        authRef: 'none:anonymous',
        authType: 'none',
        api: { npm: '@ai-sdk/openai-compatible', url: baseUrl },
      });
      expect(provider?.modelsCache?.models.map(model => model.id))
        .toEqual(['moonshotai/kimi-k3', 'deepseek/deepseek-v4.1-flash']);
      expect(requests.map(request => request.url)).toEqual(['/v1/models']);
      await expect(addCustomMock.mock.results[0]?.value).resolves.toMatchObject({
        added: true,
        credentialCleanupReconciled: true,
      });
    });

    it('stores a key through the credential store and sends it to the server', async () => {
      const provision = vi.spyOn(env, 'provisionProviderCredential').mockResolvedValue(true);
      answerCustomFlow('Local Server', baseUrl, 'sk-local-test');
      confirmMock.mockResolvedValue(true);

      await expect(runProvidersAdd()).resolves.toBe(0);

      const [provider] = loadRegistry().providers;
      expect(provider?.authType).toBe('api');
      expect(provider?.authRef).not.toBe('none:anonymous');
      expect(provision).toHaveBeenCalledTimes(1);
      expect(provision).toHaveBeenCalledWith(provider?.authRef, 'sk-local-test');
      expect(requests[0]?.headers.authorization).toBe('Bearer sk-local-test');
    });

    it('adds nothing when http is not allowed, so a mistyped URL cannot reach a private address', async () => {
      answerCustomFlow('Local Server', baseUrl, '');
      confirmMock.mockResolvedValue(false);

      await expect(runProvidersAdd()).resolves.toBe(1);

      expect(loadRegistry().providers).toEqual([]);
      expect(requests).toEqual([]);
    });

    it('does not store a model whose id or name carries a control character', async () => {
      const ESC = String.fromCharCode(0x1b);
      listedModels = [
        { id: `gpt-5${ESC}[2J${ESC}[H-free` },
        { id: 'plain-name', name: `Nice${ESC}]0;PWNED` },
        { id: `clean-name${ESC}[H`, name: 'A clean display name' },
        { id: 'moonshotai/kimi-k3' },
      ];
      answerCustomFlow('Local Server', baseUrl, '');
      confirmMock.mockResolvedValue(true);

      await expect(runProvidersAdd()).resolves.toBe(0);

      const [provider] = loadRegistry().providers;
      expect(provider?.modelsCache?.models.map(model => model.id)).toEqual(['moonshotai/kimi-k3']);
      await expect(addCustomMock.mock.results[0]?.value).resolves.toMatchObject({ modelCount: 1 });
    });

    it('adds nothing when every listed model carries a control character', async () => {
      listedModels = [{ id: `only${String.fromCharCode(0x1b)}[2J` }];
      answerCustomFlow('Local Server', baseUrl, '');
      confirmMock.mockResolvedValue(true);

      await expect(runProvidersAdd()).resolves.toBe(1);

      expect(loadRegistry().providers).toEqual([]);
      expect(logErrorMock).toHaveBeenCalledWith('Connected but no models were returned.');
    });

    it('shows a hostile error body from the server as plain text', async () => {
      const ESC = String.fromCharCode(0x1b);
      const BEL = String.fromCharCode(0x07);
      failureBody = `${ESC}[2J${ESC}[H${ESC}]0;PWNED${BEL}ERROR: your session expired`;
      answerCustomFlow('Local Server', baseUrl, '');
      confirmMock.mockResolvedValue(true);

      await expect(runProvidersAdd()).resolves.toBe(1);

      expect(loadRegistry().providers).toEqual([]);
      expect(logErrorMock).toHaveBeenCalledWith('Provider returned HTTP 500.');
      expect(logInfoMock).toHaveBeenCalledWith('[2J [H ]0;PWNED ERROR: your session expired');
    });
  });
});
