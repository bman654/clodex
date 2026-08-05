// src/wrapper-env.ts
//
// Pure env computation for the `clodex-claude` wrapper bin. Given the process
// env and a live `clodex server` runtime state (or null), returns the env to
// launch the Claude Code binary with. Kept dependency-free so the wrapper
// stays tiny and fast — it runs for every Claude-Code-spawned agent process.

import type { ServerRuntimeState } from './server-runtime.js';
import {
  CHILD_NETWORK_ENV_VARS,
  ORIGINAL_NETWORK_ENV_VAR,
  PROXY_ENV_VARS,
} from './network-env.js';

export const REQUIRE_SERVER_ENV = 'CLODEX_REQUIRE_SERVER';

function hasValidOriginalNetworkSnapshot(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const allowedKeys = new Set<string>(CHILD_NETWORK_ENV_VARS);
    return Object.entries(parsed).every(([key, entry]) =>
      allowedKeys.has(key) && typeof entry === 'string');
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

function preserveOriginalNetworkEnv(env: NodeJS.ProcessEnv): void {
  if (hasValidOriginalNetworkSnapshot(env[ORIGINAL_NETWORK_ENV_VAR])) return;
  const snapshot: NodeJS.ProcessEnv = {};
  for (const name of CHILD_NETWORK_ENV_VARS) {
    if (env[name] !== undefined) snapshot[name] = env[name];
  }
  env[ORIGINAL_NETWORK_ENV_VAR] = JSON.stringify(snapshot);
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

export function computeWrapperEnv(
  baseEnv: NodeJS.ProcessEnv,
  state: ServerRuntimeState | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  // No live server: launch claude completely untouched — a down server must
  // never break launching claude.
  if (!state) return env;

  preserveOriginalNetworkEnv(env);

  if (state.mode === 'proxy') {
    // Selective MITM: claude keeps its own Anthropic credentials; the proxy
    // routes clodex:/alias models to OpenAI and passes everything else through.
    const proxyUrl = `http://127.0.0.1:${state.port}`;
    delete env['ANTHROPIC_BASE_URL'];
    for (const name of PROXY_ENV_VARS) env[name] = proxyUrl;
    if (state.caPath) env['NODE_EXTRA_CA_CERTS'] = state.caPath;
    removeAnthropicProxyBypass(env);
    return env;
  }

  // Endpoint gateway: all traffic goes to the local Anthropic-format gateway.
  for (const name of PROXY_ENV_VARS) delete env[name];
  env['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${state.port}/anthropic`;
  env['ANTHROPIC_API_KEY'] = LOCAL_GATEWAY_API_KEY;
  return env;
}
