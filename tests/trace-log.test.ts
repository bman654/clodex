import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getInferenceSessionLogPath,
  getLatestMessagePreview,
  redactTraceLine,
  redactTraceLog,
  writeInferenceRequestLog,
  writeInferenceResponseLifecycleLog,
  writeInferenceResponseErrorLog,
  writeProxyLifecycleLog,
  writeWebSocketDiagnosticRequestLog,
} from '../src/trace-log.js';

describe('trace log redaction', () => {
  it('redacts bearer tokens', () => {
    expect(redactTraceLine('Authorization: Bearer sk-ant-api03-secret123')).toContain('[REDACTED]');
    expect(redactTraceLine('Authorization: Bearer sk-ant-api03-secret123')).not.toContain('secret123');
  });

  it('redacts sk- prefixed keys', () => {
    expect(redactTraceLine('key=sk-abc1234567890')).toBe('key=sk-[REDACTED]');
  });

  it('redacts full log content', () => {
    const log = redactTraceLog('line1\nBearer sk-test123456789012345678901234\nline3');
    expect(log).not.toContain('sk-test123456789012345678901234');
  });
});

describe('inference request log', () => {
  it('logs diagnostic request envelopes while redacting credentials and hashing conversation content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-ai-ws-diagnostic-'));
    const path = join(dir, 'diagnostics.jsonl');
    try {
      writeWebSocketDiagnosticRequestLog(path, {
        requestId: 'req-1',
        provider: 'openai-oauth',
        route: 'translated',
        headers: {
          authorization: 'Bearer private-token',
          'x-api-key': 'private-api-key',
          cookie: 'private-cookie',
          'x-claude-code-session-id': '927b8642-15d2-4535-ab27-1430ae54c4aa',
          'user-agent': 'claude-cli/1.2.3',
        },
        body: {
          model: 'sol',
          stream: true,
          metadata: { user_id: '{"session_id":"927b8642-15d2-4535-ab27-1430ae54c4aa"}' },
          system: [{ type: 'text', text: 'private system prompt' }],
          messages: [{ role: 'user', content: [{ type: 'text', text: 'private conversation' }] }],
          tools: [{ name: 'Read', description: 'private tool description', input_schema: { secret: 'private schema' } }],
        },
      });

      const raw = readFileSync(path, 'utf8');
      const entry = JSON.parse(raw.trim());
      expect(entry).toMatchObject({
        event: 'request_diagnostic',
        requestId: 'req-1',
        headers: {
          authorization: '[REDACTED]',
          'x-api-key': '[REDACTED]',
          cookie: '[REDACTED]',
          'x-claude-code-session-id': '927b8642-15d2-4535-ab27-1430ae54c4aa',
          'user-agent': 'claude-cli/1.2.3',
        },
        body: {
          parameters: {
            model: 'sol',
            stream: true,
            metadata: { user_id: expect.any(String) },
          },
          messages: { count: 1, items: [{ role: 'user', contentKinds: ['text'], hash: expect.any(String) }] },
          tools: { count: 1, items: [{ name: 'Read', hash: expect.any(String) }] },
        },
      });
      expect(raw).not.toContain('private-token');
      expect(raw).not.toContain('private-api-key');
      expect(raw).not.toContain('private-cookie');
      expect(raw).not.toContain('private system prompt');
      expect(raw).not.toContain('private conversation');
      expect(raw).not.toContain('private tool description');
      expect(raw).not.toContain('private schema');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a separate private log path for each proxy session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-ai-session-log-'));
    const previousHome = process.env['RELAY_AI_HOME'];
    process.env['RELAY_AI_HOME'] = dir;
    try {
      const first = getInferenceSessionLogPath('claude-http-proxy');
      const second = getInferenceSessionLogPath('claude-http-proxy');
      expect(first).not.toBe(second);
      expect(first).toContain(join('logs', 'sessions'));
      expect(first).toContain(`claude-http-proxy-pid${process.pid}`);

      writeProxyLifecycleLog(first, {
        event: 'proxy_started',
        pid: process.pid,
        parentPid: process.ppid,
        host: '127.0.0.1',
        port: 58985,
        inheritedProxyPort: 58972,
      });
      expect(JSON.parse(readFileSync(first, 'utf8').trim())).toMatchObject({
        event: 'proxy_started',
        pid: process.pid,
        parentPid: process.ppid,
        host: '127.0.0.1',
        port: 58985,
        inheritedProxyPort: 58972,
      });
    } finally {
      if (previousHome === undefined) delete process.env['RELAY_AI_HOME'];
      else process.env['RELAY_AI_HOME'] = previousHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes only structured routing metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-ai-inference-log-'));
    const path = join(dir, 'requests.jsonl');
    try {
      writeInferenceRequestLog(path, {
        modelId: 'relay:openai:gpt-test[1m]',
        effort: 'high',
        provider: 'openai',
        route: 'translated',
      });
      const entry = JSON.parse(readFileSync(path, 'utf8').trim());
      expect(entry).toMatchObject({
        modelId: 'relay:openai:gpt-test[1m]',
        effort: 'high',
        provider: 'openai',
        route: 'translated',
      });
      expect(entry.timestamp).toEqual(expect.any(String));
      expect(Object.keys(entry).sort()).toEqual(['effort', 'modelId', 'provider', 'route', 'timestamp']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds only the latest message text when request previews are enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-ai-inference-preview-'));
    const path = join(dir, 'requests.jsonl');
    const previous = process.env['RELAY_AI_LOG_REQUEST_PREVIEW'];
    const requestPreview = getLatestMessagePreview([
      { role: 'user', content: 'older prompt' },
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', data: 'private-image-data' } },
          { type: 'text', text: 'identify this request\nwithout logging media' },
          { type: 'tool_result', content: 'private tool result' },
        ],
      },
    ]);

    try {
      delete process.env['RELAY_AI_LOG_REQUEST_PREVIEW'];
      writeInferenceRequestLog(path, {
        modelId: 'claude-sonnet-4-6',
        provider: 'anthropic',
        route: 'passthrough',
        requestPreview,
      });
      process.env['RELAY_AI_LOG_REQUEST_PREVIEW'] = '1';
      writeInferenceRequestLog(path, {
        modelId: 'claude-sonnet-4-6',
        provider: 'anthropic',
        route: 'passthrough',
        requestPreview,
      });

      const raw = readFileSync(path, 'utf8');
      const entries = raw.trim().split('\n').map(line => JSON.parse(line));
      expect(entries[0]).not.toHaveProperty('requestPreview');
      expect(entries[1]).toMatchObject({
        requestPreview: 'user: identify this request without logging media',
      });
      expect(raw).not.toContain('older prompt');
      expect(raw).not.toContain('private-image-data');
      expect(raw).not.toContain('private tool result');
      expect(getLatestMessagePreview([
        { role: 'user', content: [{ type: 'tool_result', content: 'private tool result' }] },
      ])).toBe('user: [tool_result]');
      expect(getLatestMessagePreview(
        [{ role: 'user', content: [{ type: 'tool_result', content: 'private tool result' }] }],
        [{ type: 'text', text: 'Generate a concise conversation title for Claude Code.' }],
      )).toBe('user: [tool_result] | system: Generate a concise conversation title for Claude Code.');
      expect(getLatestMessagePreview([
        { role: 'system', content: 'Classify this request for an OpenAI-compatible client.' },
        { role: 'user', content: [{ type: 'tool_result', content: 'private tool result' }] },
      ])).toBe('user: [tool_result] | system: Classify this request for an OpenAI-compatible client.');
    } finally {
      if (previous === undefined) delete process.env['RELAY_AI_LOG_REQUEST_PREVIEW'];
      else process.env['RELAY_AI_LOG_REQUEST_PREVIEW'] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logs upstream status always and redacted error content only when previews are enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-ai-inference-error-'));
    const path = join(dir, 'requests.jsonl');
    const previous = process.env['RELAY_AI_LOG_REQUEST_PREVIEW'];
    try {
      delete process.env['RELAY_AI_LOG_REQUEST_PREVIEW'];
      writeInferenceResponseErrorLog(path, {
        modelId: 'relay:openai:gpt-test',
        provider: 'openai',
        route: 'translated',
        statusCode: 429,
        errorContent: 'rate limited for Bearer sk-secret123456789',
        isRetryable: true,
        attemptCount: 3,
      });
      process.env['RELAY_AI_LOG_REQUEST_PREVIEW'] = '1';
      writeInferenceResponseErrorLog(path, {
        modelId: 'relay:openai:gpt-test',
        provider: 'openai',
        route: 'translated',
        statusCode: 429,
        errorContent: 'rate limited for Bearer sk-secret123456789',
        isRetryable: true,
        attemptCount: 3,
      });
      writeInferenceResponseErrorLog(path, {
        modelId: 'claude-haiku-4-5',
        provider: 'anthropic',
        route: 'passthrough',
        statusCode: 529,
        errorContent: 'x'.repeat(3_000),
      });

      const entries = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(entries[0]).toMatchObject({
        event: 'upstream_error',
        statusCode: 429,
        isRetryable: true,
        attemptCount: 3,
      });
      expect(entries[0]).not.toHaveProperty('errorContent');
      expect(entries[1].errorContent).toContain('rate limited');
      expect(entries[1].errorContent).toContain('[REDACTED]');
      expect(entries[1].errorContent).not.toContain('secret123456789');
      expect(entries[2].errorContent).toHaveLength(2_000);
      expect(entries[2].errorContent).toMatch(/ \[truncated\]$/);
    } finally {
      if (previous === undefined) delete process.env['RELAY_AI_LOG_REQUEST_PREVIEW'];
      else process.env['RELAY_AI_LOG_REQUEST_PREVIEW'] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes correlated response lifecycle metadata without response content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-ai-inference-lifecycle-'));
    const path = join(dir, 'requests.jsonl');
    try {
      writeInferenceResponseLifecycleLog(path, {
        event: 'translation_progress',
        requestId: 'req-123',
        modelId: 'relay:openai:gpt-test',
        provider: 'openai',
        route: 'translated',
        phase: 'translating',
        durationMs: 30_000.4,
        sdkParts: 42,
        sdkIdleMs: 125.7,
        translatedBytes: 4096,
        translatedChunks: 18,
        outputIdleMs: 100.2,
        lastPartType: 'text-delta',
      });

      const entry = JSON.parse(readFileSync(path, 'utf8').trim());
      expect(entry).toMatchObject({
        event: 'translation_progress',
        requestId: 'req-123',
        modelId: 'relay:openai:gpt-test',
        provider: 'openai',
        route: 'translated',
        phase: 'translating',
        durationMs: 30_000,
        sdkParts: 42,
        sdkIdleMs: 126,
        translatedBytes: 4096,
        translatedChunks: 18,
        outputIdleMs: 100,
        lastPartType: 'text-delta',
      });
      expect(entry).not.toHaveProperty('responseContent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
