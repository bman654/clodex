import { describe, it, expect } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { effortProviderOptions } from '../src/provider-factory.js';

/**
 * Every other effort assertion in this suite compares clodex's returned object to a
 * literal copy of what clodex builds — so a wrong option KEY, or the AI SDK renaming
 * one on a future pinned bump, leaves them all green while nothing reaches the wire.
 *
 * This drives the real @ai-sdk/openai Responses model with a stubbed fetch and reads
 * the request body it actually serialises. No network: the fetch never leaves the
 * process, and the WebSocket transport is not involved because this is the plain
 * provider rather than the OAuth one.
 *
 * The SDK decides on its own whether a model reasons, from an id list
 * (o1|o3|o4-mini|gpt-5*) that matches neither gpt-6 nor the codenamed aliases, and
 * drops the effort for anything it does not recognise. That is what forceReasoning
 * exists to override, and this is the only test that would notice if it stopped
 * working.
 */
async function emittedRequestBody(modelId: string, effort: string): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const provider = createOpenAI({
    apiKey: 'test-key',
    fetch: (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: modelId,
          output: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch,
  });

  await provider.responses(modelId).doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    providerOptions: effortProviderOptions(
      '@ai-sdk/openai',
      effort,
      modelId,
      { reasoning: true },
    ) as never,
  } as never);

  if (!captured) throw new Error('no request body captured');
  return captured;
}

describe('OpenAI reasoning effort on the wire', () => {
  it.each(['gpt-6-astra', 'gpt-daybreak-blue-latest'])(
    'puts the chosen effort in the %s request body',
    async modelId => {
      const body = await emittedRequestBody(modelId, 'high');
      expect(body.reasoning).toMatchObject({ effort: 'high' });
    },
  );

  // The family that already worked, to show the test is measuring the wire and not
  // just agreeing with itself.
  it('keeps sending the effort for gpt-5.6-sol', async () => {
    const body = await emittedRequestBody('gpt-5.6-sol', 'high');
    expect(body.reasoning).toMatchObject({ effort: 'high' });
  });

  // Over-scope: a model clodex refuses to admit must carry no reasoning block at all,
  // proving the wire follows the admission decision rather than the SDK's own guess.
  it('sends no reasoning block for a model clodex will not admit', async () => {
    const body = await emittedRequestBody('gpt-4o', 'high');
    expect(body.reasoning).toBeUndefined();
  });
});
