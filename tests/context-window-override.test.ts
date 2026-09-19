import { describe, it, expect, beforeEach } from 'vitest';
import { cachedModelToLocal } from '../src/registry/materialize.js';
import { primeSavedContextStops, resetContextStops } from '../src/context-modes.js';
import type { CachedModel, RegistryProvider } from '../src/registry/types.js';

/**
 * End to end for the window a user can now raise.
 *
 * `clodex models --context <model>=1048576 --save` writes the stop to preferences,
 * and every surface that reports a window — the proxy catalog, the child env, the
 * patched binary — reads it back through `cachedModelToLocal`. Before this change
 * the saved stop was silently clamped to the 200,000 clodex had invented and then
 * stored, so the user's number never survived the round trip.
 */
function provider(): RegistryProvider {
  return {
    id: 'go',
    templateId: 'custom-openai',
    name: 'OpenCode Go',
    enabled: true,
    authRef: 'keyring:provider:go',
    authType: 'api',
    api: { url: 'https://api.example/v1', npm: '@ai-sdk/openai-compatible' },
  } as RegistryProvider;
}

function model(overrides: Partial<CachedModel> = {}): CachedModel {
  return {
    // No heuristic rule claims this id, so tier 3 is the only thing that ever
    // answered for it.
    id: 'zz-house-model-9000',
    name: 'House Model',
    upstreamModelId: 'zz-house-model-9000',
    modelFormat: 'openai',
    ...overrides,
  } as CachedModel;
}

beforeEach(() => resetContextStops());

describe('a saved context stop on a model with no published window', () => {
  it('reports the window the user asked for', () => {
    primeSavedContextStops({ 'go:zz-house-model-9000': 1_048_576 });
    const local = cachedModelToLocal(model(), provider());
    expect(local?.contextWindow).toBe(1_048_576);
  });

  it('reports the 200k default when the user has saved nothing', () => {
    const local = cachedModelToLocal(model(), provider());
    expect(local?.contextWindow).toBe(200_000);
  });

  // The stored catalog is where the invention used to be baked in. A cache written
  // by an older clodex still holds 200,000, and that IS a declared window, so it
  // stays the ceiling — the user has to refresh the provider's models to clear it.
  // Pinned so the upgrade behaviour is a decision rather than a surprise.
  it('still clamps when an older cache stored the invented 200k', () => {
    primeSavedContextStops({ 'go:zz-house-model-9000': 1_048_576 });
    const local = cachedModelToLocal(model({ contextWindow: 200_000 }), provider());
    expect(local?.contextWindow).toBe(200_000);
  });

  it('still clamps a stop above a window the provider did publish', () => {
    primeSavedContextStops({ 'go:zz-house-model-9000': 1_048_576 });
    const local = cachedModelToLocal(model({ contextWindow: 262_144 }), provider());
    expect(local?.contextWindow).toBe(262_144);
  });
});
