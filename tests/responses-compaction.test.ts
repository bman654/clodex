import { describe, expect, it, vi } from 'vitest';
import {
  compactRequestPayload,
  compactResponsesWindow,
  OPENAI_COMPACTION_DEFAULT_RATIO,
  OPENAI_COMPACTION_PREFLIGHT_MARGIN_TOKENS,
  resolveOpenAiCompactionPreflightThreshold,
  resolveOpenAiCompactionThreshold,
  ResponsesCompactionError,
  responsesCompactUrl,
} from '../src/oauth/responses-compaction.js';

describe('Responses standalone compaction', () => {
  it('leaves a preflight margin below the authoritative OpenAI threshold', () => {
    expect(resolveOpenAiCompactionPreflightThreshold(900_000))
      .toBe(900_000 - OPENAI_COMPACTION_PREFLIGHT_MARGIN_TOKENS);
    expect(resolveOpenAiCompactionPreflightThreshold(10_000)).toBe(10_000);
    expect(resolveOpenAiCompactionPreflightThreshold(0)).toBe(1);
  });

  it('is opt-in and defaults enabled sessions to Codex-compatible 90% utilization', () => {
    expect(resolveOpenAiCompactionThreshold(272_000, {})).toBeUndefined();
    expect(resolveOpenAiCompactionThreshold(272_000, {
      CLODEX_OPENAI_COMPACTION: '0',
    })).toBeUndefined();
    expect(resolveOpenAiCompactionThreshold(272_000, {
      CLODEX_OPENAI_COMPACTION: 'true',
      CLODEX_OPENAI_COMPACT_THRESHOLD: '12345',
    })).toBe(12_345);
    expect(resolveOpenAiCompactionThreshold(272_000, {
      CLODEX_OPENAI_COMPACTION: 'true',
      CLODEX_OPENAI_COMPACT_THRESHOLD: 'not-a-token-count',
    })).toBe(244_800);
    expect(resolveOpenAiCompactionThreshold(272_000, {
      CLODEX_OPENAI_COMPACTION: 'true',
      CLODEX_OPENAI_COMPACT_THRESHOLD: '-1',
    })).toBe(Math.floor(272_000 * OPENAI_COMPACTION_DEFAULT_RATIO));
    expect(resolveOpenAiCompactionThreshold(272_000, {
      CLODEX_OPENAI_COMPACTION: 'true',
      CLODEX_OPENAI_COMPACT_THRESHOLD: '1.5',
    })).toBe(Math.floor(272_000 * OPENAI_COMPACTION_DEFAULT_RATIO));
    expect(resolveOpenAiCompactionThreshold(undefined, {
      CLODEX_OPENAI_COMPACTION: 'true',
    })).toBeUndefined();
  });

  it('targets /responses/compact for both canonical and provider-prefixed URLs', () => {
    expect(responsesCompactUrl('https://api.openai.com/v1/responses?stream=true'))
      .toBe('https://api.openai.com/v1/responses/compact');
    expect(responsesCompactUrl('https://api.openai.com/v1/responses/compact'))
      .toBe('https://api.openai.com/v1/responses/compact');
    expect(responsesCompactUrl('https://example.test/backend-api/codex'))
      .toBe('https://example.test/backend-api/codex/responses/compact');
  });

  it('sends the Codex compact fields, preserves the cache key, and returns canonical output', async () => {
    const compacted = [
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      { type: 'compaction', encrypted_content: 'opaque-summary' },
    ];
    const requestFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer test-token');
      expect(headers.get('openai-beta')).toBe('other-feature=v1');
      expect(headers.get('accept')).toBe('application/json');
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.has('content-length')).toBe(false);
      return new Response(JSON.stringify({
        output: compacted,
        usage: {
          input_tokens: 10_000,
          input_tokens_details: { cached_tokens: 9_500, cache_write_tokens: 400 },
          output_tokens: 100,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const payload = {
      model: 'gpt-5.6-sol',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      instructions: 'Stable prefix.',
      tools: [{ type: 'function', name: 'Read' }],
      parallel_tool_calls: false,
      reasoning: { effort: 'medium' },
      service_tier: 'default',
      prompt_cache_key: 'stable-session-key',
      text: { verbosity: 'medium' },
      store: false,
      stream: true,
      previous_response_id: 'must-not-cross-compact-boundary',
    };

    const result = await compactResponsesWindow({
      requestUrl: 'https://chatgpt.com/backend-api/codex/responses',
      headers: {
        Authorization: 'Bearer test-token',
        'OpenAI-Beta': 'responses_websockets=2026-02-06, other-feature=v1',
        'Content-Length': '123',
      },
      payload,
      fetch: requestFetch as typeof fetch,
    });

    expect(requestFetch).toHaveBeenCalledOnce();
    expect(requestFetch.mock.calls[0]![0])
      .toBe('https://chatgpt.com/backend-api/codex/responses/compact');
    const body = JSON.parse(String(requestFetch.mock.calls[0]![1]?.body));
    expect(body).toEqual({
      model: 'gpt-5.6-sol',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      instructions: 'Stable prefix.',
      tools: [{ type: 'function', name: 'Read' }],
      parallel_tool_calls: false,
      reasoning: { effort: 'medium' },
      service_tier: 'default',
      prompt_cache_key: 'stable-session-key',
      text: { verbosity: 'medium' },
    });
    expect(compactRequestPayload(payload)).toEqual(body);
    expect(result).toEqual({
      output: compacted,
      usage: {
        inputTokens: 10_000,
        cachedTokens: 9_500,
        cacheWriteTokens: 400,
        outputTokens: 100,
      },
    });
  });

  it('fails without exposing an upstream error message', async () => {
    const requestFetch = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'sensitive upstream detail' },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));

    let thrown: unknown;
    try {
      await compactResponsesWindow({
        requestUrl: 'https://example.test/responses',
        headers: {},
        payload: { model: 'gpt-5.6-sol', input: [] },
        fetch: requestFetch as typeof fetch,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ResponsesCompactionError);
    expect((thrown as ResponsesCompactionError).statusCode).toBe(400);
    expect(String(thrown)).not.toContain('sensitive upstream detail');
    expect(String(thrown)).toMatch(/error [0-9a-f]{16}/);
  });

  it('aborts a compact request at its own bounded timeout', async () => {
    const requestFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => (
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })
    ));

    await expect(compactResponsesWindow({
      requestUrl: 'https://example.test/responses',
      headers: {},
      payload: { model: 'gpt-5.6-sol', input: [] },
      fetch: requestFetch as typeof fetch,
      timeoutMs: 5,
    })).rejects.toThrow(/compaction exceeded/);
  });
});
