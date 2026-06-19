import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  filterTemplates,
  getTemplateById,
  listAddableTemplates,
  listSupportedTemplates,
} from '../src/provider-templates.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';

describe('provider templates', () => {
  it('includes groq in supported templates', () => {
    const ids = listSupportedTemplates().map(t => t.id);
    expect(ids).toContain('groq');
    expect(ids).toContain('mistral');
  });

  it('sorts supported templates alphabetically by display name', () => {
    const names = listSupportedTemplates().map(t => t.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('filters templates by search query', () => {
    const templates = listSupportedTemplates();
    expect(filterTemplates(templates, 'gro').map(t => t.id)).toEqual(['groq']);
    expect(filterTemplates(templates, 'together').map(t => t.id)).toEqual(['togetherai']);
    expect(filterTemplates(templates, 'opencode').map(t => t.id)).toEqual(['opencode-cloud']);
  });

  it('looks up template by id', () => {
    expect(getTemplateById('groq')?.npm).toBe('@ai-sdk/groq');
  });

  it('excludes already-configured providers from addable list', () => {
    const addable = listAddableTemplates(['groq', 'mistral']);
    expect(addable.map(t => t.id)).not.toContain('groq');
    expect(addable.map(t => t.id)).not.toContain('mistral');
    expect(addable.map(t => t.id)).toContain('togetherai');
  });

  it('offers OpenCode Zen and Go as one setup option', () => {
    expect(listAddableTemplates([]).filter(t => t.modelSource === 'zen-go-api').map(t => t.id))
      .toEqual(['opencode-cloud']);
    expect(listAddableTemplates(['zen']).map(t => t.id)).not.toContain('opencode-cloud');
    expect(listAddableTemplates(['go']).map(t => t.id)).not.toContain('opencode-cloud');
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
      json: async () => ({
        data: [{ id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' }],
      }),
    }));

    const template = getTemplateById('groq')!;
    const result = await fetchTemplateModels(template, 'test-key');
    expect(result.error).toBeUndefined();
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.id).toBe('llama-3.3-70b-versatile');
    expect(result.models[0]?.modelFormat).toBe('openai');
  });

  it('returns helpful error on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid key',
    }));

    const template = getTemplateById('groq')!;
    const result = await fetchTemplateModels(template, 'bad-key');
    expect(result.models).toHaveLength(0);
    expect(result.error).toContain('rejected');
  });
});
