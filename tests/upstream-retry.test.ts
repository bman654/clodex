import { describe, expect, it, vi } from 'vitest';
import {
  MAX_UPSTREAM_MAX_RETRIES,
  UPSTREAM_MAX_RETRIES_ENV,
  upstreamMaxRetries,
} from '../src/upstream-retry.js';

describe('upstreamMaxRetries', () => {
  it('leaves the SDK default in control when the setting is absent', () => {
    expect(upstreamMaxRetries({})).toBeUndefined();
  });

  it.each([
    ['zero', '0', 0],
    ['higher budget', '4', 4],
    ['ceiling', '5', 5],
  ])('accepts %s', (_name, raw, expected) => {
    expect(upstreamMaxRetries({ [UPSTREAM_MAX_RETRIES_ENV]: raw })).toBe(expected);
  });

  it.each(['lots', '1.5', '-1'])('ignores and reports invalid value %s', raw => {
    const log = vi.fn();

    expect(upstreamMaxRetries({ [UPSTREAM_MAX_RETRIES_ENV]: raw }, log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      `ignoring ${UPSTREAM_MAX_RETRIES_ENV}=${raw} (expected a non-negative integer)`,
    );
  });

  it('leaves the SDK default in control for whitespace-only input', () => {
    const log = vi.fn();

    expect(upstreamMaxRetries({ [UPSTREAM_MAX_RETRIES_ENV]: '   ' }, log)).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it('clamps values above the streaming-safe ceiling', () => {
    const log = vi.fn();

    expect(upstreamMaxRetries({ [UPSTREAM_MAX_RETRIES_ENV]: '8' }, log))
      .toBe(MAX_UPSTREAM_MAX_RETRIES);
    expect(log).toHaveBeenCalledWith(
      `clamping ${UPSTREAM_MAX_RETRIES_ENV}=8 to ${MAX_UPSTREAM_MAX_RETRIES} `
      + '(higher values exceed the 120s streaming idle budget)',
    );
  });

  it('reports each invalid configured value only once per process', () => {
    const log = vi.fn();
    const env = { [UPSTREAM_MAX_RETRIES_ENV]: '99' };

    expect(upstreamMaxRetries(env, log)).toBe(MAX_UPSTREAM_MAX_RETRIES);
    expect(upstreamMaxRetries(env, log)).toBe(MAX_UPSTREAM_MAX_RETRIES);

    expect(log).toHaveBeenCalledOnce();
  });

  it('warns on stderr when no request logger is available', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(upstreamMaxRetries({ [UPSTREAM_MAX_RETRIES_ENV]: '6' }))
        .toBe(MAX_UPSTREAM_MAX_RETRIES);
      expect(stderr).toHaveBeenCalledWith(
        `clodex: clamping ${UPSTREAM_MAX_RETRIES_ENV}=6 to ${MAX_UPSTREAM_MAX_RETRIES} `
        + '(higher values exceed the 120s streaming idle budget)',
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
