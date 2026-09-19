import { describe, it, expect, beforeEach } from 'vitest';
import {
  contextLimitsFrom,
  contextClampNotice,
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
// The percent is declared EXPLICITLY here because the mechanism still honours one
// when a provider states it — clodex just no longer imposes a share of its own.
const SOL = {
  contextWindow: 272_000,
  maxContextWindow: 872_000,
  effectiveContextPercent: 95,
  pricingBoundary: 272_000,
  pricingBoundaryNote: 'Above it, the full request is priced higher.',
};

beforeEach(() => resetContextStops());

// After clodex stopped imposing a share of its own, the standard stop for this family
// lands EXACTLY on the pricing boundary (272,000 vs 272,000). That makes the boundary
// comparison's strictness load-bearing for the first time: with `>=` instead of `>`,
// every default-stop launch would warn that the window "can grow past" a line it sits
// precisely on, contradicting the documented promise that standard stays under it.
describe('a standard stop that lands exactly on the pricing boundary', () => {
  const AT_BOUNDARY = {
    contextWindow: 272_000,
    maxContextWindow: 872_000,
    pricingBoundary: 272_000,
    pricingBoundaryNote: 'Above it, the full request is priced higher.',
  };

  it('does not report crossing when the window equals the boundary', () => {
    const resolved = resolveContextStop(AT_BOUNDARY, 'standard');
    expect(resolved.effective).toBe(272_000);
    expect(resolved.crossesPricingBoundary).toBe(false);
  });

  it('reports crossing one token above the boundary', () => {
    const resolved = resolveContextStop({ ...AT_BOUNDARY, contextWindow: 272_001 }, 'standard');
    expect(resolved.crossesPricingBoundary).toBe(true);
  });

  it('still reports crossing on the larger stop', () => {
    expect(resolveContextStop(AT_BOUNDARY, 'max').crossesPricingBoundary).toBe(true);
  });

  // The comparison reads `effective`, and with no share imposed `effective === raw` for
  // every model in practice — so swapping one for the other is an equivalent mutant
  // today. Pin the distinction with a declared share, which is the only way the two
  // diverge, so the field being compared stays deliberate rather than incidental.
  it('compares the effective window, not the raw one', () => {
    const withShare = { ...AT_BOUNDARY, contextWindow: 300_000, effectiveContextPercent: 80 };
    const resolved = resolveContextStop(withShare, 'standard');
    expect(resolved.raw).toBe(300_000);
    expect(resolved.effective).toBe(240_000);
    expect(resolved.crossesPricingBoundary).toBe(false);
  });
});

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

// A model whose provider publishes no window, and which no heuristic rule claims,
// used to be stored with clodex's invented 200,000. That number then became the
// ceiling every later `--context` request was clamped to, so an OpenCode Go model
// with a real 1,048,576-token window was permanently capped at 200,000 with no way
// to raise it. Nothing is declared here, which is the shape those models now reach
// the resolver in.
describe('a model whose window nobody published', () => {
  const UNKNOWN = {};

  it('still reports the 200k Claude Code assumes for the standard stop', () => {
    const resolved = resolveContextStop(UNKNOWN, 'standard');
    expect(resolved.raw).toBe(200_000);
    expect(resolved.effective).toBe(200_000);
    expect(resolved.clampedFrom).toBeUndefined();
  });

  it('does not invent a larger window for the max stop', () => {
    expect(resolveContextStop(UNKNOWN, 'max').effective).toBe(200_000);
  });

  it('honours a user stop above the invented default instead of clamping to it', () => {
    const resolved = resolveContextStop(UNKNOWN, 1_048_576);
    expect(resolved.raw).toBe(1_048_576);
    expect(resolved.effective).toBe(1_048_576);
    expect(resolved.clampedFrom).toBeUndefined();
    expect(contextClampNotice('go-model', resolved)).toBeNull();
  });

  it('honours the stop through contextLimitsFrom when no fallback window is known', () => {
    const limits = contextLimitsFrom({ maxContextWindow: undefined }, undefined);
    expect(limits.contextWindow).toBeUndefined();
    expect(resolveContextStop(limits, 1_048_576).raw).toBe(1_048_576);
  });

  it('treats an omitted fallback the same as an explicit undefined one', () => {
    expect(contextLimitsFrom({}).contextWindow).toBeUndefined();
  });
});

// The loosening above must not reach a model that DOES declare limits. These are
// the numbers the live Codex catalog reports for GPT-6 Astra.
describe('a model with a declared ceiling', () => {
  const ASTRA = { contextWindow: 272_000, maxContextWindow: 872_000 };

  it('still clamps a user stop above the ceiling and still reports it', () => {
    const resolved = resolveContextStop(ASTRA, 900_000);
    expect(resolved.raw).toBe(872_000);
    expect(resolved.effective).toBe(872_000);
    expect(resolved.clampedFrom).toBe(900_000);
    expect(contextClampNotice('astra', resolved)).toContain('above the model ceiling');
  });

  it('clamps even when the declared window itself is the only limit', () => {
    // Curated or heuristic data IS a claim about the model, so it stays the ceiling
    // exactly as before. Only a window nobody published stops being one.
    const resolved = resolveContextStop({ contextWindow: 272_000 }, 900_000);
    expect(resolved.raw).toBe(272_000);
    expect(resolved.clampedFrom).toBe(900_000);
  });

  it('clamps a declared-window model reached through contextLimitsFrom', () => {
    const limits = contextLimitsFrom({ contextWindow: 262_144 }, undefined);
    const resolved = resolveContextStop(limits, 1_048_576);
    expect(resolved.raw).toBe(262_144);
    expect(resolved.clampedFrom).toBe(1_048_576);
  });

  it('clamps to a fallback window that a lookup did supply', () => {
    const limits = contextLimitsFrom({}, 131_072);
    expect(resolveContextStop(limits, 1_048_576).raw).toBe(131_072);
  });
});
