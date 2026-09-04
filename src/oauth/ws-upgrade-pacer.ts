// ws-upgrade-pacer.ts — client-side pacing for NEW ChatGPT/Codex Responses
// WebSocket connections.
//
// OpenAI's edge rejects a Responses WebSocket upgrade with HTTP 403, and in the
// traffic sampled below those rejections clustered in the minutes that opened
// the most new connections. `responses-websocket.ts` already handles the
// rejection — every upgrade 403 becomes a retryable 429 carrying a backoff hint
// — but nothing limited how fast clodex asked for new connections. This module
// shapes that rate on the assumption, not the proof, that it is what the edge
// is reacting to. A request that reuses an existing chain head never comes here.
//
// Why these numbers. Measured by re-reading one machine's own
// `ws_head_decision` diagnostics log (103,698 records spanning roughly a day
// and a half), bucketing new connections — records carrying a
// `createdConnectionId` — by wall-clock minute:
//
//   * 1,158 minutes opened at least one connection. Median 6, 90th percentile
//     22, 99th percentile 48, maximum 82. Four minutes exceeded 60.
//   * All 40 upgrade rejections fell in three of those minutes. 39 of them fell
//     in the two minutes that each opened 82, and the fortieth in a minute that
//     opened 41.
//   * On a 200k-line slice of the same log, 11,417 of 26,430 head decisions
//     opened a connection and 10,229 of those were the non-reusable parallel
//     fan-out kind, so new connections move with the number of concurrent
//     agents rather than with conversation length.
//
// Scope: one account, one machine, one contiguous window. The predicate is
// `createdConnectionId != null` on `ws_head_decision`, which counts PRIMARY
// connections only — the two replacement paths emit no head decision, so they
// appear in none of these figures.
//
// Read this as a correlation in one account's traffic over one window, not as a
// published limit or a demonstrated cause: the rejections cluster in the
// highest-rate minutes, and the instantaneous rate was 3-5/second in those
// minutes and in quiet ones alike, which is why the limiter shapes a sustained
// rate rather than a burst. A single 41/minute rejection sits outside that
// pattern and is unexplained.

import { emitParentNotice } from '../parent-notice.js';
import { clampRetryAfterSeconds } from '../upstream-error.js';
import { upstreamMaxRetries } from '../upstream-retry.js';

export const WS_NEW_CONNECTIONS_PER_MIN_ENV = 'CLODEX_WS_MAX_NEW_CONNECTIONS_PER_MIN';

/**
 * Sustained ceiling on new connections, per minute. It sits between the 99th
 * percentile of observed per-minute demand (48) and the two minutes in which 39
 * of the 40 rejections were observed (82 each). Those minutes are where the
 * rejections fell; that they were caused by the rate is the working assumption
 * this module is built on, not a finding.
 *
 * Do not read that as "rarely engages". Only four of the 1,158 observed active
 * minutes exceeded 60 overall, but the limiter also holds requests whenever the
 * burst allowance is spent WITHIN a minute, which heavy fan-out does routinely.
 * One connection per second is a real aggregate ceiling: by Little's law, N
 * agents that each need a new connection per turn settle at about N seconds per
 * turn once the burst is gone — roughly 20s per turn at 20 agents, against ~3s
 * unpaced. That trade is the feature: throughput for not tripping the throttle.
 */
export const DEFAULT_WS_NEW_CONNECTIONS_PER_MIN = 60;

/**
 * Sanity bound on the configured rate, not a measured threshold. Ten per second
 * is far above anything in the sample; a value that large leaves the bucket
 * effectively open, which is what `0` is for.
 */
export const MAX_WS_NEW_CONNECTIONS_PER_MIN = 600;

/**
 * Connections opened with no delay at all after an idle stretch. Sized to the
 * observed concurrency rather than to the instantaneous rate: connections peaked
 * at 13 with no capacity evictions, while the 3-5/second instantaneous rate was
 * the same in rejecting and quiet minutes alike and so distinguishes nothing. A
 * fan-out of up to ten subagents is therefore admitted without waiting, provided
 * the bucket has had ten seconds to refill.
 */
export const WS_NEW_CONNECTION_BURST = 10;

/** No single request is queued longer than this, whatever the arithmetic says. */
export const WS_NEW_CONNECTION_MAX_WAIT_CEILING_MS = 15_000;

/**
 * The no-data deadline the pacer assumes for the request it is holding.
 *
 * The pacer does not read the resolved deadline: on this branch the translated
 * streaming paths use a fixed 120 seconds, and it is not exposed. Callers may
 * pass the real value through `idleTimeoutMs`, which is the seam to wire up
 * once that budget becomes configurable.
 */
export const ASSUMED_UPSTREAM_IDLE_TIMEOUT_MS = 120_000;

/** The AI SDK's own default when clodex does not override it. */
export const SDK_DEFAULT_MAX_RETRIES = 2;

/**
 * Retry attempts the bound has to cover.
 *
 * Read, never assumed. A hardcoded guess would make this feature's correctness
 * depend on merge order against any change to the retry default: too low and
 * the ladder overruns the deadline, too high and the bound shrinks for no
 * reason. `upstreamMaxRetries` returns undefined when nothing overrides the
 * SDK, which is the SDK's own default of two.
 */
export function resolvedUpstreamMaxRetries(): number {
  return upstreamMaxRetries() ?? SDK_DEFAULT_MAX_RETRIES;
}

/** First step of the AI SDK's backoff ladder; each later step doubles. */
const SDK_INITIAL_BACKOFF_MS = 2_000;

/**
 * Longest a single request may be queued, given the budget it is spending.
 *
 * Every attempt of one request shares ONE no-data deadline — the timer starts
 * before the SDK call and is only reset by a stream part — so the whole retry
 * ladder has to fit inside it:
 *
 *     (maxRetries + 1) x bound + totalBackoff < idleTimeout
 *
 * At a 120s deadline and five retries the ladder alone is 2+4+8+16+32 = 62s,
 * leaving 58s for six attempts. Half of that is reserved for the provider's own
 * first byte, so the bound is ~4.8s. A flat 15s bound would instead allow six
 * attempts plus backoff to reach 152s against a 120s deadline — not a certain
 * timeout, since an attempt need not spend its whole bound, but a ceiling that
 * no longer fits the budget. Reserving time cannot GUARANTEE the ladder
 * completes either: first-byte latency is unbounded within the deadline.
 *
 * `totalBackoffMs` is the SDK's own exponential ladder, which is what it uses
 * when a failure carries no `Retry-After`. A refusal from this module DOES carry
 * one, and `getRetryDelayInMs` prefers the header whenever it is under a minute
 * — so the real delay between paced attempts is the header value, not this
 * ladder. The exponential figure is therefore the conservative term: it is an
 * upper bound on the pacing case and the exact term for every other retryable
 * failure sharing the same deadline.
 *
 * `idleTimeoutMs` is assumed rather than read — the translated streaming paths
 * use a fixed 120s on this branch and do not expose it — while `maxRetries` is
 * read, because clodex's retry default is the term most likely to change.
 */
export function wsNewConnectionMaxWaitMs(
  idleTimeoutMs: number,
  maxRetries: number,
): number {
  // Total, on every input. A NaN reaching the bound would make every
  // `waitMs > maxWaitMs` comparison false, which fails open into unbounded
  // waits — the one failure this bound exists to prevent.
  if (!Number.isFinite(idleTimeoutMs) || !Number.isFinite(maxRetries)
    || idleTimeoutMs <= 0 || maxRetries < 0) {
    return 0;
  }
  const attempts = maxRetries + 1;
  const totalBackoffMs = SDK_INITIAL_BACKOFF_MS * (2 ** maxRetries - 1);
  const shareableMs = Math.max(0, idleTimeoutMs - totalBackoffMs) / 2;
  const bound = Math.floor(shareableMs / attempts);
  return Number.isFinite(bound)
    ? Math.min(WS_NEW_CONNECTION_MAX_WAIT_CEILING_MS, Math.max(0, bound))
    : 0;
}

/** Outcome of asking the pacer for permission to open a new connection. */
export type UpgradeAdmission =
  | {
    kind: 'admitted';
    /** Milliseconds spent queued. 0 means admitted on arrival. */
    waitedMs: number;
  }
  | {
    kind: 'refused';
    /** What the rate would have required, before the bound refused it. */
    requiredWaitMs: number;
    /** Backoff hint for the client, in seconds. */
    retryAfterSeconds: number;
  };

export interface ConnectionPacer {
  admit(signal?: AbortSignal): Promise<UpgradeAdmission>;
}

export interface WsUpgradePacerOptions {
  /** New connections per minute; 0 disables pacing entirely. */
  ratePerMinute?: number;
  burst?: number;
  /** No-data deadline the queued request is spending. */
  idleTimeoutMs?: number;
  /** Retry attempts that deadline has to cover. */
  maxRetries?: number;
  now?: () => number;
  /** Runs `fire` after `ms`; returns a cancel function. Injected by tests. */
  schedule?: (ms: number, fire: () => void) => () => void;
}

type Reservation =
  | { admitted: true; waitMs: number; consumed: number }
  | { admitted: false; requiredWaitMs: number };

function defaultSchedule(ms: number, fire: () => void): () => void {
  // Deliberately not unref'd: an in-flight request must keep the process alive
  // for as long as it is queued, exactly as it does while it is on the wire.
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
}

/**
 * Mirrors `streamAbortError` in sdk-adapter.ts: an Error reason is the caller's
 * own error and is surfaced unchanged; anything else becomes a named
 * AbortError, which the AI SDK recognizes and never retries.
 */
function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal?.reason === 'string' ? signal.reason : 'WebSocket connection pacing aborted',
  );
  error.name = 'AbortError';
  return error;
}

const reportedRates = new Set<string>();

function reportOnce(raw: string, message: string, warn: (message: string) => void): void {
  if (reportedRates.has(raw)) return;
  reportedRates.add(raw);
  try {
    warn(message);
  } catch {
    // A diagnostic must never turn a pacing setting into a request failure.
  }
}

/**
 * Token bucket over new-connection creation.
 *
 * Admission is decided by one synchronous reservation — refill, read, debit —
 * so concurrent callers can never interleave inside it and each leaves holding
 * its own deadline. Ordering therefore follows arrival order without a queue to
 * scan, and nothing is held across the `await`.
 *
 * A request the rate cannot serve within the bound is REFUSED rather than
 * queued longer or admitted anyway. Admitting anyway was tried first and does
 * not work: with the bound also acting as the debt floor, sustained output
 * settles at exactly the offered rate delayed by the bound, so a 82/min fan-out
 * still went out at 82/min and simply arrived 15 seconds later. Refusing sheds
 * that overflow instead, in the same retryable 429 shape the upgrade 403
 * already produces today — the shape the client is known to handle.
 *
 * Refusing is not free. The retry it provokes backs off INSIDE the same no-data
 * deadline a queue wait would have spent, which is why `wsNewConnectionMaxWaitMs`
 * budgets the whole ladder rather than one wait.
 *
 * A refusal deliberately debits NOTHING. That is what makes the retry ladder
 * safe: a refused request opens no connection, and while retries remain it will
 * be retried — so charging it a token would let every retry deepen the deficit
 * that caused the refusal and the ladder could never recover. A refusal on the
 * FINAL attempt is terminal and surfaces to the user as a rate limit, which is
 * why the bound is sized so the whole ladder fits the deadline. Because only an
 * admitted request debits, and a request is only admitted when it needs at most
 * `maxWaitMs`, `tokens` can never fall below `-maxWaitMs x refillPerMs`. The
 * queue is therefore bounded by construction, every queued request drains within
 * the bound, and — while refusals are available, i.e. with retries enabled —
 * admissions in any window T are at most `burst + maxWaitMs x refillPerMs +
 * rate x T + cancellations` however many retries arrive. With retries disabled
 * nothing is refused, so only the opening burst is shaped and that bound does
 * not hold.
 *
 * Two caveats on that bound, both real:
 *
 *   * It counts ADMISSIONS, not sockets. A transport retry and a
 *     `previous_response_not_found` retry each build a replacement connection
 *     through `createReplacement`, which does not consult the pacer, so
 *     connections opened can exceed admissions granted.
 *   * A cancellation refunds its token but does not reschedule the reservations
 *     already queued behind it, so a later arrival can take the vacated slot
 *     alongside them. Each cancellation therefore permits one extra admission
 *     at that instant. It cannot reorder admissions, only coalesce them.
 *
 * The bound is also on reservations, not on wall-clock departures: a stalled
 * event loop releases overdue timers together, and the pacer neither observes
 * that nor corrects for it.
 */
export class WsUpgradePacer implements ConnectionPacer {
  /** Longest any one request will be queued. Derived; exposed for diagnostics. */
  readonly maxWaitMs: number;
  private readonly enabled: boolean;
  private readonly refillPerMs: number;
  private readonly capacity: number;
  private readonly canRefuse: boolean;
  private readonly maxDebt: number;
  private readonly now: () => number;
  private readonly schedule: (ms: number, fire: () => void) => () => void;
  private tokens: number;
  private lastRefillAt: number;

  constructor(options: WsUpgradePacerOptions = {}) {
    const ratePerMinute = options.ratePerMinute ?? DEFAULT_WS_NEW_CONNECTIONS_PER_MIN;
    const burst = options.burst ?? WS_NEW_CONNECTION_BURST;
    const maxRetries = options.maxRetries ?? resolvedUpstreamMaxRetries();
    this.maxWaitMs = wsNewConnectionMaxWaitMs(
      options.idleTimeoutMs ?? ASSUMED_UPSTREAM_IDLE_TIMEOUT_MS,
      maxRetries,
    );
    // A bound of zero means the deadline has no room to queue anything, so
    // pacing would degenerate into refusing everything past the burst. Not
    // pacing at all is the safer reading of that configuration.
    const rateRequested = Number.isFinite(ratePerMinute) && ratePerMinute > 0;
    this.enabled = rateRequested && this.maxWaitMs > 0;
    if (rateRequested && !this.enabled) {
      // Turning itself off on a seam is the one failure mode nobody would
      // notice, so it is never silent.
      reportOnce(
        `disabled:${maxRetries}`,
        `not pacing new OpenAI connections: a ${maxRetries}-retry budget leaves no room to `
        + 'queue inside the request deadline',
        message => emitParentNotice(`clodex: ${message}`),
      );
    }
    // A refusal is only safe when something will retry it. With retries turned
    // off the SDK rethrows before it ever consults `shouldRetry`, so a refusal
    // would become an immediate hard failure — the opposite of the point. Wait
    // out the bound and open the connection instead.
    this.canRefuse = maxRetries > 0;
    this.refillPerMs = this.enabled ? ratePerMinute / 60_000 : 0;
    this.capacity = Number.isFinite(burst) ? Math.max(1, burst) : WS_NEW_CONNECTION_BURST;
    this.maxDebt = this.maxWaitMs * this.refillPerMs;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
    this.tokens = this.capacity;
    this.lastRefillAt = this.now();
  }

  /**
   * Resolves when this request may open a new connection, or resolves to a
   * refusal the caller must report as a retryable rate limit. Callers that
   * reuse an existing connection must not call this at all.
   */
  async admit(signal?: AbortSignal): Promise<UpgradeAdmission> {
    if (!this.enabled) return { kind: 'admitted', waitedMs: 0 };
    // A request whose consumer is already gone must not spend a token, and must
    // not be parked on a listener an aborted signal will never fire.
    if (signal?.aborted) throw abortError(signal);

    const reservation = this.reserve(this.now());
    if (!reservation.admitted) {
      return {
        kind: 'refused',
        requiredWaitMs: reservation.requiredWaitMs,
        // Round UP, so the retry lands after a token exists rather than a
        // fraction of a second before it.
        retryAfterSeconds: clampRetryAfterSeconds(
          Math.max(1, Math.ceil(reservation.requiredWaitMs / 1_000)),
        ),
      };
    }
    if (reservation.waitMs <= 0) return { kind: 'admitted', waitedMs: 0 };

    const startedAt = this.now();
    try {
      await this.sleep(reservation.waitMs, signal);
    } catch (error) {
      // A cancelled request opens no connection, so its reservation goes back
      // rather than pacing someone else against an upgrade that never happened.
      this.refund(reservation.consumed);
      throw error;
    }
    return { kind: 'admitted', waitedMs: Math.max(0, this.now() - startedAt) };
  }

  private reserve(now: number): Reservation {
    // A clock that moves backwards refills nothing rather than draining.
    const elapsed = Math.max(0, now - this.lastRefillAt);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillAt = now;
    const waitMs = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillPerMs);
    if (waitMs > this.maxWaitMs) {
      if (this.canRefuse) return { admitted: false, requiredWaitMs: waitMs };
      // Nothing would retry a refusal here, so this must admit. Shape the
      // opening burst — the part that correlates with rejection — and then stop
      // once the debt floor is reached: past it, delaying every request by the
      // bound shapes NOTHING (sustained output would equal sustained input,
      // merely late) and only taxes the user. `consumed` is zero exactly at the
      // floor, which is the signal that shaping has run out.
      const before = this.tokens;
      this.tokens = Math.max(-this.maxDebt, this.tokens - 1);
      const consumed = before - this.tokens;
      return { admitted: true, waitMs: consumed > 0 ? this.maxWaitMs : 0, consumed };
    }
    this.tokens -= 1;
    return { admitted: true, waitMs, consumed: 1 };
  }

  private refund(consumed: number): void {
    this.tokens = Math.min(this.capacity, this.tokens + consumed);
  }

  /**
   * INVARIANT REQUIRED OF FUTURE EDITS: `admit` must reject an aborted signal
   * before reaching here, and nothing may be awaited between that check and
   * this call. An abort arriving in such a window would leave the request
   * parked on a listener an already-aborted signal never fires, and it would
   * wait out the full duration. There is deliberately no second check here to
   * catch that, because an untested guard is not a guarantee.
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let cancelTimer: (() => void) | undefined;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cancelTimer?.();
        reject(abortError(signal));
      };
      const fire = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      cancelTimer = this.schedule(ms, fire);
      // The schedule implementation may have fired synchronously.
      if (settled) cancelTimer();
    });
  }
}

/**
 * Optional override for the sustained new-connection rate. `0` turns pacing
 * off; a malformed value leaves the default in control rather than failing the
 * request that happened to read it.
 */
export function wsNewConnectionsPerMinute(
  env: NodeJS.ProcessEnv = process.env,
  // emitParentNotice rather than console.error: this fires from a request while
  // `clodex claude` has the parent's stdout/stderr muted for Claude Code's TUI.
  warn: (message: string) => void = message => emitParentNotice(`clodex: ${message}`),
): number {
  const raw = env[WS_NEW_CONNECTIONS_PER_MIN_ENV]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_WS_NEW_CONNECTIONS_PER_MIN;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    reportOnce(
      raw,
      `ignoring ${WS_NEW_CONNECTIONS_PER_MIN_ENV}=${raw} `
      + `(expected a non-negative integer; using ${DEFAULT_WS_NEW_CONNECTIONS_PER_MIN})`,
      warn,
    );
    return DEFAULT_WS_NEW_CONNECTIONS_PER_MIN;
  }
  if (value > MAX_WS_NEW_CONNECTIONS_PER_MIN) {
    reportOnce(
      raw,
      `clamping ${WS_NEW_CONNECTIONS_PER_MIN_ENV}=${raw} to ${MAX_WS_NEW_CONNECTIONS_PER_MIN} `
      + '(a higher rate shapes nothing OpenAI throttles on)',
      warn,
    );
    return MAX_WS_NEW_CONNECTIONS_PER_MIN;
  }
  return value;
}

let sharedPacer: ConnectionPacer | undefined;

/**
 * The process-wide pacer.
 *
 * Shared rather than per-transport for the same reason the connection pools
 * are: the throttle is the account's, and the server keeps a separate
 * transport per model, so a per-transport bucket would multiply the rate by the
 * number of models in play. A multi-account process shares one bucket and is
 * therefore paced more conservatively than it strictly needs to be.
 */
export function sharedWsUpgradePacer(): ConnectionPacer {
  sharedPacer ??= new WsUpgradePacer({ ratePerMinute: wsNewConnectionsPerMinute() });
  return sharedPacer;
}

/** Test-only: drop the shared bucket's accumulated state and re-read the env. */
export function resetWsUpgradePacerForTests(): void {
  sharedPacer = undefined;
  reportedRates.clear();
}
