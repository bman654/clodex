import { describe, it, expect, vi } from 'vitest';
import {
  ASSUMED_UPSTREAM_IDLE_TIMEOUT_MS,
  DEFAULT_WS_NEW_CONNECTIONS_PER_MIN,
  MAX_WS_NEW_CONNECTIONS_PER_MIN,
  WsUpgradePacer,
  WS_NEW_CONNECTIONS_PER_MIN_ENV,
  WS_NEW_CONNECTION_BURST,
  WS_NEW_CONNECTION_MAX_WAIT_CEILING_MS,
  resetWsUpgradePacerForTests,
  resolvedUpstreamMaxRetries,
  wsNewConnectionMaxWaitMs,
  wsNewConnectionsPerMinute,
  type UpgradeAdmission,
} from '../src/oauth/ws-upgrade-pacer.js';

/**
 * Deterministic clock. Nothing in this file sleeps: time only moves when a test
 * advances it, so a rate expressed per minute is exercised in microseconds.
 */
class TestClock {
  time = 0;
  private timers: Array<{ at: number; fire: () => void }> = [];

  now = (): number => this.time;

  schedule = (ms: number, fire: () => void): (() => void) => {
    const timer = { at: this.time + ms, fire };
    this.timers.push(timer);
    return () => { this.timers = this.timers.filter(candidate => candidate !== timer); };
  };

  /** Timers still armed. A leak shows up here. */
  get pending(): number {
    return this.timers.length;
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers].sort((left, right) => left.at - right.at)[0];
      if (!due || due.at > target) break;
      this.timers = this.timers.filter(candidate => candidate !== due);
      this.time = due.at;
      due.fire();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

/** Drain the microtask queue so awaiting callers resume before we assert. */
function flush(): Promise<void> {
  return new Promise(resolve => { setImmediate(resolve); });
}

interface Tracked {
  state: () => 'pending' | 'admitted' | 'refused' | 'rejected';
  admission: () => UpgradeAdmission | undefined;
  /** Clock reading when this admission settled. */
  settledAt: () => number | undefined;
  error: () => unknown;
}

/** Track an admission's outcome without ever awaiting a pending one. */
function track(clock: TestClock, promise: Promise<UpgradeAdmission>): Tracked {
  let state: 'pending' | 'admitted' | 'refused' | 'rejected' = 'pending';
  let admission: UpgradeAdmission | undefined;
  let settledAt: number | undefined;
  let error: unknown;
  promise.then(
    value => { state = value.kind; admission = value; settledAt = clock.time; },
    reason => { state = 'rejected'; error = reason; settledAt = clock.time; },
  );
  return {
    state: () => state,
    admission: () => admission,
    settledAt: () => settledAt,
    error: () => error,
  };
}

/**
 * A bound of exactly `ms`, expressed through the options production uses.
 * `maxRetries` must be non-zero: with retries off the pacer never refuses,
 * which is its own test below.
 */
function boundedBy(ms: number): { idleTimeoutMs: number; maxRetries: number } {
  return { idleTimeoutMs: 4 * ms + 2_000, maxRetries: 1 };
}

describe('wsNewConnectionMaxWaitMs', () => {
  // Whatever retry budget clodex ships, the ladder must fit the deadline. The
  // matrix is the point: a bound derived for one retry count and used with
  // another is how this becomes a merge-order bug.
  it.each([0, 1, 2, 3, 5])('keeps a %i-retry ladder inside the deadline it shares', maxRetries => {
    const idleTimeoutMs = ASSUMED_UPSTREAM_IDLE_TIMEOUT_MS;
    const bound = wsNewConnectionMaxWaitMs(idleTimeoutMs, maxRetries);
    const backoffMs = 2_000 * (2 ** maxRetries - 1);

    expect(bound).toBeGreaterThan(0);
    expect((maxRetries + 1) * bound + backoffMs).toBeLessThan(idleTimeoutMs);
    // Pacing takes at most half of what the backoff ladder leaves, so the
    // request keeps an equal share for the provider's own first byte.
    expect((maxRetries + 1) * bound).toBeLessThanOrEqual((idleTimeoutMs - backoffMs) / 2);
  });

  it('reads the retry budget in force rather than assuming one', () => {
    // Unset, the AI SDK applies its own default of two. A hardcoded assumption
    // here would be wrong on one side or the other of any change to that.
    expect(resolvedUpstreamMaxRetries()).toBe(2);
    process.env.CLODEX_UPSTREAM_MAX_RETRIES = '5';
    try {
      expect(resolvedUpstreamMaxRetries()).toBe(5);
      expect(new WsUpgradePacer().maxWaitMs)
        .toBe(wsNewConnectionMaxWaitMs(ASSUMED_UPSTREAM_IDLE_TIMEOUT_MS, 5));
    } finally {
      delete process.env.CLODEX_UPSTREAM_MAX_RETRIES;
    }
  });

  it('is total on degenerate input rather than failing open into an unbounded wait', () => {
    // NaN would make every `waitMs > maxWaitMs` comparison false.
    expect(wsNewConnectionMaxWaitMs(Number.NaN, 2)).toBe(0);
    expect(wsNewConnectionMaxWaitMs(120_000, Number.NaN)).toBe(0);
    expect(wsNewConnectionMaxWaitMs(120_000, -1)).toBe(0);
    expect(wsNewConnectionMaxWaitMs(0, 2)).toBe(0);
    expect(wsNewConnectionMaxWaitMs(120_000, 1_000)).toBe(0);
  });

  it('never exceeds the ceiling even when the deadline is generous', () => {
    expect(wsNewConnectionMaxWaitMs(3_600_000, 0)).toBe(WS_NEW_CONNECTION_MAX_WAIT_CEILING_MS);
  });

  it('stops queueing entirely when the ladder alone would exhaust the deadline', () => {
    // 10s deadline against a 62s ladder: there is no budget to wait in, so
    // nothing is queued and the overflow is refused instead.
    expect(wsNewConnectionMaxWaitMs(10_000, 5)).toBe(0);
  });

  it('is what the pacer actually uses, and is 15s at most', () => {
    expect(new WsUpgradePacer().maxWaitMs)
      .toBe(wsNewConnectionMaxWaitMs(ASSUMED_UPSTREAM_IDLE_TIMEOUT_MS, resolvedUpstreamMaxRetries()));
    // Independent oracle: the literal, not the constant the code imports.
    expect(new WsUpgradePacer().maxWaitMs).toBeLessThanOrEqual(15_000);
  });
});

describe('WsUpgradePacer', () => {
  it('admits a burst immediately and then holds arrivals to the configured rate', async () => {
    const clock = new TestClock();
    // 60/minute is one connection per second, so each held arrival is a second.
    const pacer = new WsUpgradePacer({
      ratePerMinute: 60,
      burst: 10,
      ...boundedBy(15_000),
      now: clock.now,
      schedule: clock.schedule,
    });

    const admissions = Array.from({ length: 13 }, () => track(clock, pacer.admit()));
    await flush();

    expect(admissions.slice(0, 10).map(entry => entry.state())).toEqual(Array(10).fill('admitted'));
    expect(admissions.slice(0, 10).every(entry => entry.admission()?.kind === 'admitted'
      && entry.admission().waitedMs === 0)).toBe(true);
    expect(admissions.slice(10).map(entry => entry.state())).toEqual(['pending', 'pending', 'pending']);

    await clock.advance(1_000);
    expect(admissions[10]!.admission()).toEqual({ kind: 'admitted', waitedMs: 1_000 });
    expect(admissions[11]!.state()).toBe('pending');

    await clock.advance(1_000);
    expect(admissions[11]!.admission()).toEqual({ kind: 'admitted', waitedMs: 2_000 });

    await clock.advance(1_000);
    expect(admissions[12]!.admission()).toEqual({ kind: 'admitted', waitedMs: 3_000 });
    expect(clock.pending).toBe(0);
  });

  it('holds SUSTAINED output to the rate when offered more than it', async () => {
    // The regression this test exists for: an earlier design admitted anyway
    // once the wait bound expired, which made sustained output equal sustained
    // input delayed by the bound — 82/minute in, 82/minute out. 82/minute is
    // the rate the logged rejections came from.
    //
    // Measured over the FINAL minute, after the burst and the queue transient
    // have washed out, so this reads the steady-state rate and not the
    // reservoir. The earlier design scored 82 here.
    const clock = new TestClock();
    const pacer = new WsUpgradePacer({
      ratePerMinute: 60,
      burst: 10,
      ...boundedBy(15_000),
      now: clock.now,
      schedule: clock.schedule,
    });

    const offeredPerMinute = 82;
    const windowMs = 240_000;
    const intervalMs = Math.round(60_000 / offeredPerMinute);
    const offered: Tracked[] = [];
    while (clock.time < windowMs) {
      offered.push(track(clock, pacer.admit()));
      await clock.advance(intervalMs);
    }

    const openedIn = (fromMs: number, toMs: number) => offered.filter(entry => {
      const at = entry.settledAt();
      return entry.state() === 'admitted' && at !== undefined && at > fromMs && at <= toMs;
    }).length;

    // ~328 requests offered across four minutes.
    expect(offered.length).toBeGreaterThanOrEqual(320);
    expect(openedIn(180_000, 240_000)).toBeLessThanOrEqual(61);
    expect(openedIn(180_000, 240_000)).toBeGreaterThan(50);
    // The overflow is refused, not silently admitted late.
    expect(offered.filter(entry => entry.state() === 'refused').length).toBeGreaterThan(0);
    // Whole-run ceiling, stated as the invariant: burst + one bound's worth of
    // queue + the refill over the run. Not the offered count.
    const admitted = offered.filter(entry => entry.state() === 'admitted').length;
    expect(admitted).toBeLessThanOrEqual(10 + 15 + (windowMs / 60_000) * 60);
    expect(admitted).toBeLessThan(offered.length);
  });

  it('shapes the opening burst but stops taxing once retries are turned off', async () => {
    // With CLODEX_UPSTREAM_MAX_RETRIES=0 the SDK rethrows before it consults
    // shouldRetry, so a refusal would be an immediate hard failure. It must
    // admit — but delaying EVERY request by the bound past the debt floor
    // shapes nothing (output would equal input, merely late) and only taxes the
    // user, so shaping stops at the floor instead.
    const clock = new TestClock();
    const pacer = new WsUpgradePacer({
      ratePerMinute: 60,
      burst: 10,
      idleTimeoutMs: 120_000,
      maxRetries: 0,
      now: clock.now,
      schedule: clock.schedule,
    });
    const maxDebt = pacer.maxWaitMs / 1_000;

    const admissions = Array.from({ length: 60 }, () => track(clock, pacer.admit()));
    await flush();
    expect(admissions.some(entry => entry.state() === 'refused')).toBe(false);

    await clock.advance(pacer.maxWaitMs);
    expect(admissions.every(entry => entry.state() === 'admitted')).toBe(true);

    // Shaping covers the burst plus one bound's worth of credit; within that
    // window `maxDebt` requests are actually held back.
    const delayed = admissions.filter(entry => (entry.settledAt() ?? 0) > 0).length;
    expect(delayed).toBe(maxDebt);
    // Everything past the floor is admitted with NO wait, rather than each
    // paying the bound to achieve no shaping at all.
    expect(admissions.filter(entry => entry.settledAt() === 0)).toHaveLength(60 - maxDebt);
  });

  it('does not pace at all when the deadline leaves no room to queue', async () => {
    const clock = new TestClock();
    // A 10s deadline against a 62s backoff ladder: no budget to wait in.
    const pacer = new WsUpgradePacer({
      ratePerMinute: 60,
      burst: 1,
      idleTimeoutMs: 10_000,
      maxRetries: 5,
      now: clock.now,
      schedule: clock.schedule,
    });
    expect(pacer.maxWaitMs).toBe(0);

    const admissions = Array.from({ length: 20 }, () => track(clock, pacer.admit()));
    await flush();
    // Refusing everything past the burst would be worse than not pacing.
    expect(admissions.every(entry => entry.admission()?.kind === 'admitted')).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it('refuses with a retryable backoff hint once the queue would exceed the bound', async () => {
    const clock = new TestClock();
    const pacer = new WsUpgradePacer({
      ratePerMinute: 60,
      burst: 1,
      ...boundedBy(2_000),
      now: clock.now,
      schedule: clock.schedule,
    });

    const admissions = Array.from({ length: 5 }, () => track(clock, pacer.admit()));
    await flush();

    expect(admissions[0]!.admission()).toEqual({ kind: 'admitted', waitedMs: 0 });
    expect(admissions[3]!.admission()).toEqual({
      kind: 'refused', requiredWaitMs: 3_000, retryAfterSeconds: 3,
    });
    expect(admissions[4]!.admission()).toEqual({
      kind: 'refused', requiredWaitMs: 3_000, retryAfterSeconds: 3,
    });

    await clock.advance(2_000);
    // The two that fitted inside the bound were queued, not refused.
    expect(admissions[1]!.admission()).toEqual({ kind: 'admitted', waitedMs: 1_000 });
    expect(admissions[2]!.admission()).toEqual({ kind: 'admitted', waitedMs: 2_000 });
    expect(clock.pending).toBe(0);
  });

  it('charges a refusal nothing, so a retried request is not pushed further back', async () => {
    // This is the livelock guard. A refused request opens no connection and the
    // client retries it; if the refusal took a token, every retry would deepen
    // the deficit that caused it and the ladder could never recover.
    const clock = new TestClock();
    const pacer = new WsUpgradePacer({
      ratePerMinute: 60,
      burst: 1,
      ...boundedBy(2_000),
      now: clock.now,
      schedule: clock.schedule,
    });

    Array.from({ length: 3 }, () => track(clock, pacer.admit()));
    const refused = Array.from({ length: 3 }, () => track(clock, pacer.admit()));
    await flush();
    expect(refused.map(entry => entry.state())).toEqual(['refused', 'refused', 'refused']);

    await clock.advance(3_000);
    const retried = track(clock, pacer.admit());
    await flush();
    // Three refusals debited nothing, so the bucket is back to full credit.
    // Had they each taken a token, this would be refused too.
    expect(retried.admission()).toEqual({ kind: 'admitted', waitedMs: 0 });
  });

  it('lets a refused request through on a later attempt as the bucket refills', async () => {
    const clock = new TestClock();
    const pacer = new WsUpgradePacer({
      ratePerMinute: 60,
      burst: 1,
      ...boundedBy(2_000),
      now: clock.now,
      schedule: clock.schedule,
    });

    Array.from({ length: 3 }, () => track(clock, pacer.admit()));
    const firstAttempt = track(clock, pacer.admit());
    await flush();
    expect(firstAttempt.state()).toBe('refused');

    // The AI SDK's first backoff step.
    await clock.advance(2_000);
    const secondAttempt = track(clock, pacer.admit());
    await flush();
    await clock.advance(2_000);
    expect(secondAttempt.state()).toBe('admitted');
  });

  it('releases a queued request as soon as its caller aborts, and returns its token', async () => {
    const clock = new TestClock();
    const pacer = new WsUpgradePacer({
      ratePerMinute: 60,
      burst: 1,
      ...boundedBy(15_000),
      now: clock.now,
      schedule: clock.schedule,
    });

    track(clock, pacer.admit());
    const controller = new AbortController();
    const cancelled = track(clock, pacer.admit(controller.signal));
    await flush();
    expect(cancelled.state()).toBe('pending');
    expect(clock.pending).toBe(1);

    controller.abort();
    await flush();

    // Promptly: the clock has not moved at all.
    expect(clock.time).toBe(0);
    expect(cancelled.state()).toBe('rejected');
    expect((cancelled.error() as Error).name).toBe('AbortError');
    // And its timer is gone, not left to fire into a dead request.
    expect(clock.pending).toBe(0);

    // The abandoned reservation went back to the bucket, so the next arrival
    // takes the slot it vacated: 1s, not the 2s it would inherit if the token
    // had been consumed by a connection that was never opened. The control for
    // this number is the "waits out the full queue" case below.
    const next = track(clock, pacer.admit());
    await flush();
    await clock.advance(1_000);
    expect(next.admission()).toEqual({ kind: 'admitted', waitedMs: 1_000 });
  });

  it('makes a queued request wait out the full queue when nobody aborts', async () => {
    const clock = new TestClock();
    const pacer = new WsUpgradePacer({
      ratePerMinute: 60,
      burst: 1,
      ...boundedBy(15_000),
      now: clock.now,
      schedule: clock.schedule,
    });

    track(clock, pacer.admit());
    track(clock, pacer.admit());
    const follower = track(clock, pacer.admit());
    await flush();

    await clock.advance(1_000);
    expect(follower.state()).toBe('pending');
    await clock.advance(1_000);
    expect(follower.admission()).toEqual({ kind: 'admitted', waitedMs: 2_000 });
  });

  it('spends no token on a request that was already cancelled', async () => {
    const clock = new TestClock();
    const pacer = new WsUpgradePacer({
      ratePerMinute: 60,
      burst: 1,
      ...boundedBy(15_000),
      now: clock.now,
      schedule: clock.schedule,
    });

    const controller = new AbortController();
    controller.abort();
    await expect(pacer.admit(controller.signal)).rejects.toThrow();

    const next = track(clock, pacer.admit());
    await flush();
    // Had the dead request taken the only token, this would have been queued.
    expect(next.admission()).toEqual({ kind: 'admitted', waitedMs: 0 });
    expect(clock.pending).toBe(0);
  });

  it('surfaces the caller\'s own abort reason unchanged', async () => {
    const clock = new TestClock();
    const pacer = new WsUpgradePacer({
      ratePerMinute: 60,
      burst: 1,
      ...boundedBy(15_000),
      now: clock.now,
      schedule: clock.schedule,
    });

    track(clock, pacer.admit());
    const controller = new AbortController();
    const queued = pacer.admit(controller.signal);
    const settled = track(clock, queued);
    await flush();

    const reason = new Error('no data received from provider for 120s');
    controller.abort(reason);
    await flush();
    expect(settled.error()).toBe(reason);
    await expect(queued).rejects.toBe(reason);
  });

  it('never waits or refuses when pacing is turned off', async () => {
    const clock = new TestClock();
    const pacer = new WsUpgradePacer({
      ratePerMinute: 0,
      burst: 1,
      now: clock.now,
      schedule: clock.schedule,
    });

    const admissions = Array.from({ length: 50 }, () => track(clock, pacer.admit()));
    await flush();
    expect(admissions.every(entry => entry.admission()?.kind === 'admitted')).toBe(true);
    expect(clock.pending).toBe(0);
  });
});

describe('wsNewConnectionsPerMinute', () => {
  it('defaults when unset or empty', () => {
    expect(wsNewConnectionsPerMinute({})).toBe(DEFAULT_WS_NEW_CONNECTIONS_PER_MIN);
    expect(wsNewConnectionsPerMinute({ [WS_NEW_CONNECTIONS_PER_MIN_ENV]: '   ' }))
      .toBe(DEFAULT_WS_NEW_CONNECTIONS_PER_MIN);
  });

  it('accepts a valid rate and treats zero as off', () => {
    expect(wsNewConnectionsPerMinute({ [WS_NEW_CONNECTIONS_PER_MIN_ENV]: ' 90 ' })).toBe(90);
    expect(wsNewConnectionsPerMinute({ [WS_NEW_CONNECTIONS_PER_MIN_ENV]: '0' })).toBe(0);
    // Any spelling `Number` reads as an integer is accepted, exactly as the
    // existing CLODEX_UPSTREAM_MAX_RETRIES parser does.
    expect(wsNewConnectionsPerMinute({ [WS_NEW_CONNECTIONS_PER_MIN_ENV]: '1e2' })).toBe(100);
  });

  it('treats the documented upper bound as inclusive', () => {
    resetWsUpgradePacerForTests();
    const warn = vi.fn();
    // 600 is documented as allowed, so it must not clamp and must not warn.
    // Literals, not the imported constants: an oracle that imports the value
    // it checks cannot catch the value changing.
    expect(wsNewConnectionsPerMinute({ [WS_NEW_CONNECTIONS_PER_MIN_ENV]: '600' }, warn)).toBe(600);
    expect(warn).not.toHaveBeenCalled();
    expect(wsNewConnectionsPerMinute({ [WS_NEW_CONNECTIONS_PER_MIN_ENV]: '601' }, warn)).toBe(600);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('pins the shipped defaults against their literals', () => {
    expect(DEFAULT_WS_NEW_CONNECTIONS_PER_MIN).toBe(60);
    expect(MAX_WS_NEW_CONNECTIONS_PER_MIN).toBe(600);
    expect(WS_NEW_CONNECTION_BURST).toBe(10);
    expect(WS_NEW_CONNECTION_MAX_WAIT_CEILING_MS).toBe(15_000);
  });

  it('hands out exactly ten free connections before it starts queueing', async () => {
    // Behavioural oracle for the burst: no test-only accessor, and it fails if
    // the constructor stops using the documented default.
    const clock = new TestClock();
    const pacer = new WsUpgradePacer({ now: clock.now, schedule: clock.schedule });
    const admissions = Array.from({ length: 12 }, () => track(clock, pacer.admit()));
    await flush();
    const immediate = admissions.filter(entry => entry.state() === 'admitted'
      && entry.admission()?.kind === 'admitted' && entry.settledAt() === 0).length;
    expect(immediate).toBe(10);
    expect(admissions[10]!.state()).toBe('pending');
  });

  it('clamps an out-of-range rate and warns exactly once', () => {
    resetWsUpgradePacerForTests();
    const warn = vi.fn();
    const env = { [WS_NEW_CONNECTIONS_PER_MIN_ENV]: '5000' };
    expect(wsNewConnectionsPerMinute(env, warn)).toBe(MAX_WS_NEW_CONNECTIONS_PER_MIN);
    expect(wsNewConnectionsPerMinute(env, warn)).toBe(MAX_WS_NEW_CONNECTIONS_PER_MIN);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('clamping CLODEX_WS_MAX_NEW_CONNECTIONS_PER_MIN=5000 to 600');
  });

  it.each(['abc', '-1', '12.5', 'Infinity', 'NaN', '1,000'])(
    'ignores the malformed value %s and warns once',
    raw => {
      resetWsUpgradePacerForTests();
      const warn = vi.fn();
      const env = { [WS_NEW_CONNECTIONS_PER_MIN_ENV]: raw };
      expect(wsNewConnectionsPerMinute(env, warn)).toBe(DEFAULT_WS_NEW_CONNECTIONS_PER_MIN);
      expect(wsNewConnectionsPerMinute(env, warn)).toBe(DEFAULT_WS_NEW_CONNECTIONS_PER_MIN);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain(`ignoring CLODEX_WS_MAX_NEW_CONNECTIONS_PER_MIN=${raw}`);
    },
  );

  it('never lets a failing notice channel break the caller', () => {
    resetWsUpgradePacerForTests();
    const warn = vi.fn(() => { throw new Error('stderr is gone'); });
    expect(wsNewConnectionsPerMinute({ [WS_NEW_CONNECTIONS_PER_MIN_ENV]: 'nope' }, warn))
      .toBe(DEFAULT_WS_NEW_CONNECTIONS_PER_MIN);
  });
});
