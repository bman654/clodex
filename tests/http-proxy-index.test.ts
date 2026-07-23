import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  formatHttpProxyModelLines,
  runHttpProxyServerCommand,
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
        host: '127.0.0.1',
        port: expect.any(Number),
      });
      expect(entries[1]).toMatchObject({
        pid: process.pid,
        port: entries[0].port,
      });
      expect(entries[2]).toMatchObject({
        pid: process.pid,
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
});
