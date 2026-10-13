import { describe, expect, it, vi } from 'vitest';
import {
  applyAccessPrograms,
  normalizeAccessPrograms,
  withAccessPrograms,
} from '../src/access-programs.js';
import { normalizeModelAliases } from '../src/model-aliases.js';

describe('access programs', () => {
  it('accepts only known cyber programs', () => {
    expect(normalizeAccessPrograms({ cyber: 'daybreak_blue' })).toEqual({ cyber: 'daybreak_blue' });
    expect(normalizeAccessPrograms({ cyber: 'standard' })).toEqual({ cyber: 'standard' });
    expect(normalizeAccessPrograms({ cyber: 'Daybreak_Blue' })).toBeUndefined();
    expect(normalizeAccessPrograms({ cyber: null })).toBeUndefined();
    expect(normalizeAccessPrograms({})).toBeUndefined();
    expect(normalizeAccessPrograms(['daybreak_blue'])).toBeUndefined();
    expect(normalizeAccessPrograms(undefined)).toBeUndefined();
  });

  it('merges into the payload and never emits null', () => {
    expect(applyAccessPrograms({ model: 'm' }, { cyber: 'daybreak_red' }))
      .toEqual({ model: 'm', access_programs: { cyber: 'daybreak_red' } });
    expect(applyAccessPrograms({ model: 'm', access_programs: { other: 'x' } }, { cyber: 'standard' }))
      .toEqual({ model: 'm', access_programs: { other: 'x', cyber: 'standard' } });
    expect(applyAccessPrograms({ model: 'm' }, undefined)).toEqual({ model: 'm' });
    expect(applyAccessPrograms({ model: 'm' }, {})).toEqual({ model: 'm' });
  });

  it('returns the inner fetch untouched when nothing is configured', () => {
    const inner = vi.fn() as unknown as typeof fetch;
    expect(withAccessPrograms(inner, undefined)).toBe(inner);
    expect(withAccessPrograms(inner, {})).toBe(inner);
  });

  it('rewrites JSON bodies and passes other bodies through', async () => {
    const inner = vi.fn(async () => new Response('{}'));
    const wrapped = withAccessPrograms(inner as unknown as typeof fetch, { cyber: 'daybreak_blue' });
    await wrapped('https://x/responses', { method: 'POST', body: JSON.stringify({ model: 'm' }) });
    await wrapped('https://x/responses', { method: 'POST', body: 'not json' });
    const calls = inner.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(calls[0]![1].body as string))
      .toEqual({ model: 'm', access_programs: { cyber: 'daybreak_blue' } });
    expect(calls[1]![1].body).toBe('not json');
  });
});

describe('modelAliases[].accessPrograms', () => {
  it('keeps a valid setting on the normalized alias and drops an invalid one', () => {
    const { aliases } = normalizeModelAliases([
      { name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol', accessPrograms: { cyber: 'daybreak_blue' } },
      { name: 'bad', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol', accessPrograms: { cyber: 'nope' } },
      { name: 'plain', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' },
    ]);
    expect(aliases.find(a => a.name === 'sol')?.accessPrograms).toEqual({ cyber: 'daybreak_blue' });
    expect(aliases.find(a => a.name === 'bad')).not.toHaveProperty('accessPrograms');
    expect(aliases.find(a => a.name === 'plain')).not.toHaveProperty('accessPrograms');
  });
});
