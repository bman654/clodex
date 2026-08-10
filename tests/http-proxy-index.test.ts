import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as p from '@clack/prompts';
import {
  buildConfiguredHttpProxyOptions,
  formatHttpProxyEnvironmentLines,
  formatHttpProxyModelLines,
  loadHttpProxyRoutes,
  reportSkippedHttpProxyFavorites,
  runHttpProxyServerCommand,
  type LoadedHttpProxyRoutes,
} from '../src/http-proxy/index.js';
import type { ProxyRoute } from '../src/proxy.js';
import { getInferenceRequestLogPath } from '../src/trace-log.js';

describe('HTTP proxy startup model list', () => {
  it('prints the available context beside the full model name', () => {
    const route: ProxyRoute = {
      aliasId: 'clodex:openai-oauth:gpt-5.6-sol',
      realModelId: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol (OpenAI (ChatGPT))',
      upstreamUrl: '',
      apiKey: 'oauth-token',
      modelFormat: 'openai',
      contextWindow: 272_000,
    };
    const lines = formatHttpProxyModelLines([route], [{
      name: 'sol',
      routeId: route.aliasId,
      displayName: route.displayName,
    }]);

    expect(lines[0]).toContain('GPT-5.6 Sol (OpenAI (ChatGPT)) (272K context)');
    expect(lines[1]).toContain('GPT-5.6 Sol (OpenAI (ChatGPT)) (272K context)');
  });

  it('records the standalone proxy server start and clean shutdown lifecycle', async () => {
    const home = mkdtempSync(join(tmpdir(), 'clodex-proxy-lifecycle-'));
    const previousHome = process.env['CLODEX_HOME'];
    process.env['CLODEX_HOME'] = home;
    const logPath = getInferenceRequestLogPath();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    let shutdownRequested = false;
    const result = runHttpProxyServerCommand(false, false, 0, true);

    try {
      await vi.waitFor(() => {
        expect(consoleLog).toHaveBeenCalledWith(
          expect.stringContaining('clodex proxy-mode server running'),
        );
      });
      shutdownRequested = true;
      process.emit('SIGTERM');
      await expect(result).resolves.toBe(0);

      const entries = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(entries.map(entry => entry.event)).toEqual([
        'proxy_started',
        'proxy_stopping',
        'proxy_stopped',
      ]);
      expect(entries[0]).toMatchObject({
        pid: process.pid,
        parentPid: process.ppid,
        host: '127.0.0.1',
        port: expect.any(Number),
      });
      expect(entries[1]).toMatchObject({
        pid: process.pid,
        parentPid: entries[0].parentPid,
        host: entries[0].host,
        port: entries[0].port,
        reason: 'shutdown signal received',
      });
      expect(entries[2]).toMatchObject({
        pid: process.pid,
        parentPid: entries[0].parentPid,
        host: entries[0].host,
        port: entries[0].port,
      });
    } finally {
      if (!shutdownRequested) process.emit('SIGTERM');
      await result.catch(() => undefined);
      consoleLog.mockRestore();
      if (previousHome === undefined) delete process.env['CLODEX_HOME'];
      else process.env['CLODEX_HOME'] = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
  it('reserves canonical and exact stored names for inactive configured aliases', () => {
    const loaded: LoadedHttpProxyRoutes = {
      routes: [],
      aliases: [],
      unavailable: [],
      unsupported: [],
      unavailableAliases: [
        {
          name: ' Orbit ',
          providerId: 'openai',
          modelId: 'model-a',
        },
        {
          name: 'ORBIT',
          providerId: 'other',
          modelId: 'model-b',
        },
      ],
      favoriteCount: 0,
    };

    const options = buildConfiguredHttpProxyOptions(
      loaded,
      17645,
      false,
      '/tmp/inference.jsonl',
    );

    expect(options).toMatchObject({
      host: '127.0.0.1',
      port: 17645,
      routes: [],
      modelAliases: [],
      inferenceLogPath: '/tmp/inference.jsonl',
      unsupportedEffortPolicy: 'provider-default',
    });
    expect(options.reservedModelIds).toHaveLength(4);
    expect(new Set(options.reservedModelIds)).toEqual(
      new Set([' Orbit ', 'orbit', 'Orbit', 'ORBIT']),
    );
  });

  it('reserves every exact source spelling for an active canonical alias', () => {
    const loaded: LoadedHttpProxyRoutes = {
      routes: [],
      aliases: [{
        name: 'luna',
        routeId: 'clodex:test:model-a',
        displayName: 'Model A',
        sourceNames: ['LuNa', 'LUNA'],
      }],
      unavailable: [],
      unsupported: [],
      unavailableAliases: [],
      favoriteCount: 1,
      effortPolicy: 'down',
    };

    const options = buildConfiguredHttpProxyOptions(
      loaded,
      17645,
      false,
      '/tmp/inference.jsonl',
    );

    expect(new Set(options.reservedModelIds)).toEqual(
      new Set(['luna', 'LuNa', 'LUNA']),
    );
    expect(options.unsupportedEffortPolicy).toBe('down');
  });

  it('preserves every exact source spelling when no favorites remain', async () => {
    const home = mkdtempSync(join(tmpdir(), 'clodex-proxy-no-favorites-'));
    const previousHome = process.env['CLODEX_HOME'];
    process.env['CLODEX_HOME'] = home;
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      favoriteModels: [],
      modelAliases: [
        { name: 'LuNa', providerId: 'one', modelId: 'model-a' },
        { name: 'LUNA', providerId: 'one', modelId: 'model-a' },
      ],
    }));

    try {
      const loaded = await loadHttpProxyRoutes();
      expect(loaded.unavailableAliases).toEqual([
        { name: 'LuNa', providerId: 'one', modelId: 'model-a' },
        { name: 'LUNA', providerId: 'one', modelId: 'model-a' },
      ]);

      const options = buildConfiguredHttpProxyOptions(
        loaded,
        17645,
        false,
        '/tmp/inference.jsonl',
      );
      expect(new Set(options.reservedModelIds)).toEqual(
        new Set(['luna', 'LuNa', 'LUNA']),
      );
    } finally {
      if (previousHome === undefined) delete process.env['CLODEX_HOME'];
      else process.env['CLODEX_HOME'] = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('fails closed when saved aliases are not stored as an array', async () => {
    const home = mkdtempSync(join(tmpdir(), 'clodex-proxy-malformed-aliases-'));
    const previousHome = process.env['CLODEX_HOME'];
    process.env['CLODEX_HOME'] = home;
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      favoriteModels: [{ providerId: 'one', modelId: 'model-a' }],
      modelAliases: { name: 'LuNa', providerId: 'one', modelId: 'model-a' },
    }));

    try {
      await expect(loadHttpProxyRoutes()).rejects.toThrow(
        'Saved model aliases are malformed: "modelAliases" must be an array.',
      );
    } finally {
      if (previousHome === undefined) delete process.env['CLODEX_HOME'];
      else process.env['CLODEX_HOME'] = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('fails closed on malformed alias elements before the zero-favorite shortcut', async () => {
    const home = mkdtempSync(join(tmpdir(), 'clodex-proxy-malformed-alias-element-'));
    const previousHome = process.env['CLODEX_HOME'];
    process.env['CLODEX_HOME'] = home;

    try {
      for (const malformed of [
        null,
        7,
        { name: 7, providerId: 'one', modelId: 'model-a' },
      ]) {
        writeFileSync(join(home, 'config.json'), JSON.stringify({
          favoriteModels: [],
          modelAliases: [
            { name: 'valid', providerId: 'one', modelId: 'model-a' },
            malformed,
          ],
        }));

        await expect(loadHttpProxyRoutes()).rejects.toThrow(
          'Saved model aliases are malformed: "modelAliases[1]" must be an object with a string "name".',
        );
      }
    } finally {
      if (previousHome === undefined) delete process.env['CLODEX_HOME'];
      else process.env['CLODEX_HOME'] = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports each inactive alias with the reason it was rejected', () => {
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    const loaded: LoadedHttpProxyRoutes = {
      routes: [],
      aliases: [],
      unavailable: [],
      unsupported: [],
      unavailableAliases: [
        { name: 'default', providerId: 'openai', modelId: 'model-a' },
        { name: 'Orbit', providerId: 'openai', modelId: 'model-a' },
        { name: 'ORBIT', providerId: 'other', modelId: 'model-b' },
        { name: 'bad:name', providerId: 'openai', modelId: 'model-a' },
        { name: 'missing', providerId: 'openai', modelId: 'missing-model' },
      ],
      favoriteCount: 1,
    };

    try {
      reportSkippedHttpProxyFavorites(loaded);
      expect(warn).toHaveBeenCalledWith(
        '5 model aliases skipped. Saved entries were preserved.\n'
        + '  "default" — reserved client name\n'
        + '  "Orbit" — conflicting targets\n'
        + '  "ORBIT" — conflicting targets\n'
        + '  "bad:name" — invalid name\n'
        + '  "missing" — target unavailable',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('prints proxy env values with the merged non-Anthropic bypass list', () => {
    const lines = formatHttpProxyEnvironmentLines({
      port: 17645,
      caCertPath: '/tmp/clodex-ca.pem',
    }, {
      NO_PROXY: 'localhost,api.anthropic.com',
      no_proxy: 'corp.internal,*',
    });

    expect(lines).toEqual([
      '  HTTPS_PROXY=http://127.0.0.1:17645',
      '  HTTP_PROXY=http://127.0.0.1:17645',
      '  NODE_EXTRA_CA_CERTS=/tmp/clodex-ca.pem',
      '  NO_PROXY=localhost,corp.internal',
      '  no_proxy=localhost,corp.internal',
    ]);

    expect(formatHttpProxyEnvironmentLines({
      port: 17645,
      caCertPath: '/tmp/clodex-ca.pem',
    }, { NO_PROXY: '*' })).toEqual([
      '  HTTPS_PROXY=http://127.0.0.1:17645',
      '  HTTP_PROXY=http://127.0.0.1:17645',
      '  NODE_EXTRA_CA_CERTS=/tmp/clodex-ca.pem',
      '  NO_PROXY=',
      '  no_proxy=',
    ]);
  });
});
