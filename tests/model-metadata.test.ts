import { describe, it, expect } from 'vitest';
import type { ModelMetadata } from '../src/model-metadata.js';
import { formatModelMetadata } from '../src/model-metadata.js';

const SOL: ModelMetadata = {
  id: 'clodex:openai-oauth:gpt-5.6-sol',
  providerId: 'openai-oauth',
  modelId: 'gpt-5.6-sol',
  alias: 'sol',
  displayName: 'GPT-5.6 Sol',
  context: {
    stop: 'standard',
    raw: 272_000,
    effective: 258_400,
    effectivePercent: 95,
    max: 872_000,
  },
  maxOutputTokens: 128_000,
  pricingBoundary: 272_000,
  effort: {
    levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    default: 'medium',
    providerLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
};

describe('formatModelMetadata', () => {
  // A wrapper captures this on stdout and hands it straight to another process.
  it('emits a single-line JSON array', () => {
    const text = formatModelMetadata([SOL]);
    expect(text.includes('\n')).toBe(false);
    expect(JSON.parse(text)).toEqual([SOL]);
  });

  it('emits an empty array when nothing is configured', () => {
    expect(formatModelMetadata([])).toBe('[]');
  });
});

describe('reported effort ladders', () => {
  /*
   * Consumers read `effort.levels`, never `providerLevels`. Providers advertise
   * values a client may reject outright, so the safe ladder and the raw one are
   * reported separately rather than leaving each consumer to know the difference.
   */
  it('keeps the provider-only level out of the usable ladder', () => {
    expect(SOL.effort?.providerLevels).toContain('none');
    expect(SOL.effort?.levels).not.toContain('none');
  });

  it('reports a default that is present in the usable ladder', () => {
    expect(SOL.effort?.levels).toContain(SOL.effort?.default);
  });
});

describe('reported context metadata', () => {
  it('explains the effective window rather than just stating it', () => {
    const { raw, effective, effectivePercent } = SOL.context;
    expect(Math.floor((raw! * effectivePercent!) / 100)).toBe(effective);
  });

  it('keeps the standard stop under the pricing boundary', () => {
    expect(SOL.context.effective!).toBeLessThanOrEqual(SOL.pricingBoundary!);
  });

  it('reports a ceiling a larger stop can reach', () => {
    expect(SOL.context.max!).toBeGreaterThan(SOL.context.raw!);
  });
});
