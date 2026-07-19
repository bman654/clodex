import type { LocalProvider } from './types.js';

const OAUTH_FAVORITE_NAMES: Record<string, string> = {
  'openai-oauth': 'OpenAI OAuth (ChatGPT)',
};

export function favoriteProviderDisplayName(
  provider: Pick<LocalProvider, 'id' | 'name' | 'authType'>,
): string {
  const explicit = OAUTH_FAVORITE_NAMES[provider.id];
  if (explicit) return explicit;
  if (provider.authType === 'oauth' && !/\boauth\b/i.test(provider.name)) {
    return `${provider.name} OAuth`;
  }
  return provider.name;
}
