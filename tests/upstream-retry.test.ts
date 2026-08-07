import { describe, expect, it, vi } from 'vitest';
import {
  UPSTREAM_MAX_RETRIES_ENV,
  upstreamMaxRetries,
} from '../src/upstream-retry.js';

describe('upstreamMaxRetries', () => {
  it('leaves the SDK default in control when the setting is absent', () => {
    expect(upstreamMaxRetries({})).toBeUndefined();
  });

  it.each([
    ['zero', '0', 0],
    ['higher budget', '7', 7],
    ['ceiling', '8', 8],
  ])('accepts %s', (_name, raw, expected) => {
    expect(upstreamMaxRetries({ [UPSTREAM_MAX_RETRIES_ENV]: raw })).toBe(expected);
  });

  it.each(['lots', '1.5', '-1', '9'])('ignores and reports invalid value %s', raw => {
    const log = vi.fn();

    expect(upstreamMaxRetries({ [UPSTREAM_MAX_RETRIES_ENV]: raw }, log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      `ignoring ${UPSTREAM_MAX_RETRIES_ENV}=${raw} (expected an integer between 0 and 8)`,
    );
  });

  it('reports each invalid configured value only once per process', () => {
    const log = vi.fn();
    const env = { [UPSTREAM_MAX_RETRIES_ENV]: '99' };

    upstreamMaxRetries(env, log);
    upstreamMaxRetries(env, log);

    expect(log).toHaveBeenCalledOnce();
  });
});
