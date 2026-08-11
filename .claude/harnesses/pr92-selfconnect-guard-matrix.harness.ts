// REVIEW HARNESS (not for merge) — PR #92 @9e348fb, self-CONNECT guard matrix.
import { describe, expect, it } from 'vitest';
import { proxyUrlTargetsListener, outboundHttpProxyAgent } from '../src/outbound-proxy.js';

describe('PR #92 — proxyUrlTargetsListener matrix', () => {
  const cases: Array<[string, string, number, boolean, string]> = [
    // [proxyUrl, boundHost, boundPort, expectedDetectedAsSelf, note]
    ['http://127.0.0.1:49653', '127.0.0.1', 49653, true, 'the exact URL clodex prints'],
    ['http://localhost:49653', '127.0.0.1', 49653, true, 'localhost vs 127.0.0.1'],
    ['http://127.0.0.1:49653', '0.0.0.0', 49653, true, 'wildcard bind'],
    ['http://[::1]:49653', '127.0.0.1', 49653, true, 'v6 loopback vs v4'],
    ['http://127.0.0.2:49653', '127.0.0.1', 49653, true, '127.0.0.0/8'],
    ['http://127.0.0.1:49654', '127.0.0.1', 49653, false, 'different port -> not self'],
    ['http://corp-proxy:8080', '127.0.0.1', 49653, false, 'real proxy -> not self'],
    ['http://127.0.0.1', '127.0.0.1', 80, true, 'implicit port 80'],
    ['https://127.0.0.1', '127.0.0.1', 443, true, 'implicit port 443'],
    // --- the shapes I suspect are NOT covered ---
    ['http://192.168.1.5:49653', '0.0.0.0', 49653, false, 'LAN IP of this host, wildcard bind'],
    ['http://127.0.0.1:49653', '::', 49653, true, 'v6 wildcard bind'],
    ['127.0.0.1:49653', '127.0.0.1', 49653, false, 'scheme-less self-reference'],
  ];

  for (const [url, host, port, expected, note] of cases) {
    it(`${note}: ${url} vs ${host}:${port} -> ${expected}`, () => {
      expect(proxyUrlTargetsListener(url, host, port)).toBe(expected);
    });
  }
});

describe('PR #92 — outboundHttpProxyAgent never throws on hostile proxy values', () => {
  const hostile = [
    '127.0.0.1:8080',        // the session-12 MAJOR: scheme-less
    'localhost:8080',
    'http://',
    'not a url',
    'ftp://proxy:21',
    'http://user:pa ss@proxy:8080',
    '',
    '   ',
    'http://[::1',
  ];
  for (const value of hostile) {
    it(`HTTPS_PROXY=${JSON.stringify(value)} resolves without throwing`, async () => {
      const env = { HTTPS_PROXY: value, https_proxy: value } as NodeJS.ProcessEnv;
      let agent: unknown;
      await expect((async () => { agent = await outboundHttpProxyAgent('https://api.anthropic.com', env); })())
        .resolves.not.toThrow();
      // eslint-disable-next-line no-console
      console.log(`  ${JSON.stringify(value)} -> agent=${agent ? 'created' : 'undefined (direct)'}`);
    });
  }

  it('does not leak proxy credentials into the warning', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
      await outboundHttpProxyAgent('https://api.anthropic.com', {
        HTTPS_PROXY: 'http://alice:s3cr3t-token@[bad',
      } as NodeJS.ProcessEnv);
    } finally {
      console.error = original;
    }
    // eslint-disable-next-line no-console
    console.log('  warning text:', JSON.stringify(errors));
    for (const line of errors) {
      expect(line).not.toContain('s3cr3t-token');
      expect(line).not.toContain('alice');
    }
  });
});
