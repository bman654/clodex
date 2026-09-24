import { describe, expect, it } from 'vitest';
import { compareCodexClientVersions, readCodexClientVersion } from '../src/codex-client-version.js';
import { CODEX_RESPONSES_LITE_VERSION } from '../src/constants.js';
import { buildOpenAiOAuthModels } from '../src/data/openai-oauth-models.js';

describe('Codex client version precedence', () => {
  it.each([
    ['0.9.0', '0.156.0', -1],
    ['0.1000.0', '0.156.0', 1],
    ['0.156.1', '0.156.0', 1],
    ['1.0.0', '0.999.0', 1],
    ['0.156.0', '0.156.0', 0],
    ['0.156.0+build.9', '0.156.0', 0],
    ['0.156.0-rc.2', '0.156.0', -1],
    ['0.156.0', '0.156.0-rc.2', 1],
    ['0.156.0-rc.10', '0.156.0-rc.2', 1],
    ['0.156.0-2', '0.156.0-alpha', -1],
    ['0.156.0-alpha', '0.156.0-beta', -1],
    ['0.156.0-alpha', '0.156.0-alpha.1', -1],
    ['0.156.0-alpha.1', '0.156.0-alpha', 1],
  ])('compares %s to %s semantically', (a, b, expected) => {
    expect(compareCodexClientVersions(a, b)).toBe(expected);
  });

  it.each([null, 156, {}, '', 'latest', '0.156', '0.0156.0', '0.156.0-01', '0.156.0\n']) (
    'treats malformed minimum %j as unknown', value => {
      expect(readCodexClientVersion(value)).toBeUndefined();
    },
  );

  it('does not assign precedence to malformed versions', () => {
    expect(compareCodexClientVersions('bogus', '0.156.0')).toBeUndefined();
    expect(compareCodexClientVersions('0.156.0', 'bogus')).toBeUndefined();
  });
});

describe('offline seeded Codex version contract', () => {
  it('retains the minimums measured in the live catalog on 2026-09-24', () => {
    const models = buildOpenAiOAuthModels();
    const measured = {
      'gpt-6-sol': '0.155.0',
      'gpt-6-luna': '0.155.0',
      'gpt-6-astra': '0.153.0',
      'gpt-daybreak-blue-latest': '0.144.0',
      'gpt-5.6-sol': '0.144.0',
      'gpt-5.6-terra': '0.144.0',
      'gpt-5.6-luna': '0.144.0',
      'gpt-5.5': '0.124.0',
    };
    for (const [id, minimum] of Object.entries(measured)) {
      expect(models.find(model => model.id === id)?.minimalClientVersion, id).toBe(minimum);
    }
  });

  it('pins a request version at least as new as every seeded lite model minimum', () => {
    const lite = buildOpenAiOAuthModels().filter(model => model.useResponsesLite);
    expect(lite.length).toBeGreaterThan(0);
    for (const model of lite) {
      expect(readCodexClientVersion(model.minimalClientVersion), model.id).toBeDefined();
      expect(compareCodexClientVersions(CODEX_RESPONSES_LITE_VERSION, model.minimalClientVersion!),
        `${model.id} requires ${model.minimalClientVersion}`).toBeGreaterThanOrEqual(0);
    }
  });
});
