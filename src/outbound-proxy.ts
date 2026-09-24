// src/outbound-proxy.ts — control clodex's OWN outbound fetch transport and
// honor HTTP_PROXY / HTTPS_PROXY / NO_PROXY.
//
// Node's fetch (undici) ignores proxy env vars by default, so OAuth device
// flow/token refresh, model-list refresh, models.dev fetches, and upstream
// OpenAI calls made through the AI SDK would all bypass a corporate proxy.
// installOutboundDispatcher() installs the package undici dispatcher
// globally: EnvHttpProxyAgent when proxy env is configured, or Agent otherwise.
//
// Node 26's bundled undici 8 turns on HTTP/2 in fetch(). If a peer tears down a
// pooled h2 session with a fatal TLS alert, Node marks it destroyed but never
// closes it, undici never evicts it, and every later request to that origin
// fails immediately with ERR_HTTP2_INVALID_SESSION until restart (issue #233).
// Both dispatcher variants therefore disable HTTP/2 explicitly.
//
// The OAuth Responses WebSocket transport and raw first-party passthrough do
// not go through the undici dispatcher. outboundHttpProxyAgent() builds an
// https-proxy-agent CONNECT tunnel for those paths from the same env vars.
//
// Proxy bridge mode sets HTTPS_PROXY only in the CHILD's env, but a server can
// still inherit a previously exported bridge URL from its shell. Raw
// passthrough checks that resolved URL against its bound listener before it
// creates an agent, catching literal spellings of the same MITM. Aliases and
// A→B→A loops are caught by OUTBOUND_PROXY_HOP_HEADER below.

import type { Agent as HttpAgent } from 'node:http';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { emitParentNotice } from './parent-notice.js';

// Private to this process. Sent only to an outbound proxy (not to the origin)
// and removed if a request returns to our listener, regardless of its value.
export const OUTBOUND_PROXY_HOP_HEADER = 'x-clodex-proxy-hop';
const outboundProxyHopNonce = randomUUID();
export function isOwnOutboundProxyHop(value: string | string[] | undefined): boolean {
  // Node joins duplicate unknown headers with commas. A middle proxy may add
  // its own marker without removing ours; only our exact nonce is a match.
  return (Array.isArray(value) ? value : [value]).some(entry =>
    entry?.split(',').some(part => part.trim() === outboundProxyHopNonce));
}
const proxyHopHeaders = { [OUTBOUND_PROXY_HOP_HEADER]: outboundProxyHopNonce };

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
  localAddresses: ReadonlySet<string> = new Set(
    Object.values(networkInterfaces()).flatMap(entries =>
      (entries ?? []).map(entry => entry.address.toLowerCase())),
  ),
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

  const normalizeHost = (host: string): string => {
    const plain = host.toLowerCase().replace(/^\[|\]$/g, '');
    // URL.hostname canonicalizes ::ffff:127.0.0.1 to [::ffff:7f00:1].
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(plain);
    if (mapped) {
      const high = parseInt(mapped[1]!, 16);
      const low = parseInt(mapped[2]!, 16);
      return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return plain.replace(/^::ffff:(?=\d+\.)/, '').replace(/^localhost\.$/, 'localhost');
  };
  const proxyHost = normalizeHost(parsed.hostname);
  const boundHost = normalizeHost(listenerHost);
  if (proxyHost === boundHost) return true;

  const isLoopback = (host: string): boolean => host === 'localhost'
    || host === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
  const isWildcard = (host: string): boolean => host === '0.0.0.0' || host === '::';
  if (isLoopback(proxyHost) && (isLoopback(boundHost) || isWildcard(boundHost))) return true;
  return isWildcard(boundHost) && (
    isWildcard(proxyHost)
    || localAddresses.has(proxyHost)
  );
}

let dispatcherInstalled = false;

/** Reset the install-once latch (tests only). */
export function resetOutboundDispatcherForTests(): void {
  dispatcherInstalled = false;
}

/**
 * Install package undici's global fetch dispatcher with HTTP/2 disabled,
 * honoring proxy env vars when present. Idempotent. A failure warns and keeps
 * Node's existing dispatcher — it must never break the CLI.
 */
export async function installOutboundDispatcher(): Promise<boolean> {
  if (dispatcherInstalled) return true;
  try {
    const { Agent, EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
    // EnvHttpProxyAgent shares its headers object between HTTP and HTTPS
    // ProxyAgents; undici writes URL credentials into it. Do not pass a shared
    // marker object here or one proxy's credentials can reach another proxy.
    // A fetch entering a self-loop is refused on its next (marked) CONNECT.
    const dispatcher = hasOutboundProxyEnv()
      ? new EnvHttpProxyAgent({ allowH2: false })
      : new Agent({ allowH2: false });
    setGlobalDispatcher(dispatcher);
    dispatcherInstalled = true;
    return true;
  } catch (err) {
    console.error(
      'clodex: installing the outbound fetch dispatcher failed; '
      + `continuing with Node's existing dispatcher (${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  }
}

/** CONNECT-tunnel agent for a target URL, or undefined when no proxy applies. */
export function outboundHttpProxyAgent(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): HttpsProxyAgent<string> | undefined {
  const proxyUrl = outboundProxyUrlForTarget(targetUrl, env);
  if (!proxyUrl) return undefined;
  try {
    const parsedProxy = new URL(proxyUrl);
    if (!parsedProxy.hostname || !['http:', 'https:'].includes(parsedProxy.protocol)) {
      throw new TypeError('Invalid proxy URL');
    }
    return new HttpsProxyAgent(parsedProxy, { keepAlive: true, headers: { ...proxyHopHeaders } });
  } catch (err) {
    // Reachable from the non-intercepted CONNECT handler, which runs while the
    // spawned Claude Code owns the terminal and `launchClaude` has muted the
    // parent's stderr — so this has to go through the parent-notice channel to
    // be seen at all.
    emitParentNotice(
      'clodex: HTTP(S)_PROXY cannot be used for a CONNECT tunnel; '
      + `using a direct connection (${err instanceof Error ? err.message : String(err)})`,
    );
    return undefined;
  }
}

/** CONNECT-tunnel agent for the `ws` OAuth WebSocket transport. */
export function outboundWsProxyAgent(
  wsUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): HttpAgent | undefined {
  return outboundHttpProxyAgent(wsUrl, env);
}
