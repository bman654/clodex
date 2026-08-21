import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  reportPricingBoundaryCrossing,
  resetPricingBoundaryWarnings,
} from '../src/pricing-boundary.js';
import { installParentNoticeSink } from '../src/parent-notice.js';

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
      modelKey: 'clodex:openai-oauth:gpt-5.6-sol',
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
      { modelKey: 'a:sol', modelLabel: 'Sol', pricingBoundary: BOUNDARY, inputTokens: 300_000 },
      emit,
    );
    reportPricingBoundaryCrossing(
      { modelKey: 'a:terra', modelLabel: 'Terra', pricingBoundary: BOUNDARY, inputTokens: 300_000 },
      emit,
    );
    expect(messages).toHaveLength(2);
  });

  // A long-lived `clodex server` bridges several providers in one process, and two
  // of them can advertise the same display name. Latching on the label would let
  // one route's crossing silence another's.
  it('separates two providers that share a display name', () => {
    const { messages, emit } = collect();
    const shared = { modelLabel: 'GPT-5.6 Sol', pricingBoundary: BOUNDARY, inputTokens: 300_000 };
    reportPricingBoundaryCrossing({ ...shared, modelKey: 'openai-oauth:sol' }, emit);
    reportPricingBoundaryCrossing({ ...shared, modelKey: 'openai:sol' }, emit);
    expect(messages).toHaveLength(2);
  });

  it('stays silent at or below the boundary', () => {
    const { messages, emit } = collect();
    reportPricingBoundaryCrossing(
      { modelKey: 'a:sol', modelLabel: 'Sol', pricingBoundary: BOUNDARY, inputTokens: BOUNDARY },
      emit,
    );
    expect(messages).toEqual([]);
  });

  // An unreported token count is not evidence that the request stayed under the
  // line, so it must not be treated as one in either direction.
  it.each([
    ['no boundary', { modelKey: 'k', modelLabel: 'X', inputTokens: 900_000 }],
    ['no usage', { modelKey: 'k', modelLabel: 'X', pricingBoundary: BOUNDARY }],
    ['non-finite usage', { modelKey: 'k', modelLabel: 'X', pricingBoundary: BOUNDARY, inputTokens: Number.NaN }],
    ['zero boundary', { modelKey: 'k', modelLabel: 'X', pricingBoundary: 0, inputTokens: 900_000 }],
  ])('reports nothing with %s', (_name, observation) => {
    const { messages, emit } = collect();
    expect(reportPricingBoundaryCrossing(observation, emit)).toBe(false);
    expect(messages).toEqual([]);
  });

  // `clodex claude` replaces process.stderr.write for the child's lifetime while the
  // in-process gateway keeps handling requests, so a console.error default would be
  // written into the mute and never seen. The notice channel is the way out.
  it('routes the default channel through the parent notice sink', () => {
    const lines: string[] = [];
    const release = installParentNoticeSink(line => lines.push(line));
    try {
      expect(reportPricingBoundaryCrossing({
        modelKey: 'clodex:openai-oauth:gpt-5.6-sol',
        modelLabel: 'GPT-5.6 Sol',
        pricingBoundary: BOUNDARY,
        inputTokens: 300_000,
      })).toBe(true);
    } finally {
      release();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('300,000');
  });

  // The single warning must not be spent on a channel that dropped it.
  it('keeps the latch unspent when the emit throws', () => {
    const observation = {
      modelKey: 'clodex:openai-oauth:gpt-5.6-sol',
      modelLabel: 'GPT-5.6 Sol',
      pricingBoundary: BOUNDARY,
      inputTokens: 300_000,
    };
    const failing = vi.fn(() => { throw new Error('stderr is gone'); });
    expect(() => reportPricingBoundaryCrossing(observation, failing)).toThrow();

    const { messages, emit } = collect();
    expect(reportPricingBoundaryCrossing(observation, emit)).toBe(true);
    expect(messages).toHaveLength(1);
  });
});
