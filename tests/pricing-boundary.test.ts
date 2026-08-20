import { describe, it, expect, beforeEach } from 'vitest';
import {
  reportPricingBoundaryCrossing,
  resetPricingBoundaryWarnings,
} from '../src/pricing-boundary.js';

const BOUNDARY = 272_000;

function collect() {
  const messages: string[] = [];
  return { messages, emit: (message: string) => messages.push(message) };
}

beforeEach(() => resetPricingBoundaryWarnings());

describe('reportPricingBoundaryCrossing', () => {
  it('warns once per model and stays quiet afterwards', () => {
    const { messages, emit } = collect();
    const observation = {
      modelLabel: 'GPT-5.6 Sol',
      pricingBoundary: BOUNDARY,
      inputTokens: 284_102,
    };
    expect(reportPricingBoundaryCrossing(observation, emit)).toBe(true);
    expect(reportPricingBoundaryCrossing(observation, emit)).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('284,102');
    expect(messages[0]).toContain('272,000');
  });

  it('tracks models independently', () => {
    const { messages, emit } = collect();
    reportPricingBoundaryCrossing(
      { modelLabel: 'Sol', pricingBoundary: BOUNDARY, inputTokens: 300_000 },
      emit,
    );
    reportPricingBoundaryCrossing(
      { modelLabel: 'Terra', pricingBoundary: BOUNDARY, inputTokens: 300_000 },
      emit,
    );
    expect(messages).toHaveLength(2);
  });

  it('stays silent at or below the boundary', () => {
    const { messages, emit } = collect();
    reportPricingBoundaryCrossing(
      { modelLabel: 'Sol', pricingBoundary: BOUNDARY, inputTokens: BOUNDARY },
      emit,
    );
    expect(messages).toEqual([]);
  });

  // An unreported token count is not evidence that the request stayed under the
  // line, so it must not be treated as one in either direction.
  it.each([
    ['no boundary', { modelLabel: 'X', inputTokens: 900_000 }],
    ['no usage', { modelLabel: 'X', pricingBoundary: BOUNDARY }],
    ['non-finite usage', { modelLabel: 'X', pricingBoundary: BOUNDARY, inputTokens: Number.NaN }],
    ['zero boundary', { modelLabel: 'X', pricingBoundary: 0, inputTokens: 900_000 }],
  ])('reports nothing with %s', (_name, observation) => {
    const { messages, emit } = collect();
    expect(reportPricingBoundaryCrossing(observation, emit)).toBe(false);
    expect(messages).toEqual([]);
  });
});
