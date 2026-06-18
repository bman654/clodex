import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexProxyRoutesFromResolved, resolveCodexFavorites } from '../src/codex/favorites-launch.js';
import { getFavoritesCatalogPath, getFavoritesAppCatalogPath } from '../src/codex/profile.js';
import { ownedOverlayPaths, getRelayAiCodexDir } from '../src/codex/session.js';
import { buildCodexChildEnv } from '../src/codex/launch.js';
import { ownedAppCatalogPaths, removeAppCatalogs } from '../src/codex/app-session.js';
import type { CodexRoute } from '../src/codex/routing.js';
import type { ResolvedFavorite } from '../src/favorites-resolver.js';
import type { LocalProvider, FavoriteModel, ModelInfo } from '../src/types.js';

const anthropicProvider: LocalProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  apiKey: 'ant-key',
  models: [{
    id: 'claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    family: 'claude',
    brand: 'Anthropic',
    modelFormat: 'anthropic',
    upstreamModelId: 'claude-sonnet-4-5-20250929',
    baseUrl: 'https://api.anthropic.com',
    contextWindow: 200000,
  }],
};

let tempHome: string;
let previousHome: string | undefined;
let previousRelayHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'relay-codex-favorites-'));
  previousHome = process.env['HOME'];
  previousRelayHome = process.env['RELAY_AI_HOME'];
  process.env['HOME'] = tempHome;
  process.env['RELAY_AI_HOME'] = join(tempHome, 'relay-ai');
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  if (previousRelayHome === undefined) delete process.env['RELAY_AI_HOME'];
  else process.env['RELAY_AI_HOME'] = previousRelayHome;
});

describe('buildCodexProxyRoutesFromResolved', () => {
  it('maps ResolvedFavorite[] to CodexProxyRoute[]', () => {
    const resolved: ResolvedFavorite[] = [
      {
        providerId: 'anthropic',
        providerName: 'Anthropic',
        model: anthropicProvider.models[0]!,
        apiKey: 'ant-key',
      },
    ];
    const routes = buildCodexProxyRoutesFromResolved(
      resolved,
      new Map([['anthropic', anthropicProvider]]),
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]?.modelId).toBe('claude-sonnet-4.5');
    expect(routes[0]?.upstreamModelId).toBe('claude-sonnet-4-5-20250929');
  });

  it('skips entries whose provider is missing from the map', () => {
    const resolved: ResolvedFavorite[] = [
      { providerId: 'unknown', providerName: 'X', model: anthropicProvider.models[0]!, apiKey: 'k' },
    ];
    const routes = buildCodexProxyRoutesFromResolved(resolved, new Map());
    expect(routes).toEqual([]);
  });
});

describe('resolveCodexFavorites', () => {
  it('resolves active provider + favorites and filters stale favorites', () => {
    const favorites: FavoriteModel[] = [
      { providerId: 'anthropic', modelId: 'claude-sonnet-4.5' },
      { providerId: 'unknown', modelId: 'missing-model' }, // stale
    ];
    const compatible = [anthropicProvider];
    const { resolvedFavorites, providersById } = resolveCodexFavorites(
      anthropicProvider,
      anthropicProvider.models[0]!,
      compatible,
      favorites,
      'codex',
    );

    expect(resolvedFavorites).toHaveLength(1);
    expect(resolvedFavorites[0]?.providerId).toBe('anthropic');
    expect(resolvedFavorites[0]?.model.id).toBe('claude-sonnet-4.5');
    expect(providersById.get('anthropic')).toEqual(anthropicProvider);
  });

  it('resolves Zen starting model when zenGoApiKey is provided', () => {
    const zenModel: ModelInfo = {
      id: 'deepseek-v4-flash-free',
      name: 'DeepSeek V4 Flash Free',
      family: 'deepseek',
      modelFormat: 'openai',
      sourceBackend: 'zen',
    };
    const zenProvider: LocalProvider = {
      id: 'zen',
      name: 'OpenCode Zen',
      apiKey: '',
      models: [zenModel as LocalProvider['models'][number]],
    };
    const { resolvedFavorites } = resolveCodexFavorites(
      zenProvider,
      zenProvider.models[0]!,
      [zenProvider],
      [],
      'codex',
      'zen-key',
    );

    expect(resolvedFavorites).toHaveLength(1);
    expect(resolvedFavorites[0]?.providerId).toBe('zen');
    expect(resolvedFavorites[0]?.model.id).toBe('deepseek-v4-flash-free');
    expect(resolvedFavorites[0]?.apiKey).toBe('zen-key');
  });

  it('drops Zen favorites when zenGoApiKey is missing', () => {
    const zenModel: ModelInfo = {
      id: 'deepseek-v4-flash-free',
      name: 'DeepSeek V4 Flash Free',
      family: 'deepseek',
      modelFormat: 'openai',
      sourceBackend: 'zen',
    };
    const zenProvider: LocalProvider = {
      id: 'zen',
      name: 'OpenCode Zen',
      apiKey: '',
      models: [zenModel as LocalProvider['models'][number]],
    };
    const { resolvedFavorites } = resolveCodexFavorites(
      zenProvider,
      zenProvider.models[0]!,
      [zenProvider],
      [],
      'codex',
      null,
    );

    expect(resolvedFavorites).toEqual([]);
  });
});

describe('codex favorites launch config paths', () => {
  it('getFavoritesCatalogPath is matched by --restore glob', () => {
    const path = getFavoritesCatalogPath();
    expect(path).toMatch(/models-favorites\.json$/);

    // Create the dummy models-favorites.json file so ownedOverlayPaths sees it
    mkdirSync(getRelayAiCodexDir(), { recursive: true });
    writeFileSync(path, '{}');

    expect(ownedOverlayPaths()).toEqual(expect.arrayContaining([expect.stringMatching(/models-favorites\.json/)]));
  });

  it('buildCodexChildEnv injects RELAY_AI_CODEX_KEY=proxy-local for multi-route proxy', () => {
    const dummyRoute: CodexRoute = {
      tier: 'proxy',
      modelId: 'claude-sonnet-4.5',
      providerId: 'anthropic',
      npm: '@ai-sdk/anthropic',
      upstreamModelId: 'claude-sonnet-4.5',
      apiKey: 'ant-key',
    };
    const env = buildCodexChildEnv(dummyRoute, 12345);
    expect(env.RELAY_AI_CODEX_KEY).toBe('proxy-local');
  });

  it('getFavoritesAppCatalogPath filename matches --restore glob and is cleaned up', () => {
    const path = getFavoritesAppCatalogPath();
    expect(path).toMatch(/app-models-favorites\.json$/);

    // Create the dummy app-models-favorites.json file so ownedAppCatalogPaths sees it
    mkdirSync(getRelayAiCodexDir(), { recursive: true });
    writeFileSync(path, '{}');

    expect(ownedAppCatalogPaths()).toEqual(expect.arrayContaining([expect.stringMatching(/app-models-favorites\.json/)]));

    removeAppCatalogs();
    expect(existsSync(path)).toBe(false);
  });
});
