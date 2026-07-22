import { describe, expect, it } from 'vitest';
import {
  extractBearerToken,
  isAllowedGatewayHost,
  isAuthorized,
  isBrowserOriginRequest,
  isLoopbackBind,
  sanitizeCredential,
} from '../src/server/auth.js';

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/test', { headers });
}

describe('server auth', () => {
  it('accepts every request when serverPassword is null', () => {
    expect(isAuthorized(request(), null)).toBe(true);
    expect(isAuthorized(request({ authorization: 'Bearer wrong' }), null)).toBe(true);
  });

  it('accepts a matching bearer token', () => {
    expect(isAuthorized(request({ authorization: 'Bearer secret' }), 'secret')).toBe(true);
  });

  it('accepts a matching x-api-key header', () => {
    expect(isAuthorized(request({ 'x-api-key': 'secret' }), 'secret')).toBe(true);
  });

  it('rejects missing and wrong passwords', () => {
    expect(isAuthorized(request(), 'secret')).toBe(false);
    expect(isAuthorized(request({ authorization: 'Bearer wrong' }), 'secret')).toBe(false);
    expect(isAuthorized(request({ 'x-api-key': 'wrong' }), 'secret')).toBe(false);
  });

  it('ignores pasted notes after a newline in gateway credentials', () => {
    expect(sanitizeCredential('secret\n\ncc-claw:notes')).toBe('secret');
    expect(extractBearerToken('Bearer secret\n\nFor laptop:notes')).toBe('secret');
    // Request() rejects multiline header values — router sanitizes before Headers; test logic via extractBearerToken.
    expect(isAuthorized(request({ authorization: 'Bearer secret' }), 'secret')).toBe(true);
  });
});

describe('loopback gateway browser guards', () => {
  it('recognises which binds are loopback', () => {
    expect(isLoopbackBind('127.0.0.1')).toBe(true);
    expect(isLoopbackBind('::1')).toBe(true);
    expect(isLoopbackBind(undefined)).toBe(true); // fail closed
    expect(isLoopbackBind('0.0.0.0')).toBe(false); // network mode is password-gated
  });

  it('accepts loopback Host headers with and without a port', () => {
    for (const host of ['127.0.0.1:17645', 'localhost:17645', '[::1]:17645', '127.0.0.1', 'LocalHost']) {
      expect(isAllowedGatewayHost(host), host).toBe(true);
    }
    expect(isAllowedGatewayHost(undefined)).toBe(true); // HTTP/1.0 has no Host
  });

  it('rejects the rebound Host headers a DNS-rebinding page is pinned to', () => {
    for (const host of ['attacker.example:17645', 'clodex.attacker.test', '127.0.0.1.nip.io:17645', 'not a host']) {
      expect(isAllowedGatewayHost(host), host).toBe(false);
    }
  });

  it('flags any Origin header as a browser request', () => {
    expect(isBrowserOriginRequest('https://evil.example')).toBe(true);
    expect(isBrowserOriginRequest('null')).toBe(true); // sandboxed iframe
    expect(isBrowserOriginRequest(undefined)).toBe(false);
    expect(isBrowserOriginRequest('  ')).toBe(false);
  });
});
