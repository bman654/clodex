import type { CachedModel } from '../registry/types.js';

export const OLLAMA_CLOUD_PROVIDER_ID = 'ollama-cloud';
export const OLLAMA_CLOUD_PROVIDER_NAME = 'Ollama Cloud';
export const OLLAMA_CLOUD_COMPLETIONS_BASE_URL = 'https://ollama.com/v1';

type OllamaCloudModel = Pick<CachedModel, 'id' | 'name'>
  & Partial<Omit<CachedModel, 'id' | 'name'>>;

const OPENAI_COMPATIBLE = '@ai-sdk/openai-compatible';

// Context windows: `model_info.*.context_length` from ollama.com `/api/show`
// for each id (measured 2026-10-01: all four report 1048576).
const CATALOG: OllamaCloudModel[] = [
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1048576, family: 'kimi' },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1048576, family: 'glm' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', contextWindow: 1048576, family: 'glm' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1048576, family: 'deepseek' },
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
