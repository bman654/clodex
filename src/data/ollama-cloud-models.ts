import type { CachedModel } from '../registry/types.js';

export const OLLAMA_CLOUD_PROVIDER_ID = 'ollama-cloud';
export const OLLAMA_CLOUD_PROVIDER_NAME = 'Ollama Cloud';
export const OLLAMA_CLOUD_COMPLETIONS_BASE_URL = 'https://ollama.com/v1';

type OllamaCloudModel = Pick<CachedModel, 'id' | 'name'>
  & Partial<Omit<CachedModel, 'id' | 'name'>>;

const OPENAI_COMPATIBLE = '@ai-sdk/openai-compatible';

// TODO(verify): none of these ids exist in src/data/models-dev-cache.json (its
// `ollama-cloud` entry predates them), so the context windows below are
// conservative values taken from the closest same-family models there
// (kimi-k2.6 262144, glm-5.1 202752) — except deepseek-v4.1-flash, which is
// deliberately set well below its v4-flash sibling's 1048576. Replace with
// the published limits once confirmed. A too-small window only compacts
// early; a too-large one breaks auto-compaction.
const CATALOG: OllamaCloudModel[] = [
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 262144, family: 'kimi' },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 202752, family: 'glm' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 202752, family: 'glm' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 262144, family: 'deepseek' },
].map(model => ({
  ...model,
  upstreamModelId: model.id,
  modelFormat: 'openai' as const,
  npm: OPENAI_COMPATIBLE,
  apiUrl: OLLAMA_CLOUD_COMPLETIONS_BASE_URL,
  // Subscription pricing: no per-token cost is published, so none is set and
  // the template's preserveModelPricing keeps the global pricing cache off it.
  modalities: ['text'],
  compatibility: {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens' as const,
    // Effort mapping is unverified against ollama.com; send none.
    supportsReasoningEffort: false,
  },
}));

/**
 * Curated Ollama Cloud models supported by Clodex (Chat Completions only,
 * served at https://ollama.com/v1). Live `/v1/models` is availability data;
 * this catalog is the allowlist and supplies per-model metadata.
 */
export function buildOllamaCloudModels(): OllamaCloudModel[] {
  return structuredClone(CATALOG);
}
