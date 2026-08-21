import { describe, it, expect, beforeEach } from 'vitest';
import {
  contextLimitsFrom,
  contextClampNotice,
  DEFAULT_EFFECTIVE_CONTEXT_PERCENT,
  effectiveContextWindow,
  parseContextStop,
  pricingBoundaryWarning,
  primeSavedContextStops,
  resetContextStops,
  resolveContextStop,
  selectContextStop,
  setSessionContextStops,
} from '../src/context-modes.js';

// Mirrors what the Codex catalog actually reports for this family: a 272,000
// default and an account-scoped 872,000 ceiling, not the published model spec.
const SOL = {
  contextWindow: 272_000,
  maxContextWindow: 872_000,
  effectiveContextPercent: DEFAULT_EFFECTIVE_CONTEXT_PERCENT,
  pricingBoundary: 272_000,
  pricingBoundaryNote: 'Above it, the full request is priced higher.',
};

beforeEach(() => resetContextStops());

describe('effectiveContextWindow', () => {
  it('applies a declared percent', () => {
    expect(effectiveContextWindow(272_000, 95)).toBe(258_400);
    expect(effectiveContextWindow(1_050_000, 95)).toBe(997_500);
  });

  // Every non-OpenAI provider in the catalog would otherwise silently lose 5% of
  // its reported window the moment this module was introduced.
  it('leaves the window alone when no percent is declared', () => {
    expect(effectiveContextWindow(200_000)).toBe(200_000);
    expect(effectiveContextWindow(1_000_000, undefined)).toBe(1_000_000);
  });

  it('ignores a nonsensical percent rather than shrinking the window', () => {
    expect(effectiveContextWindow(200_000, 0)).toBe(200_000);
    expect(effectiveContextWindow(200_000, 250)).toBe(200_000);
  });
});

describe('resolveContextStop', () => {
  it('keeps the standard stop under the pricing boundary', () => {
    const resolved = resolveContextStop(SOL, 'standard');
    expect(resolved.effective).toBe(258_400);
    expect(resolved.crossesPricingBoundary).toBe(false);
  });

  it('uses the full ceiling for the max stop', () => {
    const resolved = resolveContextStop(SOL, 'max');
    expect(resolved.raw).toBe(872_000);
    expect(resolved.effective).toBe(828_400);
    expect(resolved.crossesPricingBoundary).toBe(true);
  });

  // Claude Code caps a configured window at 1M, and the [1m] model-id suffix
  // hard-codes a different window upstream at exactly that number.
  it('keeps the max stop under one million', () => {
    expect(resolveContextStop(SOL, 'max').effective).toBeLessThan(1_000_000);
  });

  it('clamps a custom stop to the ceiling and reports it', () => {
    const resolved = resolveContextStop(SOL, 5_000_000);
    expect(resolved.raw).toBe(872_000);
    expect(resolved.clampedFrom).toBe(5_000_000);
    expect(contextClampNotice('sol', resolved)).toContain('above the model ceiling');
  });

  // A max stop that cannot raise the window has changed nothing.
  it('does not invent a larger window when no ceiling is known', () => {
    const terra = { ...SOL, maxContextWindow: undefined };
    expect(resolveContextStop(terra, 'max').effective).toBe(258_400);
  });

  it('applies the declared headroom to a custom stop', () => {
    expect(resolveContextStop(SOL, 600_000).effective).toBe(570_000);
  });
});

describe('pricingBoundaryWarning', () => {
  it('warns only for a window that can cross the boundary', () => {
    expect(pricingBoundaryWarning('sol', SOL, resolveContextStop(SOL, 'standard'))).toBeNull();
    const warning = pricingBoundaryWarning('sol', SOL, resolveContextStop(SOL, 'max'));
    expect(warning).toContain('272,000');
    expect(warning).toContain('Above it, the full request is priced higher.');
  });

  it('stays silent for a model with no declared boundary', () => {
    const limits = { contextWindow: 1_000_000 };
    expect(pricingBoundaryWarning('x', limits, resolveContextStop(limits, 'max'))).toBeNull();
  });
});

describe('parseContextStop', () => {
  it.each([
    ['standard', 'standard'],
    ['MAX', 'max'],
    ['500k', 500_000],
    ['272000', 272_000],
  ])('%s -> %s', (input, expected) => {
    expect(parseContextStop(input)).toBe(expected);
  });

  it.each(['default', 'reset', 'unset'])('%s clears the saved stop', input => {
    expect(parseContextStop(input)).toBeNull();
  });

  it.each(['', 'huge', '-5', '0', '1.5'])('rejects %s rather than defaulting', input => {
    expect(parseContextStop(input)).toHaveProperty('error');
  });
});

describe('selectContextStop', () => {
  it('prefers a session override over a saved stop', () => {
    primeSavedContextStops({ 'openai-oauth:gpt-5.6-sol': 'max' });
    expect(selectContextStop('openai-oauth', 'gpt-5.6-sol')).toBe('max');
    setSessionContextStops({ 'openai-oauth:gpt-5.6-sol': 'standard' });
    expect(selectContextStop('openai-oauth', 'gpt-5.6-sol')).toBe('standard');
  });

  it('falls back to standard for an unprimed process', () => {
    expect(selectContextStop('openai-oauth', 'gpt-5.6-sol')).toBe('standard');
  });

  it('ignores malformed saved entries instead of throwing', () => {
    primeSavedContextStops({ 'openai-oauth:gpt-5.6-sol': 'enormous' });
    expect(selectContextStop('openai-oauth', 'gpt-5.6-sol')).toBe('standard');
  });

  it('accepts explicitly supplied preferences without a prime', () => {
    expect(
      selectContextStop('openai-oauth', 'gpt-5.6-sol', { 'openai-oauth:gpt-5.6-sol': 'max' }),
    ).toBe('max');
  });
});

describe('contextLimitsFrom', () => {
  it('falls back to the supplied window when the entry has none', () => {
    expect(contextLimitsFrom({}, 200_000).contextWindow).toBe(200_000);
  });

  it('keeps a declared window', () => {
    expect(contextLimitsFrom({ contextWindow: 272_000 }, 200_000).contextWindow).toBe(272_000);
  });
});
