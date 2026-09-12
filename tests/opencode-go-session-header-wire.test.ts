import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createLanguageModel } from '../src/provider-factory.js';
import { generateAnthropicResponse } from '../src/sdk-adapter.js';
import { openCodeGoSessionHeaders } from '../src/data/opencode-go-models.js';

/**
 * The SDK-route tests in `opencode-go-session-header.test.ts` mock model creation
 * and the generation call, so they assert `params.headers` rather than what leaves
 * the process — overwriting the header inside sdk-adapter's generation calls passes
 * that whole suite. This file closes that gap the only way it can be closed: no
 * mocks at all, a real `@ai-sdk/openai-compatible` model pointed at a local
 * listener, and the assertion made on the bytes the listener received.
 */
const SESSION_ID = 'f3c1a0f4-5cf0-4b1a-9d3e-6a2a1a5c9f01';

async function startChatCompletionsListener(): Promise<{
  baseUrl: string;
  received: Array<string | undefined>;
  close: () => Promise<void>;
}> {
  const received: Array<string | undefined> = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    const raw = req.headers['x-opencode-session'];
    received.push(Array.isArray(raw) ? raw[0] : raw);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-wire',
      object: 'chat.completion',
      created: 0,
      model: 'deepseek-v4.1-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'wire ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing listener address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    received,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}

describe('the Go session header reaches the wire through the real SDK path', () => {
  it('arrives as a request header on an openai-compatible generation', async () => {
    const listener = await startChatCompletionsListener();
    try {
      const model = await createLanguageModel({
        npm: '@ai-sdk/openai-compatible',
        modelId: 'deepseek-v4.1-flash',
        apiKey: 'go-key',
        baseURL: listener.baseUrl,
        providerId: 'opencode-go',
        authType: 'api',
      });
      const headers = openCodeGoSessionHeaders({ providerId: 'opencode-go' }, SESSION_ID);
      await generateAnthropicResponse(
        model,
        { messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 16, headers },
        'deepseek-v4.1-flash',
      );
      expect(listener.received).toEqual([SESSION_ID]);
    } finally {
      await listener.close();
    }
  });
});
