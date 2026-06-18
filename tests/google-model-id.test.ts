import { describe, it, expect } from 'vitest';
import {
  normalizeGoogleDisplayName,
  normalizeGoogleModelId,
  stripGoogleModelPrefix,
} from '../src/registry/google-model-id.js';

describe('google model id normalization', () => {
  it('strips models/ prefix for @ai-sdk/google', () => {
    expect(normalizeGoogleModelId('models/gemini-3.5-flash', '@ai-sdk/google')).toEqual({
      id: 'gemini-3.5-flash',
      upstreamModelId: 'gemini-3.5-flash',
    });
  });

  it('leaves other providers unchanged', () => {
    expect(normalizeGoogleModelId('models/foo', '@ai-sdk/openai')).toEqual({
      id: 'models/foo',
      upstreamModelId: 'models/foo',
    });
  });

  it('cleans display names', () => {
    expect(normalizeGoogleDisplayName('models/gemini-3.5-flash', 'gemini-3.5-flash')).toBe(
      'gemini-3.5-flash',
    );
  });

  it('stripGoogleModelPrefix is idempotent', () => {
    expect(stripGoogleModelPrefix(stripGoogleModelPrefix('models/gemini-3.5-flash'))).toBe(
      'gemini-3.5-flash',
    );
  });
});
