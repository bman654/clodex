// tests/helpers/exit-probe.ts
//
// Runs OUTSIDE vitest, in a plain Node process: whether a process ends by draining its event loop
// or through process.exit() is a property of a real process, and vitest's worker is not one this
// test may end. Bundled by tests/process-exit.test.ts.
//
// Contract: argv[2] is a mode, argv[3] an optional URL for the models-dev modes. The probe wraps
// process.exit so that path announces itself, and reports how the process ended on stderr:
//   EXIT-REQUESTED               just before exitAfterDrain is called
//   EXITED via=process.exit code=N afterRequestMs=T   the fallback (or any caller) used process.exit
//   EXITED via=drain code=N afterRequestMs=T          the event loop drained
// Every mode bounds itself: a probe that neither drains nor falls back is killed by the test.
import { cancelOnExit, exitAfterDrain } from '../../src/process-exit.js';
import { installOutboundDispatcher } from '../../src/outbound-proxy.js';
import { MODELS_DEV_API_URL, refreshModelsDevCacheAsync } from '../../src/registry/models-dev.js';
import { enrichPricingAsync, fetchPricingCache, PRICING_API_URL } from '../../src/registry/pricing.js';

const mode = process.argv[2] ?? '';
const upstreamUrl = process.argv[3] ?? '';
const say = (line: string) => process.stderr.write(`${line}\n`);

let viaProcessExit = false;
let requestedAt: number | undefined;
/** Measured here, not by the test: a loaded test worker can read both lines in one tick. */
const sinceRequest = () => (requestedAt === undefined ? 'n/a' : Math.round(performance.now() - requestedAt));
const realExit = process.exit.bind(process);
process.exit = ((code?: number) => {
  viaProcessExit = true;
  say(`EXITED via=process.exit code=${code} afterRequestMs=${sinceRequest()}`);
  return realExit(code);
}) as typeof process.exit;
process.on('exit', code => {
  if (!viaProcessExit) say(`EXITED via=drain code=${code} afterRequestMs=${sinceRequest()}`);
});

function requestExit(code: number, options: Parameters<typeof exitAfterDrain>[1] = {}): void {
  say('EXIT-REQUESTED');
  requestedAt = performance.now();
  exitAfterDrain(code, options);
}

/** Holds the event loop open until cleared. */
function holdLoop(): NodeJS.Timeout {
  return setInterval(() => {}, 60_000);
}

/** Point one public metadata URL at the test's server, recording that the fetch really started. */
function redirectFetch(from: string, onStart: () => void): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== from) return realFetch(input, init);
    onStart();
    const response = realFetch(upstreamUrl, init);
    void response.then(() => say('FETCH-ANSWERED'), () => {});
    return response;
  }) as typeof fetch;
}

async function run(): Promise<void> {
  switch (mode) {
    case 'drain':
      requestExit(7, { graceMs: 30_000 });
      return;
    case 'held': {
      holdLoop();
      requestExit(4, { graceMs: 300 });
      return;
    }
    case 'held-traced': {
      holdLoop();
      requestExit(4, { graceMs: 300, trace: true });
      return;
    }
    case 'cancelled': {
      const timer = holdLoop();
      cancelOnExit(() => clearInterval(timer));
      requestExit(0, { graceMs: 30_000 });
      return;
    }
    case 'unregistered': {
      // A canceller whose work already finished must not run at exit.
      const release = cancelOnExit(() => say('CANCELLER-RAN'));
      release();
      requestExit(0, { graceMs: 30_000 });
      return;
    }
    case 'cancel-after-exit': {
      requestExit(0, { graceMs: 30_000 });
      const timer = holdLoop();
      cancelOnExit(() => clearInterval(timer));
      return;
    }
    case 'first-wins':
      requestExit(3, { graceMs: 30_000 });
      exitAfterDrain(5, { graceMs: 30_000 });
      return;
    case 'models-dev-quick': {
      // A command like `models --list`: some real work, finished well before the refresh's start
      // delay. Without the delay its download would already be under way here.
      redirectFetch(MODELS_DEV_API_URL, () => say('FETCH-STARTED'));
      refreshModelsDevCacheAsync();
      await new Promise(resolve => setTimeout(resolve, 100));
      requestExit(0, { graceMs: 30_000 });
      return;
    }
    case 'models-dev-in-flight': {
      // A command still running when the refresh starts, ending while the download is in flight.
      // The CLI's own fetch dispatcher, as main() installs it, owns the connection.
      await installOutboundDispatcher();
      const started = new Promise<void>(resolve => redirectFetch(MODELS_DEV_API_URL, () => {
        say('FETCH-STARTED');
        resolve();
      }));
      refreshModelsDevCacheAsync();
      const command = holdLoop();
      await started;
      // Give the connection time to reach the test's server, which never answers (over https, it
      // never completes the TLS handshake either).
      await new Promise(resolve => setTimeout(resolve, 200));
      clearInterval(command);
      requestExit(0, { graceMs: 10_000, trace: true });
      return;
    }
    case 'pricing-in-flight': {
      // Pricing enrichment whose request is established and unanswered when the exit is requested.
      await installOutboundDispatcher();
      const started = new Promise<void>(resolve => redirectFetch(PRICING_API_URL, () => {
        say('FETCH-STARTED');
        resolve();
      }));
      // Reports only if the enrichment carried on to its registry update after the exit.
      enrichPricingAsync(updated => say(`ENRICHMENT-FINISHED updated=${updated}`));
      const command = holdLoop();
      await started;
      await new Promise(resolve => setTimeout(resolve, 200));
      clearInterval(command);
      requestExit(0, { graceMs: 10_000, trace: true });
      return;
    }
    case 'pricing-lock-contended': {
      // The pricing fetch completes; the registry lock it then needs is held by the test process.
      await installOutboundDispatcher();
      const answered = new Promise<void>(resolve => redirectFetch(PRICING_API_URL, () => {
        say('FETCH-STARTED');
        resolve();
      }));
      enrichPricingAsync(updated => say(`ENRICHMENT-FINISHED updated=${updated}`));
      const command = holdLoop();
      await answered;
      // Long enough for the answer to arrive and the enrichment to start retrying the lock.
      await new Promise(resolve => setTimeout(resolve, 300));
      clearInterval(command);
      requestExit(0, { graceMs: 5_000, trace: true });
      return;
    }
    case 'unowned-fetch-connecting': {
      // A fetch nobody aborts, with its own ref'd timeout (fetchPricingCache called without a
      // signal), still opening its connection when the exit is requested.
      await installOutboundDispatcher();
      const started = new Promise<void>(resolve => redirectFetch(PRICING_API_URL, () => {
        say('FETCH-STARTED');
        resolve();
      }));
      void fetchPricingCache().then(result => say(`FETCH-SETTLED ${result === null ? 'null' : 'data'}`));
      const command = holdLoop();
      await started;
      await new Promise(resolve => setTimeout(resolve, 200));
      clearInterval(command);
      requestExit(0, { graceMs: 10_000, trace: true });
      return;
    }
    default:
      say(`unknown mode ${mode}`);
      process.exitCode = 99;
  }
}

void run();
