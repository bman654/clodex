// tests/upstream-forward.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { anthropicUpstreamHeaders, fetchWithOAuthRetry, relayAnthropicMessages } from '../src/upstream-forward.js';

const servers: Server[] = [];

function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await new Promise(resolve => server.close(resolve));
  }
});

describe('anthropicUpstreamHeaders', () => {
  it('includes bearer and x-api-key', () => {
    expect(anthropicUpstreamHeaders('secret-key')).toMatchObject({
      Authorization: 'Bearer secret-key',
      'x-api-key': 'secret-key',
      'anthropic-version': '2023-06-01',
    });
  });

  it('adds stream accept header when requested', () => {
    expect(anthropicUpstreamHeaders('secret-key', true).Accept).toBe('text/event-stream');
  });

  it('adds Claude Code session header for OAuth requests', () => {
    expect(anthropicUpstreamHeaders(
      'oauth-token',
      true,
      'oauth-2025-04-20',
      'oauth',
      'session-123',
    )).toMatchObject({
      Authorization: 'Bearer oauth-token',
      'User-Agent': 'claude-cli/2.1.195 (external, cli)',
      'x-app': 'cli',
      'X-Claude-Code-Session-Id': 'session-123',
    });
  });
});

describe('fetchWithOAuthRetry', () => {
  it('refreshes once on 401 and retries with the refreshed token', async () => {
    const refreshToken = vi.fn(async () => 'new-token');
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 401 })
      .mockResolvedValueOnce({ status: 200 });

    const result = await fetchWithOAuthRetry('old-token', request, refreshToken);

    expect(result.response.status).toBe(200);
    expect(result.apiKey).toBe('new-token');
    expect(result.refreshed).toBe(true);
    expect(request).toHaveBeenNthCalledWith(1, 'old-token');
    expect(request).toHaveBeenNthCalledWith(2, 'new-token');
  });
});

describe('relayAnthropicMessages redirect handling', () => {
  it('refuses an upstream redirect instead of replaying the key to its target', async () => {
    const sink = vi.fn<RequestListener>((_req, res) => { res.writeHead(200); res.end('{}'); });
    const sinkUrl = await listen(sink);

    const upstreamUrl = await listen((_req, res) => {
      res.writeHead(302, { location: `${sinkUrl}/v1/messages` });
      res.end();
    });

    const gatewayUrl = await listen((_req, res) => {
      void relayAnthropicMessages(res, `${upstreamUrl}/v1/messages`, { model: 'm' }, 'secret-key', false);
    });

    const res = await fetch(gatewayUrl, { method: 'POST' });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('redirect') },
    });
    expect(sink).not.toHaveBeenCalled();
  });
});
