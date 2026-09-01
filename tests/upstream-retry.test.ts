import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PASSTHROUGH_RETRIES,
  MAX_UPSTREAM_MAX_RETRIES,
  UPSTREAM_MAX_RETRIES_ENV,
  passthroughUpstreamRetries,
  upstreamMaxRetries,
} from '../src/upstream-retry.js';
import { installParentNoticeSink } from '../src/parent-notice.js';

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
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });

    try {
      expect(upstreamMaxRetries({ [UPSTREAM_MAX_RETRIES_ENV]: '6' }))
        .toBe(MAX_UPSTREAM_MAX_RETRIES);
      expect(stderr.join('')).toBe(
        `clodex: clamping ${UPSTREAM_MAX_RETRIES_ENV}=6 to ${MAX_UPSTREAM_MAX_RETRIES} `
        + '(higher values exceed the 120s streaming idle budget)\n',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('reaches the terminal even while Claude Code owns the parent stdio', () => {
    // The clamp notice fires from a live request, which on `clodex claude` means
    // the parent's stdout/stderr are muted for the child's TUI. console.error
    // resolved that muted write; the notice channel is what gets past it.
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
    const notices: string[] = [];
    const release = installParentNoticeSink(line => notices.push(line));

    try {
      expect(upstreamMaxRetries({ [UPSTREAM_MAX_RETRIES_ENV]: '7' }))
        .toBe(MAX_UPSTREAM_MAX_RETRIES);
      expect(notices.join('')).toContain(`clamping ${UPSTREAM_MAX_RETRIES_ENV}=7`);
      expect(stderr.join('')).toBe('');
    } finally {
      release();
      spy.mockRestore();
    }
  });
});

describe('passthroughUpstreamRetries', () => {
  it('replays a dropped keep-alive socket once when nothing is configured', () => {
    // Unlike the SDK paths there is no library default to defer to, so an
    // absent setting has to resolve to a real number here.
    expect(passthroughUpstreamRetries({})).toBe(DEFAULT_PASSTHROUGH_RETRIES);
    expect(DEFAULT_PASSTHROUGH_RETRIES).toBe(1);
  });

  it('lets the shared setting turn passthrough replays off', () => {
    expect(passthroughUpstreamRetries({ [UPSTREAM_MAX_RETRIES_ENV]: '0' })).toBe(0);
  });

  it('follows the shared setting upward and honours its ceiling', () => {
    expect(passthroughUpstreamRetries({ [UPSTREAM_MAX_RETRIES_ENV]: '3' })).toBe(3);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(passthroughUpstreamRetries({ [UPSTREAM_MAX_RETRIES_ENV]: '99' }))
        .toBe(MAX_UPSTREAM_MAX_RETRIES);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not resend when the client itself was told never to resend', () => {
    // Replaying here is defensible only because Claude Code resends a 502 on
    // its own, so the ambiguous window is one the client already accepts.
    // CLAUDE_CODE_MAX_RETRIES=0 withdraws that; reinstating it a layer down
    // would be a duplicate billed send the operator opted out of.
    expect(passthroughUpstreamRetries({ CLAUDE_CODE_MAX_RETRIES: '0' })).toBe(0);
    expect(passthroughUpstreamRetries({ CLAUDE_CODE_MAX_RETRIES: ' 0 ' })).toBe(0);
  });

  it('keeps replaying when the client retains a retry budget of its own', () => {
    expect(passthroughUpstreamRetries({ CLAUDE_CODE_MAX_RETRIES: '1' }))
      .toBe(DEFAULT_PASSTHROUGH_RETRIES);
    expect(passthroughUpstreamRetries({ CLAUDE_CODE_MAX_RETRIES: '10' }))
      .toBe(DEFAULT_PASSTHROUGH_RETRIES);
    // Unusable values are the client's business, not a reason to change ours.
    expect(passthroughUpstreamRetries({ CLAUDE_CODE_MAX_RETRIES: '' }))
      .toBe(DEFAULT_PASSTHROUGH_RETRIES);
    expect(passthroughUpstreamRetries({ CLAUDE_CODE_MAX_RETRIES: 'none' }))
      .toBe(DEFAULT_PASSTHROUGH_RETRIES);
  });

  it('lets the clodex setting win over the client budget in both directions', () => {
    expect(passthroughUpstreamRetries({
      CLODEX_UPSTREAM_MAX_RETRIES: '2',
      CLAUDE_CODE_MAX_RETRIES: '0',
    })).toBe(2);
    expect(passthroughUpstreamRetries({
      CLODEX_UPSTREAM_MAX_RETRIES: '0',
      CLAUDE_CODE_MAX_RETRIES: '10',
    })).toBe(0);
  });

  it('falls back to the default when the setting is unusable', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(passthroughUpstreamRetries({ [UPSTREAM_MAX_RETRIES_ENV]: 'lots' }))
        .toBe(DEFAULT_PASSTHROUGH_RETRIES);
    } finally {
      spy.mockRestore();
    }
  });
});
