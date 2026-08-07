import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  filterTemplates,
  getTemplateById,
  listAddableTemplates,
  listSupportedTemplates,
  listVisibleOAuthTemplates,
} from '../src/provider-templates.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';

describe('provider templates', () => {
  it('offers OpenAI and OpenCode Go API-key templates as addable', () => {
    expect(listSupportedTemplates().map(t => t.id)).toEqual(['openai', 'opencode-go']);
  });

  it('filters templates by search query', () => {
    const templates = listSupportedTemplates();
    expect(filterTemplates(templates, 'open').map(t => t.id)).toEqual(['openai', 'opencode-go']);
    expect(filterTemplates(templates, 'groq')).toEqual([]);
  });

  it('looks up template by id', () => {
    expect(getTemplateById('openai')?.npm).toBe('@ai-sdk/openai');
    expect(getTemplateById('openai-oauth')?.authType).toBe('oauth');
    expect(getTemplateById('opencode-go')?.staticModelPolicy).toBe('allowlist');
    expect(getTemplateById('groq')).toBeUndefined();
  });

  it('lists only the OpenAI OAuth template for discovery surfaces', () => {
    expect(listVisibleOAuthTemplates().map(t => t.id)).toEqual(['openai-oauth']);
    expect(listVisibleOAuthTemplates(['openai-oauth']).map(t => t.id)).not.toContain('openai-oauth');
  });

  it('excludes already-configured providers from addable list', () => {
    expect(listAddableTemplates(['openai']).map(t => t.id)).toEqual(['opencode-go']);
    expect(listAddableTemplates(['openai', 'opencode-go']).map(t => t.id)).toEqual([]);
    expect(listAddableTemplates([]).map(t => t.id)).toEqual(['openai', 'opencode-go']);
  });
});

describe('fetchTemplateModels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses OpenAI-style model list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
      }),
    }));

    const template = getTemplateById('openai')!;
    const result = await fetchTemplateModels(template, 'test-key');
    expect(result.error).toBeUndefined();
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.id).toBe('gpt-5.6-sol');
    expect(result.models[0]?.modelFormat).toBe('openai');
  });

  it('returns helpful error on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid key',
    }));

    const template = getTemplateById('openai')!;
    const result = await fetchTemplateModels(template, 'bad-key');
    expect(result.models).toHaveLength(0);
    expect(result.error).toContain('rejected');
  });
});
