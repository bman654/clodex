import type { CachedModel } from '../registry/types.js';

export const OLLAMA_CLOUD_PROVIDER_ID = 'ollama-cloud';
export const OLLAMA_CLOUD_PROVIDER_NAME = 'Ollama Cloud';
export const OLLAMA_CLOUD_COMPLETIONS_BASE_URL = 'https://ollama.com/v1';

type OllamaCloudModel = Pick<CachedModel, 'id' | 'name'>
  & Partial<Omit<CachedModel, 'id' | 'name'>>;

const OPENAI_COMPATIBLE = '@ai-sdk/openai-compatible';

// Context windows: `model_info.*.context_length` from ollama.com `/api/show`
// for each id (measured 2026-10-01: all four report 1048576).
// Modalities: `/api/show` `capabilities` lists `vision` for every id except
// glm-5.3 (checked 2026-10-13). Image input through clodex is untested.
const CATALOG: OllamaCloudModel[] = ([
  {
    id: 'kimi-k3',
    name: 'Kimi K3',
    contextWindow: 1048576,
    family: 'kimi',
    modalities: ['text', 'image'],
  },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1048576, family: 'glm', modalities: ['text'] },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3 Flash',
    contextWindow: 1048576,
    family: 'glm',
    modalities: ['text', 'image'],
  },
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1048576,
    family: 'deepseek',
    modalities: ['text', 'image'],
  },
] satisfies OllamaCloudModel[]).map(model => ({
  ...model,
  upstreamModelId: model.id,
  modelFormat: 'openai' as const,
  npm: OPENAI_COMPATIBLE,
  apiUrl: OLLAMA_CLOUD_COMPLETIONS_BASE_URL,
  // Ollama publishes pay-as-you-go per-token rates (https://ollama.com/pricing),
  // but clodex does not record them for this provider: no cost is set, and the
  // template's preserveModelPricing keeps the global pricing cache off it.
  compatibility: {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens' as const,
    // Effort mapping is unverified against ollama.com; send none.
    supportsReasoningEffort: false,
    // ollama.com sends a streamed usage chunk only when the request carries
    // stream_options.include_usage (observed 2026-10-13); without it every
    // streamed turn reports output_tokens 0.
    supportsStreamUsage: true,
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
