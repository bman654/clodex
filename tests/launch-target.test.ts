import { describe, it, expect } from 'vitest';
import {
  findProviderAndModel,
  hasCompleteExplicitLaunch,
  isClaudeMachineReadableOutput,
  isClaudePrintMode,
  normalizeClaudeAgentArgs,
  parseModelSlug,
  planLaunchWizard,
  resolveLaunchTarget,
  wantsCleanAgentStdout,
} from '../src/launch-target.js';
import type { LocalProvider } from '../src/types.js';

const providers: LocalProvider[] = [
  {
    id: 'zen',
    name: 'OpenCode Zen',
    apiKey: 'key',
    models: [{ id: 'deepseek-v4-flash-free', name: 'DeepSeek', family: 'deepseek', brand: 'DeepSeek', modelFormat: 'openai', upstreamModelId: 'deepseek-v4-flash-free' }],
  },
  {
    id: 'groq',
    name: 'Groq',
    apiKey: 'key',
    models: [{ id: 'llama-3.3-70b', name: 'Llama', family: 'llama', brand: 'Meta', modelFormat: 'openai', upstreamModelId: 'llama-3.3-70b' }],
  },
];

describe('launch-target', () => {
  it('parses provider__model slug', () => {
    expect(parseModelSlug('zen__deepseek-v4-flash-free')).toEqual({
      providerId: 'zen',
      modelId: 'deepseek-v4-flash-free',
    });
    expect(parseModelSlug('llama-3.3-70b')).toEqual({ modelId: 'llama-3.3-70b' });
  });

  it('detects claude print mode', () => {
    expect(isClaudePrintMode(['-p', 'hello'])).toBe(true);
    expect(isClaudePrintMode(['--print', 'hello'])).toBe(true);
    expect(isClaudePrintMode(['-c'])).toBe(false);
  });

  it('resolves explicit slug-only model', () => {
    expect(hasCompleteExplicitLaunch({ modelId: 'zen__deepseek-v4-flash-free' })).toBe(true);
    const target = resolveLaunchTarget(
      { modelId: 'zen__deepseek-v4-flash-free' },
      {},
    );
    expect(target).toEqual({ providerId: 'zen', modelId: 'deepseek-v4-flash-free' });
  });

  it('finds provider and model in catalog', () => {
    const found = findProviderAndModel(providers, { providerId: 'groq', modelId: 'llama-3.3-70b' });
    expect(found?.provider.id).toBe('groq');
    expect(found?.model.id).toBe('llama-3.3-70b');
  });

  it('skips wizard when explicit provider and model are set', () => {
    const plan = planLaunchWizard({
      explicit: { providerId: 'zen', modelId: 'deepseek-v4-flash-free' },
      childArgs: [],
      agent: 'claude',
      prefs: {},
    });
    expect(plan.skip).toBe(true);
    expect(plan.target).toEqual({ providerId: 'zen', modelId: 'deepseek-v4-flash-free' });
  });

  it('skips wizard in print mode using saved prefs', () => {
    const plan = planLaunchWizard({
      explicit: {},
      childArgs: ['-p', 'review file'],
      agent: 'claude',
      prefs: { lastProvider: 'groq', lastModel: 'llama-3.3-70b' },
    });
    expect(plan.skip).toBe(true);
    expect(plan.target).toEqual({ providerId: 'groq', modelId: 'llama-3.3-70b' });
  });

  it('errors in print mode without prefs or explicit launch', () => {
    const plan = planLaunchWizard({
      explicit: {},
      childArgs: ['--print', 'hello'],
      agent: 'claude',
      prefs: {},
    });
    expect(plan.skip).toBe(false);
    expect(plan.error).toContain('Print mode requires');
  });

  it('detects machine-readable claude output', () => {
    expect(isClaudeMachineReadableOutput(['-p', 'hi', '--output-format', 'stream-json'])).toBe(true);
    expect(isClaudeMachineReadableOutput(['-p', 'hi', '--output-format', 'text'])).toBe(false);
    expect(isClaudeMachineReadableOutput(['-p', 'hi', '--output-format=json'])).toBe(true);
    expect(wantsCleanAgentStdout('claude', ['-p', 'x', '--output-format', 'stream-json'])).toBe(true);
  });

  it('adds --verbose for claude stream-json print mode', () => {
    expect(normalizeClaudeAgentArgs(['-p', 'hi', '--output-format', 'stream-json'])).toContain('--verbose');
    expect(normalizeClaudeAgentArgs(['-p', 'hi', '--output-format', 'json'])).not.toContain('--verbose');
  });
});
