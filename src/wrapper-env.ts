// src/wrapper-env.ts
//
// Pure env computation for the `clodex-claude` wrapper bin. Given the process
// env and a live `clodex server` runtime state (or null), returns the env to
// launch the Claude Code binary with. Kept dependency-free so the wrapper
// stays tiny and fast — it runs for every Claude-Code-spawned agent process.

import type { ServerRuntimeState } from './server-runtime.js';

const PROXY_ENV_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'] as const;
export const REQUIRE_SERVER_ENV = 'CLODEX_REQUIRE_SERVER';

export function removeAnthropicProxyBypass(env: NodeJS.ProcessEnv): void {
  const noProxy = env['NO_PROXY'] ?? env['no_proxy'];
  if (noProxy === undefined) return;

  const filtered = noProxy
    .split(',')
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
    })
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
