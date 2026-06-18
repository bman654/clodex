// src/registry/url-security.ts — SSRF guard for custom provider URLs

import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export interface UrlSecurityOptions {
  /** Allow http://127.0.0.1 and http://localhost (Ollama, LM Studio). */
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
]);

function isBlockedIp(ipStr: string, allowInsecureLocal: boolean): boolean {
  try {
    const ip = ipaddr.process(ipStr);
    const range = ip.range();

    if (allowInsecureLocal && range === 'loopback') {
      return false;
    }

    if (range === 'loopback') return true;
    if (range === 'private') return true;
    if (range === 'linkLocal') return true;
    if (range === 'uniqueLocal') return true;
    if (range === 'carrierGradeNat') return true;
    
    return false;
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
      hint: 'For local servers (Ollama, LM Studio), enable “Allow local HTTP”.',
    };
  } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL must use https:// (or http://localhost when local is allowed).' };
  }
  
  // URL parses IPv6 hosts with brackets (e.g., "[::1]"). Strip them for DNS/IP checks.
  const rawHostname = parsed.hostname.toLowerCase();
  const hostname = rawHostname.replace(/^\[(.*)\]$/, '$1');

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return {
      ok: false,
      error: 'This URL points to a blocked internal/metadata host.',
      hint: 'Use a public API endpoint for your provider.',
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

  let allLocal = true;
  for (const addr of addresses) {
    let parsedIp;
    try {
      parsedIp = ipaddr.process(addr);
    } catch {
      allLocal = false;
      continue;
    }
    if (parsedIp.range() !== 'loopback') {
      allLocal = false;
    }

    if (isBlockedIp(addr, allowLocal)) {
      return {
        ok: false,
        error: 'URL resolves to a private or restricted network address.',
        hint: 'Custom providers must use publicly reachable API endpoints (unless localhost with local HTTP enabled).',
      };
    }
  }

  if (parsed.protocol === 'http:' && !allLocal) {
    return {
      ok: false,
      error: 'HTTP is only allowed for local loopback addresses.',
      hint: 'Use https:// for remote servers.',
    };
  }

  const normalizedUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
  return { ok: true, normalizedUrl };
}
