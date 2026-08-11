import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_X_API_KEY_ONLY_AUTH_MODE,
} from '../src/anthropic-auth-mode.js';
import { localModelToRoute } from '../src/catalog.js';
import { localProvidersToServerModels } from '../src/provider-catalog.js';
import { materializeRegistry } from '../src/registry/materialize.js';
import type { RegistryProvider } from '../src/registry/types.js';

function registryProvider(templateId: string): RegistryProvider {
  return {
    id: 'custom-endpoint',
    templateId,
    name: 'Custom endpoint',
    enabled: true,
    authRef: 'keyring:provider:custom-endpoint',
    authType: 'api',
    api: { npm: '@ai-sdk/anthropic', url: 'https://custom.example' },
    addedAt: '2026-08-09T00:00:00.000Z',
    modelsCache: {
      fetchedAt: '2026-08-09T00:00:00.000Z',
      models: [{
        id: 'custom-model',
        name: 'Custom model',
        upstreamModelId: 'custom-model',
        modelFormat: 'anthropic',
        npm: '@ai-sdk/anthropic',
        apiUrl: 'https://custom.example',
      }],
    },
  };
}

describe('Anthropic API-key auth provenance', () => {
  it.each(['custom-anthropic', 'anthropic'])(
    'propagates the %s registry template proof through proxy and server routes',
    templateId => {
      const [provider] = materializeRegistry(
        { schemaVersion: 1, providers: [registryProvider(templateId)] },
        () => 'custom-key',
      );
      expect(provider?.anthropicAuthMode).toBe(ANTHROPIC_X_API_KEY_ONLY_AUTH_MODE);

      const route = localModelToRoute(provider!, provider!.models[0]!);
      expect(route?.anthropicAuthMode).toBe(ANTHROPIC_X_API_KEY_ONLY_AUTH_MODE);

      const [serverModel] = localProvidersToServerModels([provider!]);
      expect(serverModel?.anthropicAuthMode).toBe(ANTHROPIC_X_API_KEY_ONLY_AUTH_MODE);
    },
  );

  it.each(['gateway-anthropic', 'opencode-go'])(
    'does not infer the mode for the %s Anthropic-compatible gateway',
    templateId => {
      const [provider] = materializeRegistry(
        { schemaVersion: 1, providers: [registryProvider(templateId)] },
        () => 'gateway-key',
      );

      expect(provider?.anthropicAuthMode).toBeUndefined();
      expect(localModelToRoute(provider!, provider!.models[0]!)?.anthropicAuthMode).toBeUndefined();
      expect(localProvidersToServerModels([provider!])[0]?.anthropicAuthMode).toBeUndefined();
    },
  );
});
