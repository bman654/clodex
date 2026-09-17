// src/wrapper-env.ts
//
// Pure env computation for the `clodex-claude` wrapper bin. Given the process
// env and a live `clodex server` runtime state (or null), returns the env to
// launch the Claude Code binary with. Kept dependency-free so the wrapper
// stays tiny and fast — it runs for every Claude-Code-spawned agent process.

import type { ServerRuntimeState } from './server-runtime.js';
import {
  networkEnvBaseline,
  PROXY_ENV_VARS,
  recordNetworkEnvMutation,
} from './network-env.js';

export const REQUIRE_SERVER_ENV = 'CLODEX_REQUIRE_SERVER';

/**
 * Whether the wrapper's spawn fallback needs a shell for `target` on `platform`.
 *
 * Only Windows, and only for `.cmd`/`.bat` launcher scripts: Node refuses to spawn those without
 * a shell (the `spawn EINVAL` class), and cmd.exe is their interpreter. A native executable — the
 * `claude.exe` the VS Code extension hands the wrapper, or the npm package's own `bin/claude.exe` —
 * must be spawned directly, because a shell hop through cmd.exe rewrites the arguments Claude Code
 * is given (`%VAR%` expansion, quote and metacharacter handling), and the extension passes JSON,
 * quoted and empty arguments that have to arrive untouched.
 *
 * npm's other two Windows shims are out of reach either way: the `.ps1` needs PowerShell and the
 * extensionless one is a POSIX shell script, and Node can spawn neither on Windows. A
 * `CLODEX_CLAUDE_PATH` naming one of those fails at spawn; clodex's own Windows discovery selects
 * the `.cmd`.
 */
export function wrapperSpawnShell(platform: NodeJS.Platform, target: string): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(target);
}

export function removeAnthropicProxyBypass(env: NodeJS.ProcessEnv): void {
  const noProxyValues = [env['NO_PROXY'], env['no_proxy']]
    .filter((value): value is string => value !== undefined);
  if (noProxyValues.length === 0) return;

  const filtered = [...new Set(noProxyValues
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean)
    .filter(value => {
      const entry = value.toLowerCase().replace(/^https?:\/\//, '');
      const host = entry.replace(/:\d+$/, '');
      if (host === '*') return false;
      const suffix = host.startsWith('*.') ? host.slice(1) : host;
      const bypassesAnthropic = suffix.startsWith('.')
        ? 'api.anthropic.com'.endsWith(suffix)
        : 'api.anthropic.com' === suffix || 'api.anthropic.com'.endsWith(`.${suffix}`);
      return !bypassesAnthropic;
    }))]
    .join(',');
  if (filtered) {
    env['NO_PROXY'] = filtered;
    env['no_proxy'] = filtered;
  } else {
    delete env['NO_PROXY'];
    delete env['no_proxy'];
  }
}

/**
 * Any non-empty key satisfies the local endpoint gateway (`isAuthorized`
 * accepts everything when no server password is set, i.e. local listen mode).
 */
export const LOCAL_GATEWAY_API_KEY = 'clodex-local';

export function wrapperRequiresServer(env: NodeJS.ProcessEnv): boolean {
  return env[REQUIRE_SERVER_ENV] === '1';
}

/** The extension's top-level host shape, shared with missing-path handling. */
export function wrapperIsTopLevelVsCodeHost(env: NodeJS.ProcessEnv): boolean {
  return env['CLAUDE_CODE_ENTRYPOINT'] === 'claude-vscode'
    && !env['CLAUDE_CODE_CHILD_SESSION']
    && !env['CLAUDECODE'];
}

/**
 * Whether this wrapper spawn may select the manifest's verified patched install.
 *
 * Every supported platform is eligible. Windows was held back until the `windows-launcher` CI job
 * could prove the selector's file-identity checks on NTFS and drive the substitution end to end
 * through the native launcher (`tests/wrapper-substitution.windows.test.ts`); what differs there
 * now lives in `wrapper-target.ts` (`requireWrapperExecutable`), not in this gate.
 */
export function wrapperSubstitutionEligible(
  env: NodeJS.ProcessEnv,
  state: ServerRuntimeState | null,
): boolean {
  return wrapperIsTopLevelVsCodeHost(env)
    && state?.mode === 'proxy';
}

/** Main chat is the persistent SDK stream-json spawn; programmatic queries are not. */
export function wrapperInvocationIsChat(args: readonly string[]): boolean {
  const streamJson = args.some((arg, index) =>
    arg === 'stream-json'
      && (args[index - 1] === '--output-format' || args[index - 1] === '--input-format'));
  return streamJson && !args.includes('--no-session-persistence');
}

export function computeWrapperEnv(
  baseEnv: NodeJS.ProcessEnv,
  state: ServerRuntimeState | null,
): NodeJS.ProcessEnv {
  // No live server: launch claude completely untouched — a down server must
  // never break launching claude.
  if (!state) return { ...baseEnv };

  const baseline = networkEnvBaseline(baseEnv);
  const env: NodeJS.ProcessEnv = { ...baseline };

  if (state.mode === 'proxy') {
    // Selective MITM: claude keeps its own Anthropic credentials; the proxy
    // routes clodex:/alias models to OpenAI and passes everything else through.
    const proxyUrl = `http://127.0.0.1:${state.port}`;
    delete env['ANTHROPIC_BASE_URL'];
    for (const name of PROXY_ENV_VARS) env[name] = proxyUrl;
    if (state.caPath) env['NODE_EXTRA_CA_CERTS'] = state.caPath;
    removeAnthropicProxyBypass(env);
    recordNetworkEnvMutation(baseline, env);
    return env;
  }

  // Endpoint gateway: all traffic goes to the local Anthropic-format gateway.
  for (const name of PROXY_ENV_VARS) delete env[name];
  env['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${state.port}/anthropic`;
  env['ANTHROPIC_API_KEY'] = LOCAL_GATEWAY_API_KEY;
  recordNetworkEnvMutation(baseline, env);
  return env;
}
