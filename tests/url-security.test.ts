import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateCustomEndpointUrl } from '../src/registry/url-security.js';

// Hostnames under `.clodex.test` answer from this table; everything else resolves for real.
const fakeDns = vi.hoisted(() => new Map<string, string[]>());
vi.mock('node:dns/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    lookup: vi.fn(async (hostname: string, options: unknown) => {
      const addresses = fakeDns.get(hostname);
      if (!addresses) return actual.lookup(hostname, options as never);
      return addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
    }),
  };
});

describe('validateCustomEndpointUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts public https URLs', async () => {
    const result = await validateCustomEndpointUrl('https://api.groq.com/openai/v1');
    expect(result.ok).toBe(true);
    expect(result.normalizedUrl).toContain('api.groq.com');
  });

  it('blocks cloud metadata hostnames', async () => {
    const result = await validateCustomEndpointUrl('https://metadata.google.internal/computeMetadata/v1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/blocked/i);
  });

  it('blocks plain http without local allowance', async () => {
    const result = await validateCustomEndpointUrl('http://127.0.0.1:11434/v1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTPS/i);
  });

  it('allows localhost http when allowInsecureLocal is set', async () => {
    const result = await validateCustomEndpointUrl('http://127.0.0.1:11434/v1', { allowInsecureLocal: true });
    expect(result.ok).toBe(true);
  });

  it('allows private LAN http when insecure local access is explicitly approved', async () => {
    const result = await validateCustomEndpointUrl('http://192.168.68.5:11434/v1', { allowInsecureLocal: true });
    expect(result.ok).toBe(true);
    expect(result.normalizedUrl).toBe('http://192.168.68.5:11434/v1');
  });

  it('blocks private LAN http without explicit insecure approval', async () => {
    const result = await validateCustomEndpointUrl('http://192.168.68.5:11434/v1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTPS/i);
  });

  it('blocks AWS metadata IP', async () => {
    const result = await validateCustomEndpointUrl('https://169.254.169.254/latest/meta-data');
    expect(result.ok).toBe(false);
  });

  it('still blocks metadata IPs even when insecure local access is approved', async () => {
    const result = await validateCustomEndpointUrl('http://169.254.169.254/latest/meta-data', { allowInsecureLocal: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/blocked|restricted/i);
  });

  describe('private networks such as Tailscale', () => {
    afterEach(() => {
      fakeDns.clear();
    });

    it('allows approved http to a Tailscale IPv4 address', async () => {
      const result = await validateCustomEndpointUrl('http://100.71.180.77:8080/v1', { allowInsecureLocal: true });
      expect(result).toEqual({ ok: true, normalizedUrl: 'http://100.71.180.77:8080/v1' });
    });

    it('allows approved http to a Tailscale IPv6 address', async () => {
      const result = await validateCustomEndpointUrl('http://[fd7a:115c:a1e0::8701:b4d7]:8080/v1', { allowInsecureLocal: true });
      expect(result).toEqual({ ok: true, normalizedUrl: 'http://[fd7a:115c:a1e0::8701:b4d7]:8080/v1' });
    });

    it('allows approved http to a MagicDNS name that resolves to both Tailscale addresses', async () => {
      fakeDns.set('mac.tailnet.clodex.test', ['100.71.180.77', 'fd7a:115c:a1e0::8701:b4d7']);
      const result = await validateCustomEndpointUrl('http://mac.tailnet.clodex.test:8080/v1', { allowInsecureLocal: true });
      expect(result).toEqual({ ok: true, normalizedUrl: 'http://mac.tailnet.clodex.test:8080/v1' });
    });

    it('still requires approval before plain http to a Tailscale address', async () => {
      const result = await validateCustomEndpointUrl('http://100.71.180.77:8080/v1');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/HTTPS/);
    });

    it('refuses approved http to a public address', async () => {
      const result = await validateCustomEndpointUrl('http://1.1.1.1/v1', { allowInsecureLocal: true });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/HTTP is only allowed/);
    });

    it('refuses approved http when any resolved address is public', async () => {
      fakeDns.set('split.clodex.test', ['100.71.180.77', '1.1.1.1']);
      const result = await validateCustomEndpointUrl('http://split.clodex.test/v1', { allowInsecureLocal: true });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/HTTP is only allowed/);
    });

    it.each([
      ['a loopback address', 'https://127.0.0.1:8443/v1'],
      ['a LAN address', 'https://192.168.68.5/v1'],
      ['a Tailscale IPv4 address', 'https://100.71.180.77/v1'],
      ['a unique-local IPv6 address', 'https://[fd7a:115c:a1e0::8701:b4d7]/v1'],
    ])('allows https to %s without an HTTP approval', async (_label, url) => {
      const result = await validateCustomEndpointUrl(url);
      expect(result).toEqual({ ok: true, normalizedUrl: url });
    });

    it('allows https to a Tailscale Serve name', async () => {
      fakeDns.set('mac.tail2f82b6.clodex.test', ['100.71.180.77', 'fd7a:115c:a1e0::8701:b4d7']);
      const result = await validateCustomEndpointUrl('https://mac.tail2f82b6.clodex.test/v1');
      expect(result).toEqual({ ok: true, normalizedUrl: 'https://mac.tail2f82b6.clodex.test/v1' });
    });

    it.each([
      ['https to IPv4 link-local', 'https://169.254.10.10/v1', {}],
      ['approved http to IPv4 link-local', 'http://169.254.10.10/v1', { allowInsecureLocal: true }],
      ['https to IPv6 link-local', 'https://[fe80::1]/v1', {}],
      ['https to an IPv4-mapped metadata address', 'https://[::ffff:169.254.169.254]/v1', {}],
    ])('refuses %s', async (_label, url, opts) => {
      const result = await validateCustomEndpointUrl(url, opts);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/link-local or cloud metadata/);
    });

    it.each([
      ['AWS IPv6', 'fd00:ec2::254'],
      ['Alibaba Cloud', '100.100.100.200'],
      ['Google Cloud IPv6', 'fd20:ce::254'],
    ])('refuses a hostname that resolves to the %s metadata address', async (_label, address) => {
      fakeDns.set('alias.clodex.test', [address]);
      for (const url of ['https://alias.clodex.test/v1', 'http://alias.clodex.test/v1']) {
        const result = await validateCustomEndpointUrl(url, { allowInsecureLocal: true });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/link-local or cloud metadata/);
      }
    });

    it.each([
      'http://100.100.100.200/latest/meta-data',
      'http://[fd20:ce::254]/computeMetadata/v1',
    ])('refuses the literal metadata address %s even with HTTP approved', async url => {
      const result = await validateCustomEndpointUrl(url, { allowInsecureLocal: true });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/blocked|restricted/);
    });

    it('refuses a hostname that resolves to a link-local address', async () => {
      fakeDns.set('metadata.clodex.test', ['169.254.169.254']);
      const result = await validateCustomEndpointUrl('https://metadata.clodex.test/v1');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/link-local or cloud metadata/);
    });
  });
});
