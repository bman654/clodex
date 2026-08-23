// src/oauth/callback-server.ts — CLI fallback local callback server for PKCE OAuth flows.
// Primary path: the GUI server handles /oauth/callback when the UI is open.
// This is only used when running `clodex providers auth <provider>` without the GUI.

import http from 'node:http';
import { listenTcpServer, waitForTcpListener } from '../listener-ready.js';

export interface CallbackParams {
  code: string;
  state: string;
  error?: string;
}

export interface CallbackServerOptions {
  /** Fixed ports to try in order; default [0] (ephemeral). */
  ports?: readonly number[];
  /** The callback path registered with the provider; the only path accepted. */
  path: string;
  /** Loopback hostname used in redirectUri and bound by the listener. */
  redirectHost: 'localhost' | '127.0.0.1';
  /** Only accept callbacks carrying this OAuth state. */
  expectedState?: string;
}

export interface CallbackServer {
  port: number;
  redirectUri: string;
  waitForCallback(timeoutMs?: number): Promise<CallbackParams>;
  close(): void;
}

const SUCCESS_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authorized</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
<div style="text-align:center;padding:2rem;background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1)">
<div style="color:#22c55e;font-size:2.5rem">&#10003;</div>
<h1 style="margin:.5rem 0">Authentication successful</h1>
<p style="color:#666">You can close this tab and return to the terminal.</p>
</div></body></html>`;

const FAILURE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sign-in failed</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
<div style="text-align:center;padding:2rem;background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1)">
<div style="color:#ef4444;font-size:2.5rem">&#10007;</div>
<h1 style="margin:.5rem 0">Sign-in failed</h1>
<p style="color:#666">Return to the terminal for details.</p>
</div></body></html>`;

const LOOPBACK_PROBE_TIMEOUT_MS = 250;

async function isLoopbackPortTaken(port: number): Promise<boolean> {
  const probes = await Promise.all(['127.0.0.1', '::1'].map(host =>
    waitForTcpListener(host, port, LOOPBACK_PROBE_TIMEOUT_MS)
      .catch(() => false),
  ));
  return probes.some(Boolean);
}

export async function startCallbackServer(options: CallbackServerOptions): Promise<CallbackServer> {
  let codeResolve: ((p: CallbackParams) => void) | undefined;
  let codeReject: ((e: Error) => void) | undefined;
  // The browser can hit the callback before waitForCallback arms the promise.
  let buffered: CallbackParams | undefined;

  const { path, redirectHost } = options;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    if (u.pathname !== path) {
      res.writeHead(404); res.end(); return;
    }
    const code = u.searchParams.get('code') ?? '';
    const state = u.searchParams.get('state') ?? '';
    const error = u.searchParams.get('error') ?? '';
    if (options.expectedState !== undefined && state !== options.expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid OAuth state');
      return;
    }
    const failed = Boolean(error) || !code;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(failed ? FAILURE_HTML : SUCCESS_HTML);
    const params: CallbackParams = { code, state, error: error || undefined };
    if (codeResolve) codeResolve(params);
    else buffered ??= params;
  });

  const ports = options.ports?.length ? options.ports : [0];
  let address: Awaited<ReturnType<typeof listenTcpServer>> | undefined;
  let lastError: unknown;
  for (const port of ports) {
    // 'localhost' binds one loopback family, but the browser may resolve the
    // other; a foreign listener there would swallow the redirect while our
    // bind "succeeds". Treat a port answering on either family as taken.
    if (port !== 0 && redirectHost === 'localhost' && await isLoopbackPortTaken(port)) {
      const busy: NodeJS.ErrnoException = new Error(`listen EADDRINUSE: address already in use localhost:${port}`);
      busy.code = 'EADDRINUSE';
      lastError = busy;
      continue;
    }
    try {
      address = await listenTcpServer(server, port, redirectHost);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!address) throw lastError ?? new Error('OAuth callback server could not bind');

  return {
    port: address.port,
    redirectUri: `http://${redirectHost}:${address.port}${path}`,
    waitForCallback(timeoutMs = 300_000) {
      return new Promise<CallbackParams>((resolve, reject) => {
        if (buffered) {
          resolve(buffered);
          buffered = undefined;
          return;
        }
        const timer = setTimeout(
          () => reject(new Error('OAuth timeout — browser closed without completing sign-in')),
          timeoutMs,
        );
        codeResolve = params => { clearTimeout(timer); resolve(params); };
        codeReject = err => { clearTimeout(timer); reject(err); };
      });
    },
    close() { server.close(); codeReject?.(new Error('Server closed')); },
  };
}
