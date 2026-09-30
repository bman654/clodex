// src/registry/url-security.ts — base URL checks for custom providers
//
// No network-facing clodex route supplies or stores this URL: it is typed into
// `providers add`, or read back from the local providers.json by a refresh. Whoever
// controls either can already reach any address this machine can, so refusing
// private networks would protect nothing and strand self-hosted servers.
//
// What is checked, against the addresses the host resolves to when the provider is
// added or refreshed: plain HTTP only after the user approves it and only to a
// non-public network, so an approved server is not one across the internet; and
// never a link-local or listed cloud metadata address. Later requests are not
// re-checked, and an outbound proxy still sees plain HTTP it carries.

import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export interface UrlSecurityOptions {
  /** Allow http:// endpoints for user-approved servers on a non-public network (Ollama, LM Studio, vLLM). */
  allowInsecureLocal?: boolean;
}

export interface UrlSecurityResult {
  ok: boolean;
  error?: string;
  hint?: string;
  normalizedUrl?: string;
}

const BLOCKED_HOSTNAMES = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  '169.254.170.2',
  'fd00:ec2::254',
  '100.100.100.200', // Alibaba Cloud ECS
  'fd20:ce::254', // Google Cloud IPv6
]);

// Where approved plain HTTP may go: this machine, the LAN, and private overlays.
// Tailscale hands out carrier-grade-NAT IPv4 (100.64.0.0/10) and unique-local
// IPv6 (fd7a:115c:a1e0::/48) addresses.
const NON_PUBLIC_RANGES = new Set(['loopback', 'private', 'uniqueLocal', 'carrierGradeNat']);

// Cloud metadata services answer in link-local space, and a few at the listed
// carrier-grade-NAT and unique-local addresses.
function isBlockedIp(ipStr: string): boolean {
  try {
    const ip = ipaddr.process(ipStr);
    return ip.range() === 'linkLocal' || BLOCKED_HOSTNAMES.has(ip.toString());
  } catch {
    return true; // If we can't parse it, block it to be safe
  }
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  try {
    ipaddr.parse(hostname);
    return [hostname];
  } catch {
    // Not an IP, proceed to DNS lookup
  }
  
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map(r => r.address);
  } catch {
    return [];
  }
}

/** Validate a custom provider base URL before test or save. */
export async function validateCustomEndpointUrl(
  rawUrl: string,
  opts: UrlSecurityOptions = {},
): Promise<UrlSecurityResult> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, error: 'Base URL is required.', hint: 'Example: https://api.example.com/v1' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Invalid URL.', hint: 'Include https:// and the full base path.' };
  }

  const allowLocal = opts.allowInsecureLocal === true;

  if (parsed.protocol === 'http:' && !allowLocal) {
    return {
      ok: false,
      error: 'Only HTTPS URLs are allowed.',
      hint: 'For a server on this machine, your LAN or Tailscale (Ollama, LM Studio, vLLM), allow insecure HTTP when prompted.',
    };
  } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL must use https:// or user-approved http:// for local, LAN or Tailscale servers.' };
  }
  
  // URL parses IPv6 hosts with brackets (e.g., "[::1]"). Strip them for DNS/IP checks.
  const rawHostname = parsed.hostname.toLowerCase();
  const hostname = rawHostname.replace(/^\[(.*)\]$/, '$1');

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return {
      ok: false,
      error: 'This URL points to a blocked internal/metadata host.',
      hint: "Use your model server's own loopback, LAN, Tailscale or public address.",
    };
  }

  const addresses = await resolveHostAddresses(hostname);
  if (addresses.length === 0) {
    return {
      ok: false,
      error: `Could not resolve hostname: ${hostname}`,
      hint: 'Check the URL spelling and your network connection.',
    };
  }

  for (const addr of addresses) {
    try {
      ipaddr.process(addr);
    } catch {
      continue;
    }

    if (isBlockedIp(addr)) {
      return {
        ok: false,
        error: 'URL resolves to a restricted link-local or cloud metadata address.',
        hint: "Link-local addresses are not supported. Use the server's loopback, LAN, Tailscale or public address.",
      };
    }
  }

  if (parsed.protocol === 'http:') {
    const allResolvedAddressesAreLocal = addresses.every(addr => {
      try {
        return NON_PUBLIC_RANGES.has(ipaddr.process(addr).range());
      } catch {
        return false;
      }
    });
    if (!allowLocal || !allResolvedAddressesAreLocal) {
      return {
        ok: false,
        error: 'HTTP is only allowed for addresses on this machine, your LAN or a private network such as Tailscale.',
        hint: 'Use https:// for a server on the public internet.',
      };
    }
  }

  const normalizedUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
  return { ok: true, normalizedUrl };
}
