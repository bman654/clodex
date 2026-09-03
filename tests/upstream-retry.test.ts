import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PASSTHROUGH_RETRIES,
  MAX_UPSTREAM_MAX_RETRIES,
  UPSTREAM_IDLE_TIMEOUT_ENV,
  UPSTREAM_MAX_RETRIES_ENV,
  UPSTREAM_TOTAL_TIMEOUT_ENV,
  passthroughUpstreamRetries,
  upstreamRequestBudget,
} from '../src/upstream-retry.js';
import { installParentNoticeSink } from '../src/parent-notice.js';

function resolvedRetries(env: NodeJS.ProcessEnv, warn?: (message: string) => void): number {
  return upstreamRequestBudget({ env, ...(warn ? { warn } : {}) }).maxRetries;
}

describe('upstream retry budget', () => {
  it('retries transient provider failures five times by default', () => {
    expect(resolvedRetries({})).toBe(5);
  });

  it('lowers the default retry count with a shorter idle timeout', () => {
    expect(upstreamRequestBudget({
      env: {
        CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: '30000',
        CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS: '60000',
      },
    }).maxRetries).toBe(3);
  });

  it.each([
    ['zero', '0', 0],
    ['higher budget', '4', 4],
    ['ceiling', '5', 5],
  ])('accepts %s', (_name, raw, expected) => {
    expect(resolvedRetries({ [UPSTREAM_MAX_RETRIES_ENV]: raw })).toBe(expected);
  });

  it.each(['lots', '1.5', '-1'])('ignores and reports invalid value %s', raw => {
    const log = vi.fn();

    expect(resolvedRetries({ [UPSTREAM_MAX_RETRIES_ENV]: raw }, log)).toBe(5);
    expect(log).toHaveBeenCalledWith(
      `ignoring ${UPSTREAM_MAX_RETRIES_ENV}=${raw} (expected a non-negative integer)`,
    );
  });

  it('uses the clodex default for whitespace-only input', () => {
    const log = vi.fn();

    expect(resolvedRetries({ [UPSTREAM_MAX_RETRIES_ENV]: '   ' }, log)).toBe(5);
    expect(log).not.toHaveBeenCalled();
  });

  it('clamps values above the streaming-safe ceiling', () => {
    const log = vi.fn();

    expect(resolvedRetries({ [UPSTREAM_MAX_RETRIES_ENV]: '8' }, log))
      .toBe(MAX_UPSTREAM_MAX_RETRIES);
    expect(log).toHaveBeenCalledWith(
      `clamping ${UPSTREAM_MAX_RETRIES_ENV}=8 to ${MAX_UPSTREAM_MAX_RETRIES} `
      + '(estimated from the SDK fallback backoff and resolved 120000ms idle timeout; '
      + 'provider delays may allow fewer retries)',
    );
  });

  it('reports each invalid configured value only once per process', () => {
    const log = vi.fn();
    const env = { [UPSTREAM_MAX_RETRIES_ENV]: '99' };

    expect(resolvedRetries(env, log)).toBe(MAX_UPSTREAM_MAX_RETRIES);
    expect(resolvedRetries(env, log)).toBe(MAX_UPSTREAM_MAX_RETRIES);

    expect(log).toHaveBeenCalledOnce();
  });

  it('warns on stderr when no request logger is available', () => {
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });

    try {
      expect(resolvedRetries({ [UPSTREAM_MAX_RETRIES_ENV]: '6' }))
        .toBe(MAX_UPSTREAM_MAX_RETRIES);
      expect(stderr.join('')).toBe(
        `clodex: clamping ${UPSTREAM_MAX_RETRIES_ENV}=6 to ${MAX_UPSTREAM_MAX_RETRIES} `
        + '(estimated from the SDK fallback backoff and resolved 120000ms idle timeout; '
        + 'provider delays may allow fewer retries)\n',
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
      expect(resolvedRetries({ [UPSTREAM_MAX_RETRIES_ENV]: '7' }))
        .toBe(MAX_UPSTREAM_MAX_RETRIES);
      expect(notices.join('')).toContain(`clamping ${UPSTREAM_MAX_RETRIES_ENV}=7`);
      expect(stderr.join('')).toBe('');
    } finally {
      release();
      spy.mockRestore();
    }
  });
});

describe('upstreamRequestBudget', () => {
  it('preserves the existing timeout and retry defaults when settings are absent', () => {
    const warn = vi.fn();

    expect(upstreamRequestBudget({ env: {}, warn })).toEqual({
      idleTimeoutMs: 120_000,
      totalTimeoutMs: 600_000,
      maxRetries: 5,
    });
    expect(MAX_UPSTREAM_MAX_RETRIES).toBe(5);
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats empty timeout settings as absent', () => {
    const warn = vi.fn();

    expect(upstreamRequestBudget({
      env: {
        [UPSTREAM_IDLE_TIMEOUT_ENV]: '   ',
        [UPSTREAM_TOTAL_TIMEOUT_ENV]: '',
      },
      warn,
    })).toMatchObject({
      idleTimeoutMs: 120_000,
      totalTimeoutMs: 600_000,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores malformed timeout settings without failing the request', () => {
    const warn = vi.fn(() => { throw new Error('notice sink unavailable'); });

    expect(upstreamRequestBudget({
      env: {
        [UPSTREAM_IDLE_TIMEOUT_ENV]: 'not-a-duration',
        [UPSTREAM_TOTAL_TIMEOUT_ENV]: '1.5',
      },
      warn,
    })).toEqual({
      idleTimeoutMs: 120_000,
      totalTimeoutMs: 600_000,
      maxRetries: 5,
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('clamps timeout settings to their supported ranges', () => {
    const warn = vi.fn();

    expect(upstreamRequestBudget({
      env: {
        [UPSTREAM_IDLE_TIMEOUT_ENV]: '9',
        [UPSTREAM_TOTAL_TIMEOUT_ENV]: '99999999',
      },
      warn,
    })).toMatchObject({
      idleTimeoutMs: 10_000,
      totalTimeoutMs: 21_600_000,
    });
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      `clamping ${UPSTREAM_IDLE_TIMEOUT_ENV}=9 to ${10_000}ms `
        + `(supported range is ${10_000}-${3_600_000}ms)`,
      `clamping ${UPSTREAM_TOTAL_TIMEOUT_ENV}=99999999 to ${21_600_000}ms `
        + `(supported range is ${60_000}-${21_600_000}ms)`,
    ]);
  });

  it('clamps a too-short total timeout without changing a shorter idle timeout', () => {
    const warn = vi.fn();

    expect(upstreamRequestBudget({
      env: {
        CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: '10000',
        CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS: '1',
      },
      warn,
    })).toMatchObject({ idleTimeoutMs: 10_000, totalTimeoutMs: 60_000 });
    expect(warn).toHaveBeenCalledWith(
      'clamping CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS=1 to 60000ms '
        + '(supported range is 60000-21600000ms)',
    );
  });

  it('reports the same out-of-range timeout value once for each setting', () => {
    const warn = vi.fn();
    const env = {
      [UPSTREAM_IDLE_TIMEOUT_ENV]: '8',
      [UPSTREAM_TOTAL_TIMEOUT_ENV]: '8',
    };

    upstreamRequestBudget({ env, warn });
    upstreamRequestBudget({ env, warn });

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining(UPSTREAM_IDLE_TIMEOUT_ENV),
      expect.stringContaining(UPSTREAM_TOTAL_TIMEOUT_ENV),
    ]);
  });

  it('raises the default total timeout to honor a longer explicit idle timeout', () => {
    const warn = vi.fn();

    expect(upstreamRequestBudget({
      env: { [UPSTREAM_IDLE_TIMEOUT_ENV]: '700000' },
      warn,
    })).toMatchObject({ idleTimeoutMs: 700_000, totalTimeoutMs: 700_000 });
    expect(warn).toHaveBeenCalledWith(
      `raising the resolved total timeout from 600000ms to 700000ms `
      + `so it is not shorter than ${UPSTREAM_IDLE_TIMEOUT_ENV}`,
    );
  });

  it('reports the same timeout-pair adjustment only once per process', () => {
    const warn = vi.fn();
    const env = { CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: '710000' };

    upstreamRequestBudget({ env, warn });
    upstreamRequestBudget({ env, warn });

    expect(warn).toHaveBeenCalledOnce();
  });

  it('honors an explicit total timeout by lowering a longer idle timeout', () => {
    const warn = vi.fn();

    expect(upstreamRequestBudget({
      env: {
        [UPSTREAM_IDLE_TIMEOUT_ENV]: '180000',
        [UPSTREAM_TOTAL_TIMEOUT_ENV]: '60000',
      },
      warn,
    })).toMatchObject({ idleTimeoutMs: 60_000, totalTimeoutMs: 60_000 });
    expect(warn).toHaveBeenCalledWith(
      `lowering the resolved idle timeout from 180000ms to 60000ms `
      + `because it cannot exceed ${UPSTREAM_TOTAL_TIMEOUT_ENV}`,
    );
  });

  it('treats a clamped idle value as explicit when reconciling the pair', () => {
    const warn = vi.fn();

    expect(upstreamRequestBudget({
      env: { CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: '99999999' },
      warn,
    })).toMatchObject({ idleTimeoutMs: 3_600_000, totalTimeoutMs: 3_600_000 });
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      'clamping CLODEX_UPSTREAM_IDLE_TIMEOUT_MS=99999999 to 3600000ms '
        + '(supported range is 10000-3600000ms)',
      'raising the resolved total timeout from 600000ms to 3600000ms '
        + 'so it is not shorter than CLODEX_UPSTREAM_IDLE_TIMEOUT_MS',
    ]);
  });

  it('lowers the default idle timeout when only a shorter total is explicit', () => {
    const warn = vi.fn();

    expect(upstreamRequestBudget({
      env: { CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS: '60000' },
      warn,
    })).toMatchObject({ idleTimeoutMs: 60_000, totalTimeoutMs: 60_000 });
    expect(warn).toHaveBeenCalledWith(
      'lowering the resolved idle timeout from 120000ms to 60000ms '
        + 'because it cannot exceed CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS',
    );
  });

  it('does not warn for valid in-range timeout values', () => {
    const warn = vi.fn();

    expect(upstreamRequestBudget({
      env: {
        CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: '300000',
        CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS: '900000',
      },
      warn,
    })).toMatchObject({ idleTimeoutMs: 300_000, totalTimeoutMs: 900_000 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets a direct idle override supersede the environment before pair resolution', () => {
    const warn = vi.fn();

    expect(upstreamRequestBudget({
      env: { CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: '700000' },
      idleTimeoutMs: 50,
      warn,
    })).toEqual({ idleTimeoutMs: 50, totalTimeoutMs: 600_000, maxRetries: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a direct idle override within an explicit total timeout', () => {
    expect(upstreamRequestBudget({
      env: { CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS: '60000' },
      idleTimeoutMs: 70_000,
      warn: vi.fn(),
    })).toMatchObject({ idleTimeoutMs: 60_000, totalTimeoutMs: 60_000, maxRetries: 4 });
  });

  it('uses the parent notice channel for timeout warnings by default', () => {
    const notices: string[] = [];
    const release = installParentNoticeSink(line => notices.push(line));
    try {
      expect(upstreamRequestBudget({
        env: { CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: 'not-milliseconds' },
      })).toMatchObject({ idleTimeoutMs: 120_000, totalTimeoutMs: 600_000 });
      expect(notices).toEqual([
        'clodex: ignoring CLODEX_UPSTREAM_IDLE_TIMEOUT_MS=not-milliseconds '
          + '(expected a positive integer number of milliseconds)\n',
      ]);
    } finally {
      release();
    }
  });

  it.each([
    ['shorter budget', '30000', '9', 3],
    ['exact sixth-retry boundary', '126000', '6', 5],
    ['longer budget', '127000', '6', 6],
    ['maximum budget', String(3_600_000), '99', 10],
  ])('derives the retry ceiling from the %s', (_name, idle, retries, expected) => {
    const warn = vi.fn();

    expect(upstreamRequestBudget({
      env: {
        [UPSTREAM_IDLE_TIMEOUT_ENV]: idle,
        [UPSTREAM_TOTAL_TIMEOUT_ENV]: String(21_600_000),
        [UPSTREAM_MAX_RETRIES_ENV]: retries,
      },
      warn,
    }).maxRetries).toBe(expected);
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

  it('keeps the passthrough ceiling independent of translated timeout settings', () => {
    const warn = vi.fn();

    expect(passthroughUpstreamRetries({
      CLODEX_UPSTREAM_MAX_RETRIES: '4',
      CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: '10000',
      CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS: '60000',
    }, warn)).toBe(4);
    expect(passthroughUpstreamRetries({
      CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: 'not-a-timeout',
      CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS: 'also-not-a-timeout',
    }, warn)).toBe(1);
    expect(warn).not.toHaveBeenCalled();
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
      expect(passthroughUpstreamRetries({ [UPSTREAM_MAX_RETRIES_ENV]: 'passthrough-invalid' }))
        .toBe(DEFAULT_PASSTHROUGH_RETRIES);
    } finally {
      spy.mockRestore();
    }
  });
});

const REQUEST_BUDGET_ENV_KEYS = [
  'CLODEX_UPSTREAM_MAX_RETRIES',
  'CLODEX_UPSTREAM_IDLE_TIMEOUT_MS',
  'CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS',
] as const;

function setRequestBudgetEnv(values: Partial<Record<typeof REQUEST_BUDGET_ENV_KEYS[number], string>>): () => void {
  const previous = new Map(REQUEST_BUDGET_ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of REQUEST_BUDGET_ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe('upstream request budget adapter wiring', () => {
  it('aborts a stalled stream at the configured idle timeout', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const restoreEnv = setRequestBudgetEnv({
      CLODEX_UPSTREAM_MAX_RETRIES: '0',
      CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: '10000',
      CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS: '60000',
    });
    const callerAbort = new AbortController();
    let sdkSignal: AbortSignal | undefined;
    let sdkMaxRetries: number | undefined;
    const streamText = vi.fn((options: { abortSignal: AbortSignal; maxRetries: number }) => {
      sdkSignal = options.abortSignal;
      sdkMaxRetries = options.maxRetries;
      async function* stream() {
        await new Promise<never>((_resolve, reject) => {
          options.abortSignal.addEventListener(
            'abort',
            () => reject(options.abortSignal.reason),
            { once: true },
          );
        });
      }
      return { stream: stream() };
    });
    vi.doMock('ai', async () => ({
      ...(await vi.importActual<typeof import('ai')>('ai')),
      generateText: vi.fn(),
      streamText,
      tool: vi.fn((spec: unknown) => spec),
      jsonSchema: vi.fn((schema: unknown) => schema),
    }));

    let request: Promise<void> | undefined;
    try {
      const { streamAnthropicResponse } = await import('../src/sdk-adapter.js');
      request = streamAnthropicResponse(
        {} as never,
        { messages: [] },
        'test-model',
        () => {},
        undefined,
        { abortSignal: callerAbort.signal },
      );
      const rejection = request.catch((error: unknown) => error);

      expect(sdkMaxRetries).toBe(0);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(sdkSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(sdkSignal?.aborted).toBe(true);
      await expect(rejection).resolves.toMatchObject({
        message: 'no data received from provider for 10s',
      });
    } finally {
      callerAbort.abort(new Error('test cleanup'));
      await Promise.allSettled(request ? [request] : []);
      vi.useRealTimers();
      restoreEnv();
      vi.doUnmock('ai');
      vi.resetModules();
    }
  });

  it('refreshes the collected-stream idle timer with the configured timeout', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const restoreEnv = setRequestBudgetEnv({
      CLODEX_UPSTREAM_MAX_RETRIES: '0',
      CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: '10000',
      CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS: '60000',
    });
    const callerAbort = new AbortController();
    let sdkSignal: AbortSignal | undefined;
    let sdkMaxRetries: number | undefined;
    let releaseFirstPart: () => void = () => {};
    const firstPart = new Promise<void>(resolve => { releaseFirstPart = resolve; });
    const streamText = vi.fn((options: { abortSignal: AbortSignal; maxRetries: number }) => {
      sdkSignal = options.abortSignal;
      sdkMaxRetries = options.maxRetries;
      async function* stream() {
        await firstPart;
        yield { type: 'text-delta', text: 'started' };
        await new Promise<never>((_resolve, reject) => {
          options.abortSignal.addEventListener(
            'abort',
            () => reject(options.abortSignal.reason),
            { once: true },
          );
        });
      }
      return { stream: stream() };
    });
    vi.doMock('ai', async () => ({
      ...(await vi.importActual<typeof import('ai')>('ai')),
      generateText: vi.fn(),
      streamText,
      tool: vi.fn((spec: unknown) => spec),
      jsonSchema: vi.fn((schema: unknown) => schema),
    }));

    let request: Promise<Record<string, unknown>> | undefined;
    try {
      const { generateAnthropicResponse } = await import('../src/sdk-adapter.js');
      request = generateAnthropicResponse(
        {} as never,
        { messages: [] },
        'test-model',
        { forceStream: true, abortSignal: callerAbort.signal },
      );
      const rejection = request.catch((error: unknown) => error);

      expect(sdkMaxRetries).toBe(0);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(sdkSignal?.aborted).toBe(false);
      releaseFirstPart();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(sdkSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(9_998);
      expect(sdkSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(sdkSignal?.aborted).toBe(true);
      await expect(rejection).resolves.toMatchObject({
        message: 'no data received from provider for 10s',
      });
    } finally {
      callerAbort.abort(new Error('test cleanup'));
      await Promise.allSettled(request ? [request] : []);
      vi.useRealTimers();
      restoreEnv();
      vi.doUnmock('ai');
      vi.resetModules();
    }
  });

  it('aborts an active collected stream at the configured total timeout', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const restoreEnv = setRequestBudgetEnv({
      CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: '10000',
      CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS: '60000',
    });
    const callerAbort = new AbortController();
    let sdkSignal: AbortSignal | undefined;
    let finishForCleanup: () => void = () => {};
    const cleanup = new Promise<void>(resolve => { finishForCleanup = resolve; });
    const streamText = vi.fn((options: { abortSignal: AbortSignal }) => {
      sdkSignal = options.abortSignal;
      async function* stream() {
        while (true) {
          const shouldStop = await Promise.race([
            new Promise<false>(resolve => setTimeout(() => resolve(false), 5_000)),
            cleanup.then(() => true),
          ]);
          if (shouldStop) return;
          yield { type: 'text-delta', text: 'active' };
        }
      }
      return { stream: stream() };
    });
    vi.doMock('ai', async () => ({
      ...(await vi.importActual<typeof import('ai')>('ai')),
      generateText: vi.fn(),
      streamText,
      tool: vi.fn((spec: unknown) => spec),
      jsonSchema: vi.fn((schema: unknown) => schema),
    }));

    let request: Promise<Record<string, unknown>> | undefined;
    try {
      const { generateAnthropicResponse } = await import('../src/sdk-adapter.js');
      request = generateAnthropicResponse(
        {} as never,
        { messages: [] },
        'test-model',
        { forceStream: true, abortSignal: callerAbort.signal },
      );
      const rejection = request.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(59_999);
      expect(sdkSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(sdkSignal?.aborted).toBe(true);
      await expect(rejection).resolves.toMatchObject({
        message: 'provider stream exceeded 60s',
      });
    } finally {
      callerAbort.abort(new Error('test cleanup'));
      finishForCleanup();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.allSettled(request ? [request] : []);
      vi.useRealTimers();
      restoreEnv();
      vi.doUnmock('ai');
      vi.resetModules();
    }
  });

  it('aborts a non-streaming generation at the configured total timeout', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const restoreEnv = setRequestBudgetEnv({
      CLODEX_UPSTREAM_MAX_RETRIES: '0',
      CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: '10000',
      CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS: '60000',
    });
    const callerAbort = new AbortController();
    let sdkSignal: AbortSignal | undefined;
    let sdkMaxRetries: number | undefined;
    const generateText = vi.fn((options: { abortSignal: AbortSignal; maxRetries: number }) => {
      sdkSignal = options.abortSignal;
      sdkMaxRetries = options.maxRetries;
      return new Promise<never>((_resolve, reject) => {
        options.abortSignal.addEventListener(
          'abort',
          () => reject(options.abortSignal.reason),
          { once: true },
        );
      });
    });
    vi.doMock('ai', async () => ({
      ...(await vi.importActual<typeof import('ai')>('ai')),
      generateText,
      streamText: vi.fn(),
      tool: vi.fn((spec: unknown) => spec),
      jsonSchema: vi.fn((schema: unknown) => schema),
    }));

    let request: Promise<Record<string, unknown>> | undefined;
    try {
      const { generateAnthropicResponse } = await import('../src/sdk-adapter.js');
      request = generateAnthropicResponse(
        {} as never,
        { messages: [] },
        'test-model',
        { abortSignal: callerAbort.signal },
      );
      const rejection = request.catch((error: unknown) => error);

      expect(sdkMaxRetries).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sdkSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(49_999);
      expect(sdkSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(sdkSignal?.aborted).toBe(true);
      await expect(rejection).resolves.toMatchObject({
        message: 'provider request exceeded 60s',
      });
    } finally {
      callerAbort.abort(new Error('test cleanup'));
      await Promise.allSettled(request ? [request] : []);
      vi.useRealTimers();
      restoreEnv();
      vi.doUnmock('ai');
      vi.resetModules();
    }
  });

  it('clears Anthropic timers when SDK stream setup rejects synchronously', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const restoreEnv = setRequestBudgetEnv({
      CLODEX_UPSTREAM_IDLE_TIMEOUT_MS: '10000',
      CLODEX_UPSTREAM_TOTAL_TIMEOUT_MS: '60000',
    });
    try {
      const { MockLanguageModelV4 } = await import('ai/test');
      const { generateAnthropicResponse, streamAnthropicResponse } =
        await import('../src/sdk-adapter.js');
      const model = new MockLanguageModelV4();
      const params = {
        messages: [{ role: 'user' as const, content: 'test' }],
        maxOutputTokens: 0,
      };

      await expect(streamAnthropicResponse(model, params, 'test-model', () => {}))
        .rejects.toThrow('maxOutputTokens must be >= 1');
      expect(vi.getTimerCount()).toBe(0);
      await expect(generateAnthropicResponse(
        model,
        params,
        'test-model',
        { forceStream: true },
      )).rejects.toThrow('maxOutputTokens must be >= 1');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      restoreEnv();
      vi.resetModules();
    }
  });
});
