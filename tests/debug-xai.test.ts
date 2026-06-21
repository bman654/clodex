import { describe, it } from 'vitest';
import { resolveProviderCredential } from '../src/env';

describe('xAI endpoint probes', () => {
  it('should test api.x.ai/v1/models with xAI API Key', async () => {
    const apiKey = await resolveProviderCredential('xai', 'keyring:provider:xai');
    if (!apiKey) {
      console.log('No xai API key found in keyring, skipping test.');
      return;
    }

    // Try to determine if it's a JWT vs xai- prefix
    if (!apiKey.startsWith('xai-')) {
        console.log('Key is not an API key (might be OAuth token). Skipping API key test.');
        return;
    }

    const res = await fetch('https://api.x.ai/v1/models', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });

    console.log('xAI API Key /v1/models status:', res.status, res.statusText);
    if (res.ok) {
      const data = await res.json();
      console.log('Models returned:', JSON.stringify(data, null, 2).slice(0, 500) + '...');
    } else {
      console.log('Error body:', await res.text());
    }
  });

  it('should test api.x.ai/v1/models with xAI OAuth Token', async () => {
    // We assume xai-oauth is stored in keyring
    const oauthKey = await resolveProviderCredential('xai', 'keyring:oauth:provider:xai') || await resolveProviderCredential('xai', 'keyring:provider:xai');
    if (!oauthKey) {
      console.log('No xai OAuth token found in keyring, skipping test.');
      return;
    }

    // Try to determine if it's a JWT vs xai- prefix
    if (oauthKey.startsWith('xai-')) {
        console.log('Key is an API key, not an OAuth token. Skipping OAuth test.');
        return;
    }

    const res = await fetch('https://api.x.ai/v1/models', {
      headers: {
        Authorization: `Bearer ${oauthKey}`,
        Accept: 'application/json',
      },
    });

    console.log('xAI OAuth Token /v1/models status:', res.status, res.statusText);
    if (res.ok) {
      const data = await res.json();
      const fs = require('fs');
      fs.mkdirSync('.gemini', { recursive: true });
      fs.writeFileSync('.gemini/xai-models.json', JSON.stringify(data, null, 2));
      console.log('Wrote full models response to .gemini/xai-models.json');
    } else {
      console.log('OAuth Error body:', await res.text());
    }
  });
});
