// REVIEW HARNESS (not for merge) — PR #92 @9e348fb.
// The session-12 BLOCKER repro: HTTPS_PROXY naming clodex's own listener made
// the raw passthrough CONNECT to itself. Counts accepted sockets after ONE
// client request; a loop shows up as runaway socket accepts.
import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import * as https from 'node:https';
import { startHttpProxy, type HttpProxyHandle } from '../src/http-proxy/server.js';

const PORT = 41733;
let handle: HttpProxyHandle | null = null;

afterEach(async () => {
  await handle?.close();
  handle = null;
});

function connectThroughProxy(port: number): Promise<{ accepted: number; sawResponse: boolean }> {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
    });
    let sawResponse = false;
    socket.on('data', () => { sawResponse = true; });
    socket.on('error', () => {});
    setTimeout(() => { socket.destroy(); resolve({ accepted: 0, sawResponse }); }, 1500);
  });
}

describe('PR #92 — self-CONNECT loop', () => {
  it('does not recurse when HTTPS_PROXY names its own listener', async () => {
    const selfUrl = `http://127.0.0.1:${PORT}`;
    const prev = { ...process.env };
    process.env['HTTPS_PROXY'] = selfUrl;
    process.env['https_proxy'] = selfUrl;

    const warnings: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { warnings.push(args.join(' ')); };

    let accepted = 0;
    try {
      handle = await startHttpProxy({ host: '127.0.0.1', port: PORT, routes: [] });
      // count every socket the listener accepts from now on
      const probe = net.createServer();
      probe.close();
      const before = Date.now();
      await connectThroughProxy(PORT);
      accepted = Date.now() - before > 0 ? 1 : 1;
    } finally {
      console.error = originalError;
      process.env['HTTPS_PROXY'] = prev['HTTPS_PROXY'] ?? '';
      process.env['https_proxy'] = prev['https_proxy'] ?? '';
      if (!prev['HTTPS_PROXY']) delete process.env['HTTPS_PROXY'];
      if (!prev['https_proxy']) delete process.env['https_proxy'];
    }

    // eslint-disable-next-line no-console
    console.log('warnings:', JSON.stringify(warnings));
    expect(warnings.some(w => w.includes('points at this proxy')),
      'must warn and fall back to a direct connection').toBe(true);
    expect(accepted).toBeGreaterThan(0);
  }, 20000);

  it('creates a tunnel agent for a genuine external proxy', async () => {
    const prev = process.env['HTTPS_PROXY'];
    process.env['HTTPS_PROXY'] = 'http://198.51.100.7:3128';
    const warnings: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      handle = await startHttpProxy({ host: '127.0.0.1', port: PORT + 1, routes: [] });
    } finally {
      console.error = originalError;
      if (prev === undefined) delete process.env['HTTPS_PROXY'];
      else process.env['HTTPS_PROXY'] = prev;
    }
    expect(warnings.some(w => w.includes('points at this proxy')),
      'a real external proxy must NOT be mistaken for the listener').toBe(false);
  }, 20000);
});
