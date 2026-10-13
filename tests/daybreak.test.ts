import { describe, expect, it, vi } from 'vitest';
import {
  cyberAccessProgramList,
  readCyberAccessPrograms,
  resolveAliasDaybreak,
  withAccessPrograms,
  type DaybreakTarget,
} from '../src/daybreak.js';
import { describeModelAliasRejection, normalizeModelAliases } from '../src/model-aliases.js';

const oauthTarget = (cyberAccessPrograms?: DaybreakTarget['cyberAccessPrograms']): DaybreakTarget => ({
  modelId: 'gpt-6-luna',
  npm: '@ai-sdk/openai',
  authType: 'oauth',
  ...(cyberAccessPrograms ? { cyberAccessPrograms } : {}),
});

describe('reading the catalog', () => {
  it('keeps known programs and tells "said nothing" apart from "offers none"', () => {
    expect(readCyberAccessPrograms({ cyber: ['standard', 'daybreak_blue'] })).toEqual(['standard', 'daybreak_blue']);
    expect(readCyberAccessPrograms({ cyber: [] })).toEqual([]);
    expect(readCyberAccessPrograms(undefined)).toBeUndefined();
    expect(readCyberAccessPrograms({})).toBeUndefined();
    expect(readCyberAccessPrograms({ cyber: 'daybreak_blue' })).toBeUndefined();
    expect(readCyberAccessPrograms(['daybreak_blue'])).toBeUndefined();
  });

  it('drops programs it does not know instead of failing the row', () => {
    expect(readCyberAccessPrograms({ cyber: ['daybreak_green', 'daybreak_blue', 7, 'daybreak_blue'] }))
      .toEqual(['daybreak_blue']);
    expect(cyberAccessProgramList(['standard', 'bogus'])).toEqual(['standard']);
    expect(cyberAccessProgramList('standard')).toBeUndefined();
  });
});

describe('resolving an alias', () => {
  it('sends nothing for an alias that did not opt in', () => {
    expect(resolveAliasDaybreak({}, oauthTarget(['standard', 'daybreak_blue']))).toEqual({ kind: 'off' });
  });

  it('picks the program the catalog offers, Blue before Red', () => {
    expect(resolveAliasDaybreak({ daybreak: true }, oauthTarget(['standard', 'daybreak_blue'])))
      .toEqual({ kind: 'on', accessPrograms: { cyber: 'daybreak_blue' } });
    expect(resolveAliasDaybreak({ daybreak: true }, oauthTarget(['daybreak_red', 'daybreak_blue'])))
      .toEqual({ kind: 'on', accessPrograms: { cyber: 'daybreak_blue' } });
    expect(resolveAliasDaybreak({ daybreak: true }, oauthTarget(['standard', 'daybreak_red'])))
      .toEqual({ kind: 'on', accessPrograms: { cyber: 'daybreak_red' } });
  });

  it('refuses rather than silently sending nothing', () => {
    expect(resolveAliasDaybreak({ daybreak: true }, oauthTarget(['standard'])))
      .toEqual({ kind: 'unavailable', reason: "Daybreak isn't available for gpt-6-luna on this ChatGPT account" });
    expect(resolveAliasDaybreak({ daybreak: true }, oauthTarget()))
      .toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('clodex providers refresh-models') });
  });

  it.each([
    ['an API-key OpenAI route', { npm: '@ai-sdk/openai', authType: 'api' }],
    ['another provider', { npm: '@ai-sdk/openai-compatible', authType: 'oauth' }],
  ])('refuses %s even when it claims Daybreak programs', (_label, route) => {
    expect(resolveAliasDaybreak({ daybreak: true }, {
      modelId: 'gpt-6-luna',
      ...route,
      cyberAccessPrograms: ['daybreak_blue'],
    })).toEqual({ kind: 'unavailable', reason: 'Daybreak needs a ChatGPT/Codex sign-in (openai-oauth)' });
  });
});

describe('the request body', () => {
  it('returns the inner fetch untouched when nothing is selected', () => {
    const inner = vi.fn() as unknown as typeof fetch;
    expect(withAccessPrograms(inner, undefined)).toBe(inner);
  });

  it('adds the program to JSON bodies and passes other bodies through', async () => {
    const inner = vi.fn(async () => new Response('{}'));
    const wrapped = withAccessPrograms(inner as unknown as typeof fetch, { cyber: 'daybreak_blue' });
    await wrapped('https://x/responses', { method: 'POST', body: JSON.stringify({ model: 'm' }) });
    await wrapped('https://x/responses', { method: 'POST', body: 'not json' });
    const calls = inner.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ model: 'm', access_programs: { cyber: 'daybreak_blue' } });
    expect(calls[1]![1].body).toBe('not json');
  });
});

describe('saved aliases', () => {
  const target = { providerId: 'openai-oauth', modelId: 'gpt-6-luna' };

  it('keeps daybreak: true and drops daybreak: false', () => {
    const { aliases } = normalizeModelAliases([
      { name: 'blue', ...target, daybreak: true },
      { name: 'plain', ...target, daybreak: false },
    ]);
    expect(aliases).toEqual([
      { name: 'blue', ...target, daybreak: true },
      { name: 'plain', ...target },
    ]);
  });

  it('rejects a daybreak value that is not a boolean, so a typo is reported', () => {
    const { aliases, rejections } = normalizeModelAliases([{ name: 'blue', ...target, daybreak: 'yes' }]);
    expect(aliases).toEqual([]);
    expect(rejections.map(rejection => describeModelAliasRejection(rejection.reason)))
      .toEqual(['"daybreak" must be true or false']);
  });

  it('rejects duplicate spellings that disagree about Daybreak instead of letting order decide', () => {
    const { aliases, rejections } = normalizeModelAliases([
      { name: 'Blue', ...target, daybreak: true },
      { name: 'BLUE', ...target },
    ]);
    expect(aliases).toEqual([]);
    expect(rejections.map(rejection => rejection.reason)).toEqual(['conflicting-targets', 'conflicting-targets']);
  });
});
