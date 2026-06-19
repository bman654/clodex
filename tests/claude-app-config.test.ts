import { describe, expect, it } from 'vitest';
import { buildRelayAiConfig } from '../src/claude-desktop/app-config.js';

describe('buildRelayAiConfig', () => {
  it('allows Cowork shell tools to reach external hosts', () => {
    expect(buildRelayAiConfig(54321)).toEqual({
      inferenceProvider: 'gateway',
      inferenceGatewayBaseUrl: 'http://127.0.0.1:54321/anthropic',
      inferenceGatewayApiKey: 'dummy',
      inferenceGatewayAuthScheme: 'bearer',
      coworkEgressAllowedHosts: ['*'],
    });
  });
});
