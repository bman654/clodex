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
// The OAuth Responses WebSocket transport and raw first-party passthrough do
// not go through the undici dispatcher. outboundHttpProxyAgent() builds an
// https-proxy-agent CONNECT tunnel for those paths from the same env vars.
//
// Proxy bridge mode sets HTTPS_PROXY only in the CHILD's env, but a server can
// still inherit a previously exported bridge URL from its shell. Raw
// passthrough checks that resolved URL against its bound listener before it
// creates an agent, preventing a CONNECT loop through the same MITM.

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

/** Whether a proxy URL addresses the listener that would consume its CONNECT request. */
export function proxyUrlTargetsListener(
  proxyUrl: string,
  listenerHost: string,
  listenerPort: number,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return false;
  }
  const proxyPort = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : undefined;
  if (proxyPort !== listenerPort) return false;

  const normalizeHost = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, '');
  const proxyHost = normalizeHost(parsed.hostname);
  const boundHost = normalizeHost(listenerHost);
  if (proxyHost === boundHost) return true;

  const isLoopback = (host: string): boolean => host === 'localhost'
    || host === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
  const isWildcard = (host: string): boolean => host === '0.0.0.0' || host === '::';
  return isLoopback(proxyHost) && (isLoopback(boundHost) || isWildcard(boundHost));
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

/** CONNECT-tunnel agent for a target URL, or undefined when no proxy applies. */
export async function outboundHttpProxyAgent(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<import('https-proxy-agent').HttpsProxyAgent<string> | undefined> {
  const proxyUrl = outboundProxyUrlForTarget(targetUrl, env);
  if (!proxyUrl) return undefined;
  try {
    const parsedProxy = new URL(proxyUrl);
    if (!parsedProxy.hostname || !['http:', 'https:'].includes(parsedProxy.protocol)) {
      throw new TypeError('Invalid proxy URL');
    }
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    return new HttpsProxyAgent(parsedProxy, { keepAlive: true });
  } catch (err) {
    console.error(
      'clodex: HTTP(S)_PROXY cannot be used for a CONNECT tunnel; '
      + `using a direct connection (${err instanceof Error ? err.message : String(err)})`,
    );
    return undefined;
  }
}

/** CONNECT-tunnel agent for the `ws` OAuth WebSocket transport. */
export async function outboundWsProxyAgent(wsUrl: string): Promise<HttpAgent | undefined> {
  return outboundHttpProxyAgent(wsUrl);
}
