import { describe, it, expect } from 'vitest';
import {
  parseContextStopAssignment,
  parseContextStopAssignments,
  savedStopsAfter,
  sessionStopsFrom,
} from '../src/context-stop-args.js';

const ALIASES = [{ name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }];

describe('parseContextStopAssignment', () => {
  it.each([
    ['sol=max', 'openai-oauth', 'gpt-5.6-sol'],
    ['clodex:openai-oauth:gpt-5.6-sol=max', 'openai-oauth', 'gpt-5.6-sol'],
    ['openai-oauth:gpt-5.6-sol=max', 'openai-oauth', 'gpt-5.6-sol'],
  ])('resolves %s', (input, providerId, modelId) => {
    expect(parseContextStopAssignment(input, ALIASES)).toMatchObject({
      providerId,
      modelId,
      stop: 'max',
    });
  });

  it('accepts a token count and a shorthand', () => {
    expect(parseContextStopAssignment('sol=500k', ALIASES)).toMatchObject({ stop: 500_000 });
    expect(parseContextStopAssignment('sol=272000', ALIASES)).toMatchObject({ stop: 272_000 });
  });

  it('reads the reset spellings as a cleared stop', () => {
    expect(parseContextStopAssignment('sol=default', ALIASES)).toMatchObject({ stop: null });
  });

  it('keeps the user wording for messages', () => {
    expect(parseContextStopAssignment('sol=max', ALIASES)).toMatchObject({ label: 'sol' });
  });

  it.each([
    ['no separator', 'sol'],
    ['no stop', 'sol='],
    ['no model', '=max'],
    ['unknown alias', 'nope=max'],
    ['bad stop', 'sol=enormous'],
  ])('rejects %s', (_name, input) => {
    expect(parseContextStopAssignment(input, ALIASES)).toHaveProperty('error');
  });
});

describe('parseContextStopAssignments', () => {
  it('fails on the first bad entry rather than dropping it', () => {
    const result = parseContextStopAssignments(['sol=max', 'nope=max'], ALIASES);
    expect(result).toHaveProperty('error');
  });

  it('collects every good entry', () => {
    const result = parseContextStopAssignments(
      ['sol=max', 'openai-oauth:gpt-5.6-terra=standard'],
      ALIASES,
    );
    expect(result).toHaveProperty('assignments');
    expect('assignments' in result && result.assignments).toHaveLength(2);
  });
});

describe('session and saved maps', () => {
  const assignments = [
    { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol', label: 'sol', stop: 'max' as const },
    { providerId: 'openai-oauth', modelId: 'gpt-5.6-terra', label: 'terra', stop: null },
  ];

  it('treats a cleared stop as standard for the session', () => {
    expect(sessionStopsFrom(assignments)).toEqual({
      'openai-oauth:gpt-5.6-sol': 'max',
      'openai-oauth:gpt-5.6-terra': 'standard',
    });
  });

  it('removes a cleared stop from the saved map and keeps the rest', () => {
    expect(savedStopsAfter(
      { 'openai-oauth:gpt-5.6-terra': 'max', 'openai:other': 500_000 },
      assignments,
    )).toEqual({
      'openai-oauth:gpt-5.6-sol': 'max',
      'openai:other': 500_000,
    });
  });
});
