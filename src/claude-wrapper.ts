// src/claude-wrapper.ts — the `clodex-claude` bin.
//
// A tiny, fast exec-style wrapper around the Claude Code binary that injects
// bridge env for a running standalone `clodex server` (discovered via
// ~/.clodex/server-runtime.json). Two invocation shapes:
//
//   1. CLAUDE_CODE_PROCESS_WRAPPER contract: Claude Code invokes
//      `clodex-claude <claude-binary-path> <args...>` for every process it
//      spawns (agents view sessions, background agents). First arg is the
//      claude binary to exec.
//   2. Direct terminal use: `clodex-claude [args...]` — the claude binary is
//      discovered the same way `clodex claude` discovers it
//      (CLODEX_CLAUDE_PATH override, config override, PATH, fallbacks).
//
// With a live proxy-mode server: HTTPS_PROXY/HTTP_PROXY + NODE_EXTRA_CA_CERTS
// point at it and ANTHROPIC_BASE_URL is removed (claude keeps its own
// Anthropic auth — this is the recommended mode). With a live endpoint-mode
// server: ANTHROPIC_BASE_URL points at the gateway. With no live server the
// env is passed through untouched, so claude always launches.
//
// This file must stay a thin shell over pure helpers (wrapper-env.ts,
// server-runtime.ts) with minimal imports — it runs for every spawned agent.

import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { connect } from 'node:net';
import { constants as osConstants } from 'node:os';
import {
  orderWrapperServerCandidates,
  readLiveServerRuntimeStates,
  type ServerRuntimeState,
} from './server-runtime.js';
import { computeWrapperEnv, wrapperRequiresServer } from './wrapper-env.js';
import { findClaudeBinary } from './launch.js';

const isWindows = process.platform === 'win32';

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (!isWindows) accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Fast TCP probe — the state file can outlive a SIGKILLed listener. Never hangs. */
function portIsOpen(port: number, timeoutMs = 100): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const checkOnly = argv[0] === '--check';

  let claudePath: string | null = null;
  let claudeArgs: string[] = [];
  if (checkOnly) {
    // Readiness checks validate discovery and TCP state without launching Claude.
  } else if (argv[0] && isExecutableFile(argv[0])) {
    // CLAUDE_CODE_PROCESS_WRAPPER shape: first arg is the claude binary path.
    claudePath = argv[0];
    claudeArgs = argv.slice(1);
  } else {
    claudePath = findClaudeBinary();
    claudeArgs = argv;
  }

  if (!checkOnly && !claudePath) {
    process.stderr.write('clodex-claude: could not find the claude binary (set CLODEX_CLAUDE_PATH)\n');
    process.exit(127);
  }

  // Selection policy (see orderWrapperServerCandidates): proxy-mode servers
  // are preferred over endpoint-mode ones — bridging keeps Claude Code's own
  // Anthropic auth — with newest startedAt breaking ties within a mode. The
  // first candidate whose port answers the TCP probe wins; if only an
  // endpoint server is live it is used; with none, claude launches untouched.
  let state: ServerRuntimeState | null = null;
  for (const candidate of orderWrapperServerCandidates(readLiveServerRuntimeStates())) {
    if (await portIsOpen(candidate.port)) {
      state = candidate;
      break;
    }
  }
  if (checkOnly) process.exit(state ? 0 : 1);
  if (!state && wrapperRequiresServer(process.env)) {
    process.stderr.write('clodex-claude: no live clodex server is available\n');
    process.exit(1);
  }
  const env = computeWrapperEnv(process.env, state);

  const child = spawn(claudePath!, claudeArgs, {
    stdio: 'inherit',
    env,
    shell: isWindows,
  });

  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));

  child.on('error', err => {
    process.stderr.write(`clodex-claude: failed to launch ${claudePath}: ${err.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      const signum = osConstants.signals[signal as keyof typeof osConstants.signals];
      process.exit(signum ? 128 + signum : 1);
    }
    process.exit(code ?? 0);
  });
}

void main();
