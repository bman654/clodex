// src/oauth/callback-server.ts — CLI fallback local callback server for PKCE OAuth flows.
// Primary path: the GUI server handles /oauth/callback when the UI is open.
// This is only used when running `clodex providers auth <provider>` without the GUI.

import http from 'node:http';
import { listenTcpServer } from '../listener-ready.js';

export interface CallbackParams {
  code: string;
  state: string;
  error?: string;
}

export interface CallbackServerOptions {
  /** Fixed ports to try in order; default [0] (ephemeral). */
  ports?: readonly number[];
  /** Only accept this callback path; default '/callback' and '/oauth/callback'. */
  path?: string;
  /** Hostname used in redirectUri; default '127.0.0.1'. */
  redirectHost?: string;
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

export async function startCallbackServer(options: CallbackServerOptions = {}): Promise<CallbackServer> {
  let codeResolve: ((p: CallbackParams) => void) | undefined;
  let codeReject: ((e: Error) => void) | undefined;
  // The browser can hit the callback before waitForCallback arms the promise.
  let buffered: CallbackParams | undefined;

  const acceptedPaths = options.path ? [options.path] : ['/callback', '/oauth/callback'];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    if (!acceptedPaths.includes(u.pathname)) {
      res.writeHead(404); res.end(); return;
    }
    const code = u.searchParams.get('code') ?? '';
    const state = u.searchParams.get('state') ?? '';
    const error = u.searchParams.get('error') ?? '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SUCCESS_HTML);
    const params: CallbackParams = { code, state, error: error || undefined };
    if (codeResolve) codeResolve(params);
    else buffered ??= params;
  });

  const ports = options.ports?.length ? options.ports : [0];
  let address: Awaited<ReturnType<typeof listenTcpServer>> | undefined;
  let lastError: unknown;
  for (const port of ports) {
    try {
      address = await listenTcpServer(server, port, '127.0.0.1');
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!address) throw lastError ?? new Error('OAuth callback server could not bind');

  const redirectHost = options.redirectHost ?? '127.0.0.1';
  return {
    port: address.port,
    redirectUri: `http://${redirectHost}:${address.port}${options.path ?? '/callback'}`,
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
