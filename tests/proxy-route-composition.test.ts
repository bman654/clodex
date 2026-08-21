import { describe, expect, it } from 'vitest';
import { singleModelProxyRoute } from '../src/proxy.js';

/**
 * `clodex claude --endpoint` and the non-TTY / print-mode / no-favorites launch
 * paths all reach the runtime through the single-model wrapper. It builds its
 * route as an object literal with no spread, so a field the wrapper forgets is
 * `undefined` at runtime with nothing failing: the pricing-boundary warning
 * simply never fires, which looks identical to never crossing the boundary.
 */
describe('singleModelProxyRoute', () => {
  it('carries the pricing boundary onto the route', () => {
    const route = singleModelProxyRoute('', 'gpt-5.6-sol', 828_400, {
      npm: '@ai-sdk/openai',
      upstreamModelId: 'gpt-5.6-sol',
      providerId: 'openai-oauth',
      authType: 'oauth',
      pricingBoundary: 272_000,
    });
    expect(route.pricingBoundary).toBe(272_000);
    expect(route.contextWindow).toBe(828_400);
    expect(route.providerId).toBe('openai-oauth');
  });

  // Absent is a real answer: a model with no documented band must not inherit one.
  it('leaves the boundary unset when the model has none', () => {
    const route = singleModelProxyRoute('', 'some-model', 200_000, {
      npm: '@ai-sdk/openai',
    });
    expect(route.pricingBoundary).toBeUndefined();
  });

  it('keys the route on the id the client is told to use', () => {
    const route = singleModelProxyRoute('', 'gpt-5.6-sol', 272_000, {
      upstreamModelId: 'gpt-5.6-sol',
    });
    expect(route.realModelId).toBe('gpt-5.6-sol');
    expect(route.aliasId).toBeTruthy();
  });
});
