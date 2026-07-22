// import-build.ts — registry auth-ref helpers for OAuth providers

import { credentialAuthRef } from '../credential-helper.js';

export function oauthAuthRef(providerId: string): string {
  return credentialAuthRef(`oauth:provider:${providerId}`);
}

/** Maps a canonical OAuth provider ID to its registry slot (openai → openai-oauth; others unchanged). */
export function toOAuthRegistryId(id: string): string {
  if (id === 'openai') return 'openai-oauth';
  return id;
}
