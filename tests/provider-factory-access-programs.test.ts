import { describe, expect, it, vi } from 'vitest';

const wsFetch = vi.fn(async () => new Response('{}', { status: 500 }));

vi.mock('../src/oauth/responses-websocket.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/oauth/responses-websocket.js')>();
  return { ...actual, createResponsesWebSocketFetch: vi.fn(() => wsFetch) };
});

const { createLanguageModel } = await import('../src/provider-factory.js');

async function sentPayload(accessPrograms?: { cyber?: 'daybreak_blue' }): Promise<Record<string, unknown>> {
  wsFetch.mockClear();
  const model = await createLanguageModel({
    npm: '@ai-sdk/openai',
    modelId: 'gpt-5.6-sol',
    apiKey: 'tok',
    authType: 'oauth',
    oauthAccountId: 'acct-1',
    ...(accessPrograms ? { accessPrograms } : {}),
  });
  await (model as unknown as { doGenerate: (o: unknown) => Promise<unknown> })
    .doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
    .catch(() => undefined);
  const call = wsFetch.mock.calls[0] as unknown as [string, RequestInit] | undefined;
  expect(call).toBeDefined();
  return JSON.parse(call![1].body as string) as Record<string, unknown>;
}

describe('OAuth WebSocket payload', () => {
  it('carries access_programs when the alias configures it', async () => {
    expect((await sentPayload({ cyber: 'daybreak_blue' })).access_programs).toEqual({ cyber: 'daybreak_blue' });
  });

  it('omits access_programs otherwise', async () => {
    expect(await sentPayload()).not.toHaveProperty('access_programs');
  });
});
