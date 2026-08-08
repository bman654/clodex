#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// OpenCode's own catalog service (the opencode CLI consumes the same feed).
// Supplies per-model metadata: name, context window, cost, modalities.
const MODELS_DEV_URL = 'https://models.dev/api.json';
const PROVIDER_ID = 'opencode-go';
const MODELS_PATH = resolve('src/data/opencode-go-models.json');
const CONSTANTS_PATH = resolve('src/data/opencode-go-models.ts');

const COMPLETIONS_BASE_URL = 'https://opencode.ai/zen/go/v1';
const ANTHROPIC_BASE_URL = 'https://opencode.ai/zen/go';

// models.dev does not publish per-model wire transport, and the family-level
// summary in the Zen docs is not reliable per model (minimax-m3 is
// Anthropic-format while minimax-m2.x are Chat Completions; gpt-5.6-luna rides
// Chat Completions, not Responses). This map is clodex's live-validated
// routing knowledge: catalog entries only exist for ids mapped here. A new
// model on models.dev surfaces in the updater's "unmapped" report and is added
// once its transport is verified against the live endpoint. Responses-only
// models (grok, mainline gpt) are deliberately absent.
const TRANSPORTS = {
  'deepseek-v4-flash': 'openai-completions',
  'deepseek-v4-pro': 'openai-completions',
  'glm-5.1': 'openai-completions',
  'glm-5.2': 'openai-completions',
  'gpt-5.6-luna': 'openai-completions',
  'hy3': 'openai-completions',
  'kimi-k2.6': 'openai-completions',
  'kimi-k2.7-code': 'openai-completions',
  'kimi-k3': 'openai-completions',
  'mimo-v2.5': 'openai-completions',
  'mimo-v2.5-pro': 'openai-completions',
  'minimax-m2.7': 'openai-completions',
  'minimax-m3': 'anthropic-messages',
  'qwen3.6-plus': 'openai-completions',
  'qwen3.7-max': 'anthropic-messages',
  'qwen3.7-plus': 'anthropic-messages',
  'qwen3.8-max': 'anthropic-messages',
};

// Clodex-side compatibility behavior per model, validated against the live
// endpoint. models.dev carries none of this; it travels with the transport map.
const PATCHES = {
  'deepseek-v4-flash': {
    reasoningEffortMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: 'deepseek',
  },
  'deepseek-v4-pro': {
    reasoningEffortMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: 'deepseek',
  },
  'glm-5.1': {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'glm-5.2': {
    reasoningEffortMap: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' },
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'hy3': {
    reasoningEffortMap: { off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null },
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'kimi-k2.6': {
    reasoningEffortMap: { minimal: null, low: null, medium: null },
    supportsStore: false,
    supportsDeveloperRole: false,
    thinkingFormat: 'deepseek',
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsLongCacheRetention: false,
  },
  'kimi-k2.7-code': {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'kimi-k3': {
    reasoningEffortMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: 'max' },
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'mimo-v2.5': {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'mimo-v2.5-pro': {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'minimax-m2.7': {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'qwen3.6-plus': {
    supportsStore: false,
    supportsDeveloperRole: false,
    thinkingFormat: 'qwen',
    maxTokensField: 'max_tokens',
  },
};

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'clodex-opencode-go-catalog-updater' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  return response.json();
}

function toClodexModel(id, devModel) {
  const transport = TRANSPORTS[id];
  const anthropic = transport === 'anthropic-messages';
  const devCost = devModel.cost ?? {};
  const cost = {
    input: devCost.input ?? 0,
    output: devCost.output ?? 0,
    ...(devCost.cache_read ? { cache_read: devCost.cache_read } : {}),
    ...(devCost.cache_write ? { cache_write: devCost.cache_write } : {}),
  };
  const compatibility = PATCHES[id];
  const modalities = (devModel.modalities?.input ?? ['text'])
    .filter(value => value === 'text' || value === 'image');

  return {
    id,
    name: devModel.name ?? id,
    contextWindow: devModel.limit?.context,
    cost,
    modelFormat: anthropic ? 'anthropic' : 'openai',
    npm: anthropic ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
    apiUrl: anthropic ? ANTHROPIC_BASE_URL : COMPLETIONS_BASE_URL,
    reasoning: devModel.reasoning === true,
    modalities,
    ...(compatibility ? { compatibility } : {}),
    upstreamModelId: id,
    family: id.split('-')[0] ?? id,
  };
}

async function updateSourceConstant(fetchedAt) {
  const source = await readFile(CONSTANTS_PATH, 'utf8');
  const pattern = /export const OPENCODE_GO_SOURCE_FETCHED_AT = '[^']*';/;
  if (!pattern.test(source)) {
    throw new Error('Could not find OPENCODE_GO_SOURCE_FETCHED_AT in opencode-go-models.ts');
  }
  await writeFile(
    CONSTANTS_PATH,
    source.replace(pattern, `export const OPENCODE_GO_SOURCE_FETCHED_AT = '${fetchedAt}';`),
  );
}

async function main() {
  const catalog = await fetchJson(MODELS_DEV_URL);
  const provider = catalog?.[PROVIDER_ID];
  const devModels = provider?.models;
  if (!devModels || typeof devModels !== 'object') {
    throw new Error(`models.dev catalog has no "${PROVIDER_ID}" provider models`);
  }

  const supported = [];
  const unmapped = [];
  for (const [id, devModel] of Object.entries(devModels).sort(([a], [b]) => a.localeCompare(b))) {
    if (!TRANSPORTS[id]) {
      unmapped.push(id);
      continue;
    }
    supported.push(toClodexModel(id, devModel));
  }

  const missing = Object.keys(TRANSPORTS).filter(id => !devModels[id]);
  if (missing.length > 0) {
    throw new Error(`Transport-mapped models missing from models.dev: ${missing.join(', ')}`);
  }
  if (supported.length === 0) {
    throw new Error('models.dev catalog produced no supported models');
  }

  await writeFile(MODELS_PATH, `${JSON.stringify(supported, null, 2)}\n`);
  await updateSourceConstant(new Date().toISOString());

  console.log(`Updated ${supported.length} OpenCode Go models from ${MODELS_DEV_URL} (${PROVIDER_ID}).`);
  if (unmapped.length > 0) {
    console.log(
      'Present on models.dev but not transport-mapped (verify wire protocol '
      + `against the live endpoint, then add to TRANSPORTS): ${unmapped.join(', ')}`,
    );
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
