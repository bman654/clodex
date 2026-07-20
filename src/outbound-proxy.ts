// src/outbound-proxy.ts — make clodex's OWN outbound network calls honor
// HTTP_PROXY / HTTPS_PROXY / NO_PROXY.
//
// Node's fetch (undici) ignores proxy env vars by default, so OAuth device
// flow/token refresh, model-list refresh, models.dev fetches, and upstream
// OpenAI calls made through the AI SDK would all bypass a corporate proxy.
// installOutboundProxyDispatcher() installs undici's EnvHttpProxyAgent as the
// global fetch dispatcher — but only when a proxy env var is actually set, so
// proxy-less environments are completely unaffected.
//
// The OAuth Responses WebSocket transport (`ws` in oauth/responses-websocket.ts)
// does not go through the undici dispatcher; outboundWsProxyAgent() builds an
// https-proxy-agent CONNECT-tunnel agent for it from the same env vars.
//
// Self-loop guard: clodex never sets proxy vars in its OWN process.env — proxy
// bridge mode sets HTTPS_PROXY only in the CHILD's env (buildHttpProxyChildEnv
// works on a copy of process.env). The dispatcher therefore only ever points at
// a proxy the user configured for clodex, never at clodex's own MITM listener.

import type { Agent as HttpAgent } from 'node:http';

export function hasOutboundProxyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env['HTTPS_PROXY']?.trim()
    || env['https_proxy']?.trim()
    || env['HTTP_PROXY']?.trim()
    || env['http_proxy']?.trim(),
  );
}

/** NO_PROXY matcher — comma-separated hosts; `*` disables proxying; `.foo` / `*.foo` are suffix matches. */
export function noProxyBypasses(hostname: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const noProxy = env['NO_PROXY'] ?? env['no_proxy'];
  if (!noProxy) return false;
  const host = hostname.toLowerCase();
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/:\d+$/, '');
    if (!entry) continue;
    if (entry === '*') return true;
    const suffix = entry.startsWith('*.') ? entry.slice(1) : entry;
    if (suffix.startsWith('.')) {
      if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
    } else if (host === suffix || host.endsWith(`.${suffix}`)) {
      return true;
    }
  }
  return false;
}

/** Proxy URL that applies to a target URL per the env vars, or undefined (none set / NO_PROXY match). */
export function outboundProxyUrlForTarget(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return undefined;
  }
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  const proxy = secure
    ? env['HTTPS_PROXY'] ?? env['https_proxy']
    : env['HTTP_PROXY'] ?? env['http_proxy'];
  if (!proxy?.trim()) return undefined;
  if (noProxyBypasses(parsed.hostname, env)) return undefined;
  return proxy.trim();
}

let dispatcherInstalled = false;

/** Reset the install-once latch (tests only). */
export function resetOutboundProxyDispatcherForTests(): void {
  dispatcherInstalled = false;
}

/**
 * Install undici's EnvHttpProxyAgent as the global fetch dispatcher when any
 * proxy env var is set. Idempotent. A failure warns and falls back to direct
 * connections — it must never break the CLI.
 */
export async function installOutboundProxyDispatcher(): Promise<boolean> {
  if (dispatcherInstalled) return true;
  if (!hasOutboundProxyEnv()) return false;
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
    dispatcherInstalled = true;
    return true;
  } catch (err) {
    console.error(
      'clodex: HTTP(S)_PROXY is set but installing the outbound proxy dispatcher failed; '
      + `using direct connections (${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  }
}

/** CONNECT-tunnel agent for the `ws` OAuth WebSocket transport, or undefined when no proxy applies. */
export async function outboundWsProxyAgent(wsUrl: string): Promise<HttpAgent | undefined> {
  const proxyUrl = outboundProxyUrlForTarget(wsUrl);
  if (!proxyUrl) return undefined;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  return new HttpsProxyAgent(proxyUrl);
}
