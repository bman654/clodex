import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { ensureHttpProxyCaBundle, ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';
import { shouldInterceptConnect, startHttpProxy } from '../src/http-proxy/server.js';

const testHome = mkdtempSync(join(tmpdir(), 'clodex-http-proxy-'));
const previousRelayHome = process.env['CLODEX_HOME'];

async function listen(server: http.Server | https.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return address.port;
}

async function connectMitm(proxyPort: number, ca: string): Promise<tls.TLSSocket> {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');

  let response = Buffer.alloc(0);
  while (!response.includes(Buffer.from('\r\n\r\n'))) {
    const [chunk] = await once(socket, 'data') as [Buffer];
    response = Buffer.concat([response, chunk]);
  }
  const boundary = response.indexOf('\r\n\r\n') + 4;
  expect(response.subarray(0, boundary).toString()).toContain('200 Connection Established');
  const remainder = response.subarray(boundary);
  if (remainder.length > 0) socket.unshift(remainder);

  const secure = tls.connect({ socket, servername: 'api.anthropic.com', ca });
  await once(secure, 'secureConnect');
  return secure;
}

async function requestMitm(
  proxyPort: number,
  ca: string,
  path: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
): Promise<string> {
  const socket = await connectMitm(proxyPort, ca);
  let response = '';
  socket.on('data', chunk => { response += chunk.toString(); });
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  socket.write([
    `POST ${path} HTTP/1.1`,
    'Host: api.anthropic.com',
    'Authorization: Bearer subscription-oauth-token',
    'Content-Type: application/json',
    `Content-Length: ${payload.length}`,
    'Connection: close',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ].join('\r\n'));
  socket.write(payload);
  await once(socket, 'close');
  return response;
}

function activeProxySockets(proxyPort: number): net.Socket[] {
  const getActiveHandles = (process as typeof process & {
    _getActiveHandles(): unknown[];
  })._getActiveHandles;
  return getActiveHandles.call(process).filter((handle): handle is net.Socket =>
    handle instanceof net.Socket
    && handle.localPort === proxyPort
    && !handle.destroyed);
}

beforeAll(() => {
  process.env['CLODEX_HOME'] = testHome;
});

afterAll(() => {
  if (previousRelayHome === undefined) delete process.env['CLODEX_HOME'];
  else process.env['CLODEX_HOME'] = previousRelayHome;
  rmSync(testHome, { recursive: true, force: true });
});

describe('selective HTTP proxy', () => {
  it('preserves an existing custom CA in the child trust bundle', () => {
    const certificates = ensureHttpProxyCertificates();
    const extraPath = join(testHome, 'corporate-ca.pem');
    writeFileSync(extraPath, '-----BEGIN CERTIFICATE-----\ncorporate-test\n-----END CERTIFICATE-----\n');
    const combinedPath = ensureHttpProxyCaBundle(certificates.caCertPath, extraPath);
    const combined = readFileSync(combinedPath, 'utf8');
    expect(combinedPath).not.toBe(certificates.caCertPath);
    expect(combined).toContain(certificates.caCert.trim());
    expect(combined).toContain('corporate-test');
  });

  it('intercepts only api.anthropic.com on port 443', () => {
    expect(shouldInterceptConnect('api.anthropic.com:443')).toBe(true);
    expect(shouldInterceptConnect('API.ANTHROPIC.COM.:443')).toBe(true);
    expect(shouldInterceptConnect('api.anthropic.com:8443')).toBe(false);
    expect(shouldInterceptConnect('statsig.anthropic.com:443')).toBe(false);
    expect(shouldInterceptConnect('example.com:443')).toBe(false);
  });

  it('releases both sides of a passthrough CONNECT tunnel when upstream closes', async () => {
    const upstream = net.createServer(socket => socket.end());
    const upstreamPort = await listen(upstream);
    const proxy = await startHttpProxy({ routes: [] });
    const clients: net.Socket[] = [];

    try {
      for (let index = 0; index < 25; index += 1) {
        const client = net.connect({
          host: '127.0.0.1',
          port: proxy.port,
          allowHalfOpen: true,
        });
        clients.push(client);
        await once(client, 'connect');
        client.resume();
        client.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`);
        await once(client, 'end');
      }
      await new Promise(resolve => setImmediate(resolve));

      expect(activeProxySockets(proxy.port)).toHaveLength(0);
    } finally {
      for (const client of clients) client.destroy();
      await proxy.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  it('forwards first-party request bytes and auth unchanged', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'anthropic-inference.jsonl');
    const webSocketDiagnosticsLogPath = join(testHome, 'websocket-diagnostics.jsonl');
    const previousRequestPreview = process.env['CLODEX_LOG_REQUEST_PREVIEW'];
    process.env['CLODEX_LOG_REQUEST_PREVIEW'] = '1';
    let receivedBody = Buffer.alloc(0);
    let receivedAuth: string | undefined;
    let receivedPath: string | undefined;
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      await once(req, 'end');
      receivedBody = Buffer.concat(chunks);
      receivedAuth = req.headers.authorization;
      receivedPath = req.url;
      const sse = [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":321,"output_tokens":1,"cache_creation_input_tokens":12,"cache_read_input_tokens":210}}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"private response text"}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":19,"output_tokens":8,"cache_creation_input_tokens":100,"cache_read_input_tokens":220}}',
        '',
        '',
      ].join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Content-Encoding': 'gzip',
      });
      res.end(gzipSync(sse));
    });
    const originPort = await listen(origin);
    const proxy = await startHttpProxy({
      routes: [],
      inferenceLogPath,
      webSocketDiagnosticsLogPath,
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
    });

    try {
      const body = Buffer.from('{\n  "model" : "claude-sonnet-4-6",\n  "output_config":{"effort":"high"},\n  "messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","data":"private-image-data"}},{"type":"text","text":"identify this Sonnet request"}]}],\n  "stream":true\n}\n');
      const secure = await connectMitm(proxy.port, certificates.caCert);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages?beta=true HTTP/1.1',
        'Host: api.anthropic.com',
        'Authorization: Bearer subscription-oauth-token',
        'Content-Type: application/json',
        `Content-Length: ${body.length}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body.toString());
      await once(secure, 'close');

      expect(response).toContain('200 OK');
      expect(receivedPath).toBe('/v1/messages?beta=true');
      expect(receivedAuth).toBe('Bearer subscription-oauth-token');
      expect(receivedBody.equals(body)).toBe(true);
      // Usage decoding and downstream completion are logged by independent
      // asynchronous paths. Wait for every asserted lifecycle event instead of
      // assuming that response_completed is always recorded last.
      const logDeadline = Date.now() + 5000;
      let inferenceLog = readFileSync(inferenceLogPath, 'utf8');
      let entries = inferenceLog.trim().split('\n').map(line => JSON.parse(line));
      while (
        (!entries.some(entry => entry.event === 'response_completed') ||
          !entries.some(entry => entry.event === 'response_usage' && entry.usageStage === 'message_start') ||
          !entries.some(entry => entry.event === 'response_usage' && entry.usageStage === 'message_delta')) &&
        Date.now() < logDeadline
      ) {
        await new Promise(resolve => setTimeout(resolve, 20));
        inferenceLog = readFileSync(inferenceLogPath, 'utf8');
        entries = inferenceLog.trim().split('\n').map(line => JSON.parse(line));
      }
      expect(entries[0]).toMatchObject({
        modelId: 'claude-sonnet-4-6',
        effort: 'high',
        provider: 'anthropic',
        route: 'passthrough',
        requestPreview: 'user: identify this Sonnet request',
      });
      const responseStarted = entries.find(entry => entry.event === 'response_started');
      const messageStartUsage = entries.find(entry => entry.event === 'response_usage' && entry.usageStage === 'message_start');
      const messageDeltaUsage = entries.find(entry => entry.event === 'response_usage' && entry.usageStage === 'message_delta');
      const responseCompleted = entries.find(entry => entry.event === 'response_completed');
      expect(responseStarted).toMatchObject({
        requestId: entries[0].requestId,
        statusCode: 200,
        route: 'passthrough',
      });
      expect(messageStartUsage).toMatchObject({
        event: 'response_usage',
        requestId: entries[0].requestId,
        modelId: 'claude-sonnet-4-6',
        provider: 'anthropic',
        route: 'passthrough',
        usageStage: 'message_start',
        inputTokens: 321,
        outputTokens: 1,
        cacheCreationInputTokens: 12,
        cacheReadInputTokens: 210,
      });
      expect(messageDeltaUsage).toMatchObject({
        event: 'response_usage',
        requestId: entries[0].requestId,
        modelId: 'claude-sonnet-4-6',
        provider: 'anthropic',
        route: 'passthrough',
        usageStage: 'message_delta',
        inputTokens: 19,
        outputTokens: 8,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 220,
      });
      expect(responseCompleted).toMatchObject({
        requestId: entries[0].requestId,
        statusCode: 200,
        route: 'passthrough',
      });
      expect(inferenceLog).not.toContain('private-image-data');
      expect(inferenceLog).not.toContain('private response text');
      const diagnosticRaw = readFileSync(webSocketDiagnosticsLogPath, 'utf8');
      const diagnostic = JSON.parse(diagnosticRaw.trim());
      expect(diagnostic).toMatchObject({
        event: 'request_diagnostic',
        requestId: entries[0].requestId,
        headers: { authorization: '[REDACTED]' },
        body: {
          parameters: { model: 'claude-sonnet-4-6', stream: true },
          messages: { count: 1 },
        },
      });
      expect(diagnosticRaw).not.toContain('subscription-oauth-token');
      expect(diagnosticRaw).not.toContain('private-image-data');
      expect(diagnosticRaw).not.toContain('identify this Sonnet request');
    } finally {
      if (previousRequestPreview === undefined) delete process.env['CLODEX_LOG_REQUEST_PREVIEW'];
      else process.env['CLODEX_LOG_REQUEST_PREVIEW'] = previousRequestPreview;
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);

  it('logs Haiku passthrough status, error body, and system fallback preview', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'haiku-error-inference.jsonl');
    const previousRequestPreview = process.env['CLODEX_LOG_REQUEST_PREVIEW'];
    process.env['CLODEX_LOG_REQUEST_PREVIEW'] = '1';
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.writeHead(529, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Haiku overloaded for Bearer sk-secret123456789' },
      }));
    });
    const originPort = await listen(origin);
    const proxy = await startHttpProxy({
      routes: [],
      inferenceLogPath,
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
    });

    try {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5',
        system: [{ type: 'text', text: 'Generate a concise title for this Claude Code session.' }],
        messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'private tool output' }] }],
        stream: true,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Authorization: Bearer subscription-oauth-token',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await once(secure, 'close');

      expect(response).toContain('529');
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(entries[0]).toMatchObject({
        modelId: 'claude-haiku-4-5',
        provider: 'anthropic',
        route: 'passthrough',
        requestPreview: 'user: [tool_result] | system: Generate a concise title for this Claude Code session.',
      });
      const upstreamError = entries.find(entry => entry.event === 'upstream_error');
      expect(upstreamError).toMatchObject({
        event: 'upstream_error',
        modelId: 'claude-haiku-4-5',
        provider: 'anthropic',
        route: 'passthrough',
        statusCode: 529,
      });
      expect(upstreamError.errorContent).toContain('Haiku overloaded');
      expect(upstreamError.errorContent).toContain('[REDACTED]');
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_completed',
        requestId: entries[0].requestId,
        statusCode: 529,
      }));
      expect(readFileSync(inferenceLogPath, 'utf8')).not.toContain('private tool output');
    } finally {
      if (previousRequestPreview === undefined) delete process.env['CLODEX_LOG_REQUEST_PREVIEW'];
      else process.env['CLODEX_LOG_REQUEST_PREVIEW'] = previousRequestPreview;
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);

  it('logs a partial upstream error body when the origin resets before end', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'partial-error-inference.jsonl');
    const previousRequestPreview = process.env['CLODEX_LOG_REQUEST_PREVIEW'];
    process.env['CLODEX_LOG_REQUEST_PREVIEW'] = '1';
    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      res.write('{"error":{"message":"partial outage');
      setImmediate(() => res.destroy(new Error('origin reset')));
    });
    const originPort = await listen(origin);
    const proxy = await startHttpProxy({
      routes: [],
      inferenceLogPath,
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
    });

    try {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'test partial error logging' }],
        stream: true,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert);
      secure.resume();
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await new Promise<void>(resolve => {
        secure.once('close', () => resolve());
        secure.once('error', () => resolve());
      });

      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const upstreamError = entries.find(entry => entry.event === 'upstream_error');
      expect(upstreamError).toMatchObject({
        event: 'upstream_error',
        modelId: 'claude-haiku-4-5',
        statusCode: 503,
      });
      expect(upstreamError.errorContent).toContain('partial outage');
      expect(upstreamError.errorContent).toContain('stream error');
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_failed',
        requestId: entries[0].requestId,
        statusCode: 503,
      }));
    } finally {
      if (previousRequestPreview === undefined) delete process.env['CLODEX_LOG_REQUEST_PREVIEW'];
      else process.env['CLODEX_LOG_REQUEST_PREVIEW'] = previousRequestPreview;
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);

  it('logs an Anthropic connection failure as an upstream response failure', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'connection-refused-inference.jsonl');
    const unavailableOrigin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    });
    const unavailablePort = await listen(unavailableOrigin);
    await new Promise<void>(resolve => unavailableOrigin.close(() => resolve()));
    const proxy = await startHttpProxy({
      routes: [],
      inferenceLogPath,
      anthropicOrigin: `https://127.0.0.1:${unavailablePort}`,
      anthropicRejectUnauthorized: false,
    });

    try {
      const body = JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'test refused origin' }],
        stream: true,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await once(secure, 'close');

      expect(response).toContain('502');
      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const requestEntry = entries.find(entry => !entry.event);
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_failed',
        requestId: requestEntry.requestId,
        route: 'passthrough',
        statusCode: 502,
        phase: 'waiting_for_headers',
        errorType: expect.stringMatching(/^ECONN(?:REFUSED|RESET)$/),
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'upstream_error',
        requestId: requestEntry.requestId,
        statusCode: 502,
      }));
    } finally {
      await proxy.close();
    }
  }, 20_000);

  it('routes exact relay models and short aliases while stripping Anthropic auth from the adapter hop', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'relay-inference.jsonl');
    let adapterAuth: string | undefined;
    let adapterApiKey: string | undefined;
    let adapterClaudeSessionId: string | undefined;
    let adapterBody = '';
    let anthropicRequests = 0;
    let fallbackAuth: string | undefined;

    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, async (req, res) => {
      anthropicRequests += 1;
      fallbackAuth = req.headers.authorization;
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.setHeader('Connection', 'close');
      res.end('{"unexpected":true}');
    });
    const originPort = await listen(origin);

    const adapterServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      await once(req, 'end');
      adapterAuth = req.headers.authorization;
      adapterApiKey = req.headers['x-api-key'] as string | undefined;
      adapterClaudeSessionId = req.headers['x-claude-code-session-id'] as string | undefined;
      adapterBody = Buffer.concat(chunks).toString();
      await new Promise(resolve => setTimeout(resolve, 35));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
      res.end([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n'));
    });
    const adapterPort = await listen(adapterServer);
    const proxy = await startHttpProxy({
      routes: [{
        aliasId: 'clodex:groq:llama-3.3-70b',
        realModelId: 'llama-3.3-70b-versatile',
        displayName: 'Llama 3.3 70B (Groq)',
        upstreamUrl: '',
        apiKey: 'provider-key',
        modelFormat: 'openai',
        npm: '@ai-sdk/groq',
        providerId: 'groq',
      }],
      modelAliases: [{
        name: 'llama',
        routeId: 'clodex:groq:llama-3.3-70b',
        displayName: 'Llama 3.3 70B (Groq)',
      }],
      reservedModelIds: ['missing-route'],
      adapterHandle: {
        port: adapterPort,
        token: 'adapter-local-token',
        close: () => {
          adapterServer.closeAllConnections();
          adapterServer.close();
        },
      },
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
      inferenceLogPath,
      responseProgressIntervalMs: 10,
    });

    try {
      const body = JSON.stringify({
        model: 'clodex:groq:llama-3.3-70b',
        output_config: { effort: 'medium' },
        messages: [],
        stream: true,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Authorization: Bearer subscription-oauth-token',
        'X-Claude-Code-Session-Id: 11111111-1111-4111-8111-111111111111',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await once(secure, 'close');

      expect(response).toContain('200 OK');
      expect(anthropicRequests).toBe(0);
      expect(adapterAuth).toBeUndefined();
      expect(adapterApiKey).toBe('adapter-local-token');
      expect(adapterClaudeSessionId).toBe('11111111-1111-4111-8111-111111111111');
      expect(adapterBody).toBe(body);
      const relayEntries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const requestEntry = relayEntries.find(entry => !entry.event);
      expect(requestEntry).toMatchObject({
        modelId: 'clodex:groq:llama-3.3-70b',
        effort: 'medium',
        provider: 'groq',
        route: 'translated',
        stream: true,
      });
      expect(requestEntry.requestId).toEqual(expect.any(String));
      expect(relayEntries).toContainEqual(expect.objectContaining({
        event: 'response_progress',
        requestId: requestEntry.requestId,
        phase: 'waiting_for_headers',
        bytes: 0,
        chunks: 0,
      }));
      expect(relayEntries).toContainEqual(expect.objectContaining({
        event: 'response_started',
        requestId: requestEntry.requestId,
        statusCode: 200,
      }));
      expect(relayEntries).toContainEqual(expect.objectContaining({
        event: 'response_usage',
        requestId: requestEntry.requestId,
        modelId: 'clodex:groq:llama-3.3-70b',
        provider: 'groq',
        route: 'translated',
        usageStage: 'message_start',
        inputTokens: 0,
        outputTokens: 0,
      }));
      expect(relayEntries).toContainEqual(expect.objectContaining({
        event: 'response_completed',
        requestId: requestEntry.requestId,
        statusCode: 200,
      }));

      const aliasBody = JSON.stringify({ model: 'llama', messages: [], stream: true });
      const aliasSocket = await connectMitm(proxy.port, certificates.caCert);
      aliasSocket.resume();
      aliasSocket.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Authorization: Bearer subscription-oauth-token',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(aliasBody)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + aliasBody);
      await once(aliasSocket, 'close');

      expect(anthropicRequests).toBe(0);
      // The alias name reaches the adapter unrewritten: the adapter resolves it
      // via its own modelAliases and echoes it back as the response model id.
      expect(JSON.parse(adapterBody)).toMatchObject({
        model: 'llama',
        messages: [],
      });
      const aliasEntries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(aliasEntries.find(entry => !entry.event && entry.modelId === 'llama')).toMatchObject({
        provider: 'groq',
        route: 'translated',
      });

      const normalizedRouteBody = JSON.stringify({
        model: 'clodex:groq:llama-3.3-70b[1M]',
        messages: [],
        stream: true,
      });
      const normalizedRouteResponse = await requestMitm(
        proxy.port,
        certificates.caCert,
        '/v1/messages',
        normalizedRouteBody,
      );
      expect(normalizedRouteResponse).toContain('200 OK');
      expect(JSON.parse(adapterBody).model).toBe('clodex:groq:llama-3.3-70b[1M]');

      const compressedRouteBody = JSON.stringify({ model: 'llama', messages: [], stream: true });
      const compressedRouteResponse = await requestMitm(
        proxy.port,
        certificates.caCert,
        '/v1/messages',
        gzipSync(Buffer.from(compressedRouteBody)),
        { 'Content-Encoding': 'gzip' },
      );
      expect(compressedRouteResponse).toContain('200 OK');
      expect(JSON.parse(adapterBody).model).toBe('llama');

      const rejectedCases = [
        { model: 'clodex:groq:typo', path: '/v1/messages' },
        { model: 'missing-route', path: '/v1/messages' },
        { model: 'missing-route[1m]', path: '/v1/messages' },
        { model: 'missing-route[1M]', path: '/v1/messages' },
        { model: 'models/missing-route[1m]', path: '/v1/messages' },
        { model: 'missing-route', path: '/v1/messages/count_tokens' },
      ];
      for (const testCase of rejectedCases) {
        const response = await requestMitm(
          proxy.port,
          certificates.caCert,
          testCase.path,
          JSON.stringify({ model: testCase.model, messages: [] }),
        );
        expect(response, `${testCase.path} ${testCase.model}`).toContain('400 Bad Request');
        expect(response).toContain('invalid_request_error');
        expect(response).toContain('clodex models --list');
        expect(response).toContain('clodex patch');
      }

      const compressedUnavailableBody = JSON.stringify({ model: 'missing-route', messages: [] });
      const compressedUnavailableResponse = await requestMitm(
        proxy.port,
        certificates.caCert,
        '/v1/messages',
        gzipSync(Buffer.from(compressedUnavailableBody)),
        { 'Content-Encoding': 'gzip' },
      );
      expect(compressedUnavailableResponse).toContain('400 Bad Request');
      expect(compressedUnavailableResponse).toContain('invalid_request_error');

      const unreadableCompressedResponse = await requestMitm(
        proxy.port,
        certificates.caCert,
        '/v1/messages',
        Buffer.from('not-a-gzip-stream'),
        { 'Content-Encoding': 'gzip' },
      );
      expect(unreadableCompressedResponse).toContain('400 Bad Request');
      expect(unreadableCompressedResponse).toContain('Unable to inspect compressed request body');
      expect(anthropicRequests).toBe(0);
      expect(fallbackAuth).toBeUndefined();

      const unavailableAliasEntries = readFileSync(inferenceLogPath, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      expect(unavailableAliasEntries).toContainEqual(expect.objectContaining({
        event: 'route_unavailable',
        modelId: 'missing-route',
        statusCode: 400,
      }));
      expect(unavailableAliasEntries).not.toContainEqual(expect.objectContaining({
        event: 'upstream_error',
        modelId: 'missing-route',
      }));
      for (const testCase of rejectedCases.filter(item => item.path === '/v1/messages')) {
        expect(unavailableAliasEntries).not.toContainEqual(expect.objectContaining({
          modelId: testCase.model,
          provider: expect.any(String),
          route: expect.any(String),
        }));
      }
    } finally {
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);

  it('routes count_tokens to the adapter without recording it as inference', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'count-tokens-inference.jsonl');
    let adapterPath: string | undefined;
    let anthropicRequests = 0;

    const origin = https.createServer({
      key: certificates.serverKey,
      cert: certificates.serverCert,
    }, (req, res) => {
      anthropicRequests += 1;
      req.resume();
      res.end('{"unexpected":true}');
    });
    const originPort = await listen(origin);
    const adapterServer = http.createServer(async (req, res) => {
      adapterPath = req.url;
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end('{"input_tokens":42}');
    });
    const adapterPort = await listen(adapterServer);
    const route = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai' as const,
      npm: '@ai-sdk/openai-compatible',
      providerId: 'test-provider',
    };
    const proxy = await startHttpProxy({
      routes: [route],
      adapterHandle: {
        port: adapterPort,
        token: 'adapter-local-token',
        close: () => {
          adapterServer.closeAllConnections();
          adapterServer.close();
        },
      },
      anthropicOrigin: `https://127.0.0.1:${originPort}`,
      anthropicRejectUnauthorized: false,
      inferenceLogPath,
    });

    try {
      const body = JSON.stringify({
        model: route.aliasId,
        messages: [{ role: 'user', content: 'count this' }],
      });
      const secure = await connectMitm(proxy.port, certificates.caCert);
      let response = '';
      secure.on('data', chunk => { response += chunk.toString(); });
      secure.write([
        'POST /v1/messages/count_tokens?beta=true HTTP/1.1',
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await once(secure, 'close');

      expect(response).toContain('200 OK');
      expect(response).toContain('{"input_tokens":42}');
      expect(adapterPath).toBe('/v1/messages/count_tokens?beta=true');
      expect(anthropicRequests).toBe(0);
      expect(existsSync(inferenceLogPath)).toBe(false);
    } finally {
      await proxy.close();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  }, 20_000);

  it('closes the adapter request and logs a terminal client disconnect', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'client-disconnect-inference.jsonl');
    let adapterReceivedResolve!: () => void;
    const adapterReceived = new Promise<void>(resolve => { adapterReceivedResolve = resolve; });
    let adapterClosedResolve!: () => void;
    const adapterClosed = new Promise<void>(resolve => { adapterClosedResolve = resolve; });
    const adapterServer = http.createServer((req) => {
      req.resume();
      req.once('end', adapterReceivedResolve);
      req.socket.once('close', adapterClosedResolve);
    });
    const adapterPort = await listen(adapterServer);
    const route = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai' as const,
      npm: '@ai-sdk/openai-compatible',
      providerId: 'test-provider',
    };
    const proxy = await startHttpProxy({
      routes: [route],
      adapterHandle: {
        port: adapterPort,
        token: 'adapter-local-token',
        close: () => {
          adapterServer.closeAllConnections();
          adapterServer.close();
        },
      },
      inferenceLogPath,
    });

    try {
      const body = JSON.stringify({
        model: route.aliasId,
        messages: [{ role: 'user', content: 'wait forever' }],
        stream: false,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert);
      secure.on('error', () => {});
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        '',
        '',
      ].join('\r\n') + body);
      await adapterReceived;
      secure.destroy();
      await adapterClosed;
      await new Promise(resolve => setImmediate(resolve));

      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const requestEntry = entries.find(entry => !entry.event);
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_client_disconnected',
        requestId: requestEntry.requestId,
        phase: 'waiting_for_headers',
      }));
      expect(entries.some(entry => entry.event === 'response_completed')).toBe(false);
      expect(entries.some(entry => entry.event === 'response_failed')).toBe(false);
    } finally {
      await proxy.close();
    }
  }, 20_000);

  it('terminates and logs a translated response when the adapter closes before end', async () => {
    const certificates = ensureHttpProxyCertificates();
    const inferenceLogPath = join(testHome, 'adapter-abort-inference.jsonl');
    const adapterServer = http.createServer(async (req, res) => {
      const ended = once(req, 'end');
      req.resume();
      await ended;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setImmediate(() => res.destroy(new Error('adapter reset')));
    });
    const adapterPort = await listen(adapterServer);
    const route = {
      aliasId: 'clodex:test:translated-model',
      realModelId: 'translated-model',
      displayName: 'Translated Model',
      upstreamUrl: '',
      apiKey: 'provider-key',
      modelFormat: 'openai' as const,
      npm: '@ai-sdk/openai-compatible',
      providerId: 'test-provider',
    };
    const proxy = await startHttpProxy({
      routes: [route],
      adapterHandle: {
        port: adapterPort,
        token: 'adapter-local-token',
        close: () => {
          adapterServer.closeAllConnections();
          adapterServer.close();
        },
      },
      inferenceLogPath,
    });

    try {
      const body = JSON.stringify({
        model: route.aliasId,
        messages: [{ role: 'user', content: 'test adapter reset' }],
        stream: true,
      });
      const secure = await connectMitm(proxy.port, certificates.caCert);
      secure.resume();
      secure.write([
        'POST /v1/messages HTTP/1.1',
        'Host: api.anthropic.com',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n') + body);
      await new Promise<void>(resolve => {
        secure.once('close', () => resolve());
        secure.once('error', () => resolve());
      });

      const entries = readFileSync(inferenceLogPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const requestEntry = entries.find(entry => !entry.event);
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_started',
        requestId: requestEntry.requestId,
        statusCode: 200,
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        event: 'response_failed',
        requestId: requestEntry.requestId,
        statusCode: 200,
        phase: 'streaming',
      }));
      expect(entries.some(entry => entry.event === 'response_completed')).toBe(false);
    } finally {
      await proxy.close();
    }
  }, 20_000);
});
