// src/provider-templates.ts — builtin provider templates for clodex providers add

export type ProviderAuthType = 'api' | 'oauth' | 'none';
export type ProviderModelSource = 'api-list' | 'static-seed' | 'manual-only';

export interface ProviderTemplate {
  id: string;
  name: string;
  authType: ProviderAuthType;
  npm: string;
  defaultBaseUrl?: string;
  modelsPath?: string;
  signupUrl?: string;
  urlPlaceholder?: string;
  urlPrompt?: string;
  apiKeyOptional?: boolean;
  anonymousFreeModels?: boolean;
  /** Static headers this provider requires on every request (model listing and runtime). */
  headers?: Record<string, string>;
  modelSource: ProviderModelSource;
  staticModels?: Array<{ id: string; name: string }>;
  supported: boolean;
  addable?: boolean;
  hidden?: boolean;
  unsupportedReason?: string;
}

/** clodex ships exactly two provider templates: OpenAI (API key) and OpenAI OAuth (ChatGPT plan). */
export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    authType: 'api',
    npm: '@ai-sdk/openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    signupUrl: 'https://platform.openai.com/api-keys',
    modelSource: 'api-list',
    supported: true,
  },
  {
    id: 'openai-oauth',
    name: 'OpenAI (ChatGPT)',
    authType: 'oauth',
    npm: '@ai-sdk/openai',
    signupUrl: 'https://chatgpt.com',
    modelSource: 'api-list',
    supported: true,
  },
];

export function listSupportedTemplates(): ProviderTemplate[] {
  return PROVIDER_TEMPLATES
    .filter(t => t.supported && t.authType === 'api' && t.addable !== false && !t.hidden)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Supported templates not yet present in the user's registry. */
export function listAddableTemplates(configuredIds: Iterable<string> = []): ProviderTemplate[] {
  const configured = new Set(configuredIds);
  return listSupportedTemplates().filter(t => !configured.has(t.id));
}

export function listVisibleOAuthTemplates(configuredIds: Iterable<string> = []): ProviderTemplate[] {
  const configured = new Set(configuredIds);
  return PROVIDER_TEMPLATES
    .filter(t => t.authType === 'oauth' && t.supported && t.addable !== false && !t.hidden && !configured.has(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getTemplateById(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find(t => t.id === id);
}

export function filterTemplates(templates: ProviderTemplate[], query: string): ProviderTemplate[] {
  const q = query.trim().toLowerCase();
  if (!q) return templates;
  return templates.filter(
    t =>
      t.id.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q) ||
      t.npm.toLowerCase().includes(q),
  );
}
