// tests/outbound-proxy.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  hasOutboundProxyEnv,
  noProxyBypasses,
  outboundHttpProxyAgent,
  outboundProxyUrlForTarget,
  proxyUrlTargetsListener,
} from '../src/outbound-proxy.js';

const PROXY = 'http://127.0.0.1:8888';

describe('hasOutboundProxyEnv', () => {
  it('is false with no proxy vars or blank values', () => {
    expect(hasOutboundProxyEnv({})).toBe(false);
    expect(hasOutboundProxyEnv({ HTTPS_PROXY: '  ' })).toBe(false);
    expect(hasOutboundProxyEnv({ NO_PROXY: '*' })).toBe(false);
  });

  it('is true for any of the four proxy var spellings', () => {
    expect(hasOutboundProxyEnv({ HTTPS_PROXY: PROXY })).toBe(true);
    expect(hasOutboundProxyEnv({ https_proxy: PROXY })).toBe(true);
    expect(hasOutboundProxyEnv({ HTTP_PROXY: PROXY })).toBe(true);
    expect(hasOutboundProxyEnv({ http_proxy: PROXY })).toBe(true);
  });
});

describe('outboundProxyUrlForTarget', () => {
  it('uses HTTPS_PROXY for https and wss targets', () => {
    const env = { HTTPS_PROXY: PROXY };
    expect(outboundProxyUrlForTarget('https://api.openai.com/v1/responses', env)).toBe(PROXY);
    expect(outboundProxyUrlForTarget('wss://chatgpt.com/backend-api/responses', env)).toBe(PROXY);
    // http targets do not fall back to HTTPS_PROXY
    expect(outboundProxyUrlForTarget('http://models.dev/api.json', env)).toBeUndefined();
  });

  it('uses HTTP_PROXY for http and ws targets only', () => {
    const env = { HTTP_PROXY: PROXY };
    expect(outboundProxyUrlForTarget('http://models.dev/api.json', env)).toBe(PROXY);
    expect(outboundProxyUrlForTarget('ws://localhost:9999/x', env)).toBe(PROXY);
    expect(outboundProxyUrlForTarget('https://api.openai.com/v1', env)).toBeUndefined();
  });

  it('prefers the uppercase spelling and trims values', () => {
    expect(outboundProxyUrlForTarget('https://x.test/', {
      HTTPS_PROXY: ` ${PROXY} `,
      https_proxy: 'http://other:1',
    })).toBe(PROXY);
  });

  it('returns undefined for unparseable target URLs', () => {
    expect(outboundProxyUrlForTarget('not a url', { HTTPS_PROXY: PROXY })).toBeUndefined();
  });

  it('honors NO_PROXY', () => {
    const env = { HTTPS_PROXY: PROXY, NO_PROXY: 'api.openai.com' };
    expect(outboundProxyUrlForTarget('https://api.openai.com/v1', env)).toBeUndefined();
    expect(outboundProxyUrlForTarget('https://chatgpt.com/x', env)).toBe(PROXY);
  });
});

describe('outboundHttpProxyAgent', () => {
  it('builds an agent only when the target is not bypassed', async () => {
    const direct = await outboundHttpProxyAgent('https://api.example.test', {
      HTTPS_PROXY: PROXY,
      NO_PROXY: 'api.example.test',
    });
    expect(direct).toBeUndefined();

    const proxied = await outboundHttpProxyAgent('https://api.example.test', {
      HTTPS_PROXY: PROXY,
    });
    expect(proxied).toBeDefined();
    expect(proxied?.keepAlive).toBe(true);
    proxied?.destroy();
  });

  it.each([
    'localhost:3128',
    'http://user:private-proxy-token@[invalid',
  ])('warns and falls back to direct for malformed proxy URL %s', async proxyUrl => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const agent = await outboundHttpProxyAgent('https://api.example.test', {
        HTTPS_PROXY: proxyUrl,
      });

      expect(agent).toBeUndefined();
      expect(error).toHaveBeenCalledOnce();
      expect(error.mock.calls.flat().join(' ')).toMatch(
        /using a direct connection \(Invalid (?:proxy )?URL\)/,
      );
      expect(error.mock.calls.flat().join(' ')).not.toContain('private-proxy-token');
    } finally {
      error.mockRestore();
    }
  });
});

describe('proxyUrlTargetsListener', () => {
  it('matches loopback aliases and wildcard listeners only on the bound port', () => {
    expect(proxyUrlTargetsListener('http://127.0.0.1:17645', '127.0.0.1', 17645)).toBe(true);
    expect(proxyUrlTargetsListener('http://localhost:17645', '127.0.0.1', 17645)).toBe(true);
    expect(proxyUrlTargetsListener('http://127.0.0.2:17645', '0.0.0.0', 17645)).toBe(true);
    expect(proxyUrlTargetsListener('http://127.0.0.1:17646', '127.0.0.1', 17645)).toBe(false);
    expect(proxyUrlTargetsListener('http://proxy.example.test:17645', '127.0.0.1', 17645)).toBe(false);
    expect(proxyUrlTargetsListener('not a URL', '127.0.0.1', 17645)).toBe(false);
  });
});

describe('noProxyBypasses', () => {
  it('matches exact hosts, subdomains, and dot/star suffixes', () => {
    expect(noProxyBypasses('api.openai.com', { NO_PROXY: 'api.openai.com' })).toBe(true);
    // bare domain also matches subdomains (curl semantics)
    expect(noProxyBypasses('sub.openai.com', { NO_PROXY: 'openai.com' })).toBe(true);
    expect(noProxyBypasses('api.openai.com', { NO_PROXY: '.openai.com' })).toBe(true);
    expect(noProxyBypasses('api.openai.com', { NO_PROXY: '*.openai.com' })).toBe(true);
    expect(noProxyBypasses('openai.com.evil.test', { NO_PROXY: 'openai.com' })).toBe(false);
    expect(noProxyBypasses('notopenai.com', { NO_PROXY: 'openai.com' })).toBe(false);
  });

  it('supports the * wildcard, lists, ports, and lowercase spelling', () => {
    expect(noProxyBypasses('anything.test', { NO_PROXY: '*' })).toBe(true);
    expect(noProxyBypasses('b.test', { NO_PROXY: 'a.test, b.test' })).toBe(true);
    expect(noProxyBypasses('c.test', { NO_PROXY: 'c.test:443' })).toBe(true);
    expect(noProxyBypasses('d.test', { no_proxy: 'd.test' })).toBe(true);
    expect(noProxyBypasses('e.test', {})).toBe(false);
  });
});
