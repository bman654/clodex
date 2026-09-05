import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_WS_NEW_CONNECTIONS_PER_MIN,
  MAX_WS_NEW_CONNECTIONS_PER_MIN,
  WsUpgradePacer,
  WS_NEW_CONNECTIONS_PER_MIN_ENV,
  WS_NEW_CONNECTION_BURST,
  WS_NEW_CONNECTION_MAX_WAIT_CEILING_MS,
  resetWsUpgradePacerForTests,
  canRefuseAtRate,
  pacedRetryAfterSeconds,
  refusalScheduleMs,
  resolvedPacingBudget,
  wsNewConnectionMaxWaitMs,
  wsNewConnectionsPerMinute,
  type UpgradeAdmission,
} from '../src/oauth/ws-upgrade-pacer.js';
import { installParentNoticeSink } from '../src/parent-notice.js';
import {
  UPSTREAM_IDLE_TIMEOUT_ENV,
  UPSTREAM_MAX_RETRIES_ENV,
  UPSTREAM_TOTAL_TIMEOUT_ENV,
  upstreamRequestBudget,
} from '../src/upstream-retry.js';

/**
 * The full admitted shape. `queued` is asserted explicitly rather than derived
 * from `waitedMs`, because the whole point of the flag is that the two can
 * disagree when the clock moves.
 */
function admitted(waitedMs: number, queued: boolean) {
  return { kind: 'admitted', waitedMs, queued, release: expect.any(Function) };
}

/** The AI SDK's fallback ladder: 2s, 4s, 8s, … with no jitter. */
function sdkBackoffMs(maxRetries: number): number {
  return 2_000 * (2 ** maxRetries - 1);
}

/**
 * Run `body` against a known-clean upstream-budget environment.
 *
 * The budget is resolved from `process.env` in production, so a stray ambient
 * value would silently change what these assertions mean.
 */
function withUpstreamEnv<T>(values: Record<string, string | undefined>, body: () => T): T {
  const keys = [UPSTREAM_IDLE_TIMEOUT_ENV, UPSTREAM_TOTAL_TIMEOUT_ENV, UPSTREAM_MAX_RETRIES_ENV];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return body();
  } finally {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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
    const idleTimeoutMs = 120_000;
    const bound = wsNewConnectionMaxWaitMs(idleTimeoutMs, maxRetries);
    const backoffMs = sdkBackoffMs(maxRetries);

    expect(bound).toBeGreaterThan(0);
    expect((maxRetries + 1) * bound + backoffMs).toBeLessThan(idleTimeoutMs);
    // Pacing takes at most half of what the backoff ladder leaves, so the
    // request keeps an equal share for the provider's own first byte.
    expect((maxRetries + 1) * bound).toBeLessThanOrEqual((idleTimeoutMs - backoffMs) / 2);
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
});

/**
 * The bound against the budget the paced request actually spends.
 *
 * Both terms of `(maxRetries + 1) x bound + totalBackoff < idleTimeout` are
 * user-configurable and they interact, so checking the arithmetic at one
 * deadline proves nothing about the rest of the range. These drive real
 * environments through the real budget resolver, which is the composition no
 * single change's CI exercises.
 *
 * Two mutations this is built to catch, both of which ship a default-on hard
 * abort: a flat 15s bound reads 6 x 15s + 62s = 152s against the default 120s
 * deadline, and a bound derived from a hardcoded 120s is wrong at every
 * deadline the user can actually configure.
 */
describe('the wait bound against the resolved request budget', () => {
  const IDLE_TIMEOUTS = [
    undefined,   // shipped default
    '9000',      // below the floor: clamps up to 10s
    '10000',     // the floor
    '14001',     // barely wider than its own backoff ladder
    '20000',
    '30000',
    '120000',
    '300000',
    '3600000',   // the ceiling
    '7200000',   // above the ceiling: clamps down
    'nonsense',  // malformed: falls back to the default
  ];
  const RETRIES = [undefined, '0', '1', '2', '5', '10', '99', '-1'];

  it.each(IDLE_TIMEOUTS.flatMap(idle => RETRIES.map(retries => [idle, retries] as const)))(
    'keeps the whole retry ladder inside the deadline (idle=%s, retries=%s)',
    (idle, retries) => {
      const budget = withUpstreamEnv(
        {
          [UPSTREAM_IDLE_TIMEOUT_ENV]: idle,
          [UPSTREAM_MAX_RETRIES_ENV]: retries,
          // Pinned high so the idle timeout is never lowered to meet it; the
          // pair's interaction has its own case below.
          [UPSTREAM_TOTAL_TIMEOUT_ENV]: '21600000',
        },
        () => upstreamRequestBudget({ warn: () => {} }),
      );
      const bound = wsNewConnectionMaxWaitMs(budget.idleTimeoutMs, budget.maxRetries);

      // The inequality, stated exactly as the module documents it.
      expect((budget.maxRetries + 1) * bound + sdkBackoffMs(budget.maxRetries))
        .toBeLessThan(budget.idleTimeoutMs);
      expect(bound).toBeGreaterThanOrEqual(0);
      expect(bound).toBeLessThanOrEqual(WS_NEW_CONNECTION_MAX_WAIT_CEILING_MS);

      // And the same inequality against what the request ACTUALLY spends
      // between attempts. The SDK substitutes a supplied hint for its own rung
      // rather than taking the larger, so the real per-gap delay is the pacer's
      // capped hint wherever that exceeds the rung. Budgeting only the ladder
      // is what let a 30s hint overrun a 10s deadline.
      // Derived here, NOT by calling the function under test. The first version
      // of this line called `pacedRetryAfterSeconds(Number.POSITIVE_INFINITY,
      // bound)` — and the helper maps every non-finite deficit to one second,
      // so the oracle read 1000ms for EVERY bound and the matrix silently
      // tested one degenerate value. A mutation that removed the cap above a 2s
      // bound survived all 131 tests under it.
      const hintCapMs = Math.max(1_000, Math.floor(bound / 1_000) * 1_000);
      let worstGapsMs = 0;
      for (let retry = 0; retry < budget.maxRetries; retry += 1) {
        worstGapsMs += Math.max(hintCapMs, 2_000 * 2 ** retry);
      }
      expect((budget.maxRetries + 1) * bound + worstGapsMs)
        .toBeLessThan(budget.idleTimeoutMs);
    },
  );

  it.each([
    // [bound, deficit, expected hint seconds]
    [666, 30_000, 1],        // sub-second bound: the floor, not the deficit
    [2_000, 30_000, 2],
    [4_833, 30_000, 4],      // the shipped default bound
    [15_000, 30_000, 15],    // the ceiling
    [15_000, 3_000, 3],      // a deficit UNDER the cap is passed through
    [4_833, 1_200, 2],       // rounded up, still under the cap
  ])('caps a refusal hint at bound=%ims (deficit %ims) to %is', (bound, deficit, expected) => {
    // Direct cases at the two bounds production actually uses. The matrix above
    // could not see these: it derived its own expectation, so a cap that only
    // applied below 2s passed it.
    expect(pacedRetryAfterSeconds(deficit, bound)).toBe(expected);
    // Never longer than the bound, except where whole seconds cannot express
    // it, and never zero.
    expect(pacedRetryAfterSeconds(deficit, bound) * 1_000)
      .toBeLessThanOrEqual(Math.max(1_000, bound));
    expect(pacedRetryAfterSeconds(deficit, bound)).toBeGreaterThanOrEqual(1);
  });

  it('is total on a degenerate deficit or bound', () => {
    expect(pacedRetryAfterSeconds(Number.NaN, 15_000)).toBe(1);
    expect(pacedRetryAfterSeconds(Number.POSITIVE_INFINITY, 15_000)).toBe(1);
    expect(pacedRetryAfterSeconds(30_000, Number.NaN)).toBe(1);
    expect(pacedRetryAfterSeconds(-5, 15_000)).toBe(1);
  });

  it('holds when a short total timeout drags the idle timeout down with it', () => {
    // #171's pair rule: an explicit total below the idle lowers the idle. The
    // pacer must size itself against the lowered value, not the requested one.
    const budget = withUpstreamEnv(
      {
        [UPSTREAM_IDLE_TIMEOUT_ENV]: '600000',
        [UPSTREAM_TOTAL_TIMEOUT_ENV]: '60000',
      },
      () => upstreamRequestBudget({ warn: () => {} }),
    );
    expect(budget.idleTimeoutMs).toBe(60_000);

    const bound = wsNewConnectionMaxWaitMs(budget.idleTimeoutMs, budget.maxRetries);
    expect((budget.maxRetries + 1) * bound + sdkBackoffMs(budget.maxRetries))
      .toBeLessThan(60_000);
  });

  it('reads the budget in force rather than assuming one', () => {
    // Unset, this is #171's derived default: five retries inside a 120s window.
    expect(withUpstreamEnv({}, () => resolvedPacingBudget()))
      .toEqual({ idleTimeoutMs: 120_000, maxRetries: 5 });
    expect(withUpstreamEnv({ [UPSTREAM_MAX_RETRIES_ENV]: '2' }, () => resolvedPacingBudget()))
      .toEqual({ idleTimeoutMs: 120_000, maxRetries: 2 });
    expect(withUpstreamEnv({ [UPSTREAM_IDLE_TIMEOUT_ENV]: '30000' }, () => resolvedPacingBudget()))
      // A 30s window cannot fund a fourth retry, so the ceiling caps it at three.
      .toEqual({ idleTimeoutMs: 30_000, maxRetries: 3 });
  });

  it('is what the pacer actually uses, at the shipped default', () => {
    const pacer = withUpstreamEnv({}, () => new WsUpgradePacer());
    // Independent oracle: the arithmetic written out, not the function reused.
    // (120000 - 62000) / 2 / 6 attempts.
    expect(pacer.maxWaitMs).toBe(4_833);
    expect(6 * pacer.maxWaitMs + 62_000).toBeLessThan(120_000);
  });

  it('shrinks its bound when the user shortens the deadline', () => {
    // A pacer that derived its bound from a hardcoded 120s would read 13250ms
    // here — over six times the deadline's actual share.
    const pacer = withUpstreamEnv(
      { [UPSTREAM_IDLE_TIMEOUT_ENV]: '30000' },
      () => new WsUpgradePacer(),
    );
    expect(pacer.maxWaitMs).toBe(2_000);
    expect(wsNewConnectionMaxWaitMs(120_000, 3)).toBe(13_250);
  });

  it('grows its bound only up to the ceiling when the user lengthens the deadline', () => {
    const pacer = withUpstreamEnv(
      { [UPSTREAM_IDLE_TIMEOUT_ENV]: '3600000' },
      () => new WsUpgradePacer(),
    );
    expect(pacer.maxWaitMs).toBe(WS_NEW_CONNECTION_MAX_WAIT_CEILING_MS);
  });

  it('never asks the client to wait longer than the deadline funds', async () => {
    // REGRESSION. The bound budgets the SDK's 2s/4s/8s ladder, but a refusal
    // carries its own `retry-after`, and `getRetryDelayInMs` (ai@7.0.22,
    // util/retry-with-exponential-backoff.ts) SUBSTITUTES that hint for the
    // rung whenever it is under 60s. So the hint, not the ladder, is what the
    // request spends between attempts — and an uncapped hint taken from the
    // token deficit silently replaced the term the bound was derived against.
    //
    // 6/minute puts a token 10s away, so the third arrival needs 20s against a
    // 15s bound. Before the cap it asked for 20s. The bound is deliberately the
    // 15s ceiling here: a cap that only bit below 2s passed every other test.
    const clock = new TestClock();
    const pacer = new WsUpgradePacer({
      ratePerMinute: 6,
      burst: 1,
      ...boundedBy(15_000),
      now: clock.now,
      schedule: clock.schedule,
    });
    expect(pacer.maxWaitMs).toBe(15_000);

    const admissions = Array.from({ length: 4 }, () => track(clock, pacer.admit()));
    await flush();

    const refusals = admissions
      .map(entry => entry.admission())
      .filter((value): value is Extract<UpgradeAdmission, { kind: 'refused' }> =>
        value?.kind === 'refused');
    expect(refusals.length).toBeGreaterThan(0);

    for (const refusal of refusals) {
      // The deficit is still reported honestly; only the hint is capped.
      expect(refusal.requiredWaitMs).toBeGreaterThan(pacer.maxWaitMs);
      expect(refusal.retryAfterSeconds).toBe(15);
    }
  });

  it('never asks for zero seconds when the bound is under a second', async () => {
    // A sub-second bound is where flooring to whole seconds would produce
    // `retry-after: 0` — retry immediately, burning the retry budget in
    // milliseconds. 10s deadline funds a 666ms bound.
    const clock = new TestClock();
    const pacer = new WsUpgradePacer({
      ratePerMinute: 60,
      burst: 1,
      idleTimeoutMs: 10_000,
      maxRetries: 2,
      now: clock.now,
      schedule: clock.schedule,
    });
    expect(pacer.maxWaitMs).toBe(666);

    const admissions = Array.from({ length: 6 }, () => track(clock, pacer.admit()));
    await flush();
    const refusals = admissions
      .map(entry => entry.admission())
      .filter((value): value is Extract<UpgradeAdmission, { kind: 'refused' }> =>
        value?.kind === 'refused');

    expect(refusals.length).toBeGreaterThan(0);
    for (const refusal of refusals) {
      expect(refusal.retryAfterSeconds).toBe(1);
    }
  });

  it.each([1, 2])(
    'admits late instead of failing fast at %i new connections per minute',
    async ratePerMinute => {
      // REGRESSION for the second failure the cap introduced. At 1/minute the
      // first token is 60s away, but six attempts four seconds apart are all
      // spent inside 20s — so every refused request exhausted its retries
      // before a token could exist and died as a rate-limit error, which is the
      // exact failure this feature exists to reduce. Measured against the real
      // SDK: 10 of 10 terminal at both rates.
      //
      // Both rates are documented as supported (README: 1-600).
      const clock = new TestClock();
      const pacer = new WsUpgradePacer({
        ratePerMinute,
        now: clock.now,
        schedule: clock.schedule,
      });
      expect(pacer.maxWaitMs).toBeGreaterThan(0);

      const admissions = Array.from({ length: 20 }, () => track(clock, pacer.admit()));
      await flush();
      await clock.advance(pacer.maxWaitMs);

      // Nothing is refused, because a refusal here could not be retried into
      // an admission before the request's deadline.
      expect(admissions.some(entry => entry.state() === 'refused')).toBe(false);
      expect(admissions.every(entry => entry.state() === 'admitted')).toBe(true);
      expect(clock.pending).toBe(0);

      // ...but this is NOT the same as pacing switched off. The burst is still
      // shaped: the first arrival past it waits out the whole bound, and only
      // the ones past the debt floor go straight through. Without this, zeroing
      // the refill rate here would be indistinguishable from disabled pacing.
      const delayed = admissions.filter(entry => (entry.settledAt() ?? 0) > 0);
      expect(delayed).toHaveLength(1);
      expect(delayed[0]!.settledAt()).toBe(pacer.maxWaitMs);
      expect(admissions.filter(entry => entry.settledAt() === 0)).toHaveLength(19);
    },
  );

  it.each([
    // [bound, maxRetries, rate, canRefuse] — the shipped budget AND a
    // user-shortened one. Every committed case used to be the shipped 4833ms
    // bound with five retries, so a rule that ignored the budget entirely
    // (`ratePerMinute >= 3`) passed the whole suite while recreating the
    // terminal-failure defect under CLODEX_UPSTREAM_IDLE_TIMEOUT_MS=10000.
    [4_833, 5, 60, true],    // shipped defaults
    [4_833, 5, 3, true],     // lowest rate the shipped budget can still serve
    [4_833, 5, 2, false],
    [4_833, 5, 1, false],
    [666, 2, 3, false],      // 10s budget: schedule 2s vs a 20s refill
    [666, 2, 29, false],     // still short of the threshold
    [666, 2, 30, true],      // exactly at it: schedule 2s vs a 2s refill
    [666, 2, 60, true],
    [15_000, 1, 4, true],    // 15s schedule vs a 15s refill
    [15_000, 1, 3, false],   // 15s schedule vs a 20s refill
  ])(
    'decides refusability from the whole budget: bound=%i retries=%i rate=%i -> %s',
    (bound, maxRetries, rate, expected) => {
      expect(canRefuseAtRate(bound, maxRetries, rate)).toBe(expected);
    },
  );

  it.each([
    // The same thing behaviourally, on a NON-default budget, because a truth
    // table over the helper cannot prove the constructor consults it.
    [3, false],
    [30, true],
  ])('honours a shortened deadline when deciding to refuse (rate %i)', async (rate, refuses) => {
    const clock = new TestClock();
    const pacer = new WsUpgradePacer({
      ratePerMinute: rate,
      burst: 1,
      idleTimeoutMs: 10_000,
      maxRetries: 2,
      now: clock.now,
      schedule: clock.schedule,
    });
    expect(pacer.maxWaitMs).toBe(666);

    const admissions = Array.from({ length: 6 }, () => track(clock, pacer.admit()));
    await flush();
    await clock.advance(pacer.maxWaitMs);

    expect(admissions.some(entry => entry.state() === 'refused')).toBe(refuses);
  });

  it('still refuses at the shipped rate, where a retry can outlast a refill', () => {
    // The guard above must not disable refusals at the default. One token per
    // second is well inside a 5-retry schedule ~4s apart.
    expect(canRefuseAtRate(4_833, 5, DEFAULT_WS_NEW_CONNECTIONS_PER_MIN)).toBe(true);
    expect(refusalScheduleMs(4_833, 5)).toBe(20_000);
    // ...and must disable them where it cannot.
    expect(canRefuseAtRate(4_833, 5, 1)).toBe(false);
    expect(canRefuseAtRate(4_833, 5, 2)).toBe(false);
    // Retries off means nothing would retry a refusal at any rate.
    expect(canRefuseAtRate(4_833, 0, 60)).toBe(false);
  });

  it('does not let a rate notice suppress the notice that pacing turned itself off', () => {
    // The two notices shared one dedupe set keyed by an ARBITRARY environment
    // string, so a rate value spelled like the disabled key silenced the one
    // notice that must never go missing. Namespaced keys keep them apart.
    resetWsUpgradePacerForTests();
    const notices: string[] = [];
    const release = installParentNoticeSink(line => { notices.push(line); });
    try {
      // Crafted to collide with the disabled notice's `${retries}:${idle}` key.
      expect(wsNewConnectionsPerMinute({
        [WS_NEW_CONNECTIONS_PER_MIN_ENV]: 'disabled:3:14001',
      })).toBe(DEFAULT_WS_NEW_CONNECTIONS_PER_MIN);
      expect(notices.some(line => line.includes('ignoring'))).toBe(true);

      const pacer = withUpstreamEnv(
        { [UPSTREAM_IDLE_TIMEOUT_ENV]: '14001' },
        () => new WsUpgradePacer(),
      );
      expect(pacer.maxWaitMs).toBe(0);
    } finally {
      release();
    }
    expect(notices.some(line => line.includes('not pacing new OpenAI connections'))).toBe(true);
  });

  it('refuses only past a large simultaneous fan-out at the shipped defaults', async () => {
    // Reachability, measured rather than argued. This is where a user first
    // meets a refusal, and it is NOT out of reach: 15 simultaneous agents is
    // inside the many-agent workload this feature targets. #171's five-retry
    // default tightens the bound and moves the threshold down from 26 to 15,
    // so the rebase made refusals easier to reach, not harder.
    const clock = new TestClock();
    const pacer = withUpstreamEnv(
      {},
      () => new WsUpgradePacer({ now: clock.now, schedule: clock.schedule }),
    );
    const admissions = Array.from({ length: 30 }, () => track(clock, pacer.admit()));
    await flush();

    expect(admissions.findIndex(entry => entry.state() === 'refused')).toBe(14);
    expect(admissions.slice(0, 14).some(entry => entry.state() === 'refused')).toBe(false);
  });

  it('shapes 25 connections and then stops, with retries turned off', async () => {
    // With retries off the ladder costs nothing, so the bound is the flat
    // ceiling and the shaped burst is the doc's `burst + bound x refill` = 25.
    // Pinned because the bound now differs between this mode and the default.
    const clock = new TestClock();
    const pacer = withUpstreamEnv(
      { [UPSTREAM_MAX_RETRIES_ENV]: '0' },
      () => new WsUpgradePacer({ now: clock.now, schedule: clock.schedule }),
    );
    expect(pacer.maxWaitMs).toBe(WS_NEW_CONNECTION_MAX_WAIT_CEILING_MS);

    const admissions = Array.from({ length: 40 }, () => track(clock, pacer.admit()));
    await flush();
    await clock.advance(pacer.maxWaitMs);

    expect(admissions.every(entry => entry.state() === 'admitted')).toBe(true);
    expect(admissions.filter(entry => (entry.settledAt() ?? 0) > 0)).toHaveLength(15);
  });

  it('stops pacing rather than holding a request its deadline cannot fund', async () => {
    // 14001ms funds a three-retry ladder costing 14000ms. There is 1ms left, so
    // there is no room to queue: pacing off is the only safe reading.
    const pacer = withUpstreamEnv(
      { [UPSTREAM_IDLE_TIMEOUT_ENV]: '14001' },
      () => new WsUpgradePacer(),
    );
    expect(pacer.maxWaitMs).toBe(0);

    // Degrading means admitting without delay, never refusing everything past
    // the burst and never queueing past the deadline.
    const clock = new TestClock();
    const disabled = withUpstreamEnv(
      { [UPSTREAM_IDLE_TIMEOUT_ENV]: '14001' },
      () => new WsUpgradePacer({ now: clock.now, schedule: clock.schedule }),
    );
    const admissions = await Promise.all(
      Array.from({ length: 50 }, () => disabled.admit()),
    );
    expect(admissions.every(entry => entry.kind === 'admitted' && entry.waitedMs === 0)).toBe(true);
    expect(clock.pending).toBe(0);
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
    expect(admissions[10]!.admission()).toEqual(admitted(1_000, true));
    expect(admissions[11]!.state()).toBe('pending');

    await clock.advance(1_000);
    expect(admissions[11]!.admission()).toEqual(admitted(2_000, true));

    await clock.advance(1_000);
    expect(admissions[12]!.admission()).toEqual(admitted(3_000, true));
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

    expect(admissions[0]!.admission()).toEqual(admitted(0, false));
    // The deficit is 3s but the bound is 2s, and the SDK spends this hint
    // INSTEAD of its own backoff rung — so the hint is capped at the bound
    // while `requiredWaitMs` still reports the deficit honestly.
    expect(admissions[3]!.admission()).toEqual({
      kind: 'refused', requiredWaitMs: 3_000, retryAfterSeconds: 2,
    });
    expect(admissions[4]!.admission()).toEqual({
      kind: 'refused', requiredWaitMs: 3_000, retryAfterSeconds: 2,
    });

    await clock.advance(2_000);
    // The two that fitted inside the bound were queued, not refused.
    expect(admissions[1]!.admission()).toEqual(admitted(1_000, true));
    expect(admissions[2]!.admission()).toEqual(admitted(2_000, true));
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
    expect(retried.admission()).toEqual(admitted(0, false));
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
    expect(next.admission()).toEqual(admitted(1_000, true));
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
    expect(follower.admission()).toEqual(admitted(2_000, true));
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
    expect(next.admission()).toEqual(admitted(0, false));
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
  it('returns a released token to the bucket, and only once', async () => {
    // A caller admitted for a connection it then does not open — the head it
    // needed freed up while it was queued — hands the token back, exactly as a
    // cancellation does. Holding it would pace the next request against an
    // upgrade that never happened.
    const clock = new TestClock();
    const pacer = new WsUpgradePacer({
      ratePerMinute: 60,
      burst: 2,
      ...boundedBy(15_000),
      now: clock.now,
      schedule: clock.schedule,
    });

    const first = track(clock, pacer.admit());
    const second = track(clock, pacer.admit());
    await flush();
    expect(first.admission()).toEqual(admitted(0, false));
    expect(second.admission()).toEqual(admitted(0, false));

    // Both tokens are spent; a third arrival would have to queue for one.
    (first.admission() as { release: () => void }).release();
    // A second call must mint nothing: that would raise the sustained rate
    // rather than correct it.
    (first.admission() as { release: () => void }).release();

    const third = track(clock, pacer.admit());
    await flush();
    // The one returned token covers this arrival with no delay ...
    expect(third.admission()).toEqual(admitted(0, false));

    const fourth = track(clock, pacer.admit());
    await flush();
    // ... and there is no second one, so this waits out a refill.
    expect(fourth.state()).toBe('pending');
    await clock.advance(1_000);
    expect(fourth.admission()).toEqual(admitted(1_000, true));
  });

  it('returns a queued admission\'s token, and only the fraction it debited', async () => {
    // The release above is taken on the immediate path, which debits a whole
    // token. Production's interesting case is the other one: a QUEUED admission,
    // and — once the bucket is against its debt floor — one that could only
    // debit a FRACTION of a token. Refunding a whole one there would mint
    // capacity the bucket never charged, which raises the sustained rate rather
    // than correcting it.
    const clock = new TestClock();
    // maxRetries 0 means nothing is ever refused, so overflow is shaped by the
    // debt floor instead — the only path that debits a fraction.
    const pacer = new WsUpgradePacer({
      ratePerMinute: 60,
      burst: 1,
      idleTimeoutMs: 9_667,
      maxRetries: 0,
      now: clock.now,
      schedule: clock.schedule,
    });
    // Bound 4833ms at one token per second, so the floor is 4.833 tokens down.
    expect(pacer.maxWaitMs).toBe(4_833);

    // Six reservations taken in one tick: the burst, four whole-token debits,
    // and a sixth that finds only 0.833 of a token above the floor.
    const admissions = Array.from({ length: 6 }, () => track(clock, pacer.admit()));
    await flush();
    await clock.advance(4_833);
    expect(admissions[0]!.admission()).toEqual(admitted(0, false));
    const fractional = admissions[5]!.admission();
    expect(fractional).toEqual(admitted(4_833, true));

    // It waited, then opened nothing, so it hands back what it took.
    (fractional as { release: () => void }).release();

    // 4900ms after those reservations the bucket has refilled 4.9 tokens. On top
    // of the 0.833 returned that is 0.9 — still short of one, so the next
    // arrival waits. A whole token returned instead would have made it 1.067,
    // capped to a full token, and this would have been admitted immediately:
    // one connection the configured rate never authorized.
    await clock.advance(4_900 - clock.time);
    const next = track(clock, pacer.admit());
    await flush();
    expect(next.state()).toBe('pending');
    await clock.advance(200);
    expect(next.admission()).toMatchObject({ kind: 'admitted', queued: true });
  });

  it('reports a request as queued even when the clock steps backwards', async () => {
    // `waitedMs` is a difference of two clock reads. A machine that adjusts its
    // clock backwards mid-wait reports 0 for a request that really was parked
    // on the bucket, so a caller deciding what to re-check after the wait has
    // to read the flag rather than the number.
    const clock = new TestClock();
    let skewMs = 0;
    const pacer = new WsUpgradePacer({
      ratePerMinute: 60,
      burst: 1,
      ...boundedBy(15_000),
      now: () => clock.time + skewMs,
      schedule: clock.schedule,
    });

    track(clock, pacer.admit());
    await flush();
    const queued = track(clock, pacer.admit());
    await flush();
    expect(queued.state()).toBe('pending');

    skewMs = -5_000;
    await clock.advance(1_000);
    // Really queued for a second; reports zero elapsed, and says so.
    expect(queued.admission()).toEqual(admitted(0, true));
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
