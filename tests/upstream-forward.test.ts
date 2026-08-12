// tests/upstream-forward.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Writable, type Transform } from 'node:stream';
import {
  anthropicUpstreamHeaders,
  fetchWithOAuthRetry,
  anthropicSseModelRewrite,
  relayAnthropicMessages,
} from '../src/upstream-forward.js';
import {
  CONTEXT_1M_BETA,
  TOOL_SEARCH_BETAS,
  classifyAnthropicCapabilityEndpoint,
  extractConfiguredBetaTokens,
  isAnthropicBetaHeaderName,
  normalizeBetaTokens,
  resolveCapabilityBetaTokens,
  resolveOutboundBeta,
  type AnthropicCapabilityRequest,
} from '../src/anthropic-beta-policy.js';

const [TOOL_SEARCH_FIRST_PARTY_BETA, TOOL_SEARCH_GATEWAY_BETA] = TOOL_SEARCH_BETAS as [string, string];

/** A tools array that structurally uses the tool-search server tool. */
const TOOL_SEARCH_TOOLS = [
  { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
];
/** A tools array whose only marker is a deferred tool. */
const DEFERRED_TOOLS = [{ name: 'mcp__docs__search', defer_loading: true }];
/** An ordinary tool request: no tool-search type, no defer_loading. */
const ORDINARY_TOOLS = [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }];

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

function capability(over: Partial<AnthropicCapabilityRequest> = {}): AnthropicCapabilityRequest {
  return {
    url: ANTHROPIC_MESSAGES_URL,
    clientBeta: [],
    requestedModelId: 'claude-sonnet-4-6[1m]',
    advertisedModelId: 'claude-sonnet-4-6[1m]',
    advertisedContextWindow: 1_000_000,
    body: { model: 'claude-sonnet-4-6' },
    ...over,
  };
}

/** Header names that would only ever be present to simulate a native Claude client. */
const NATIVE_IDENTITY_HEADER_NAMES = [
  'User-Agent',
  'user-agent',
  'x-app',
  'X-App',
  'X-Claude-Code-Session-Id',
  'x-claude-code-session-id',
];

function expectNoSynthesizedIdentity(headers: Record<string, string>): void {
  for (const name of NATIVE_IDENTITY_HEADER_NAMES) {
    expect(headers).not.toHaveProperty(name);
  }
  expect(JSON.stringify(headers)).not.toContain('claude-cli');
}

describe('anthropicUpstreamHeaders', () => {
  it('includes bearer and x-api-key', () => {
    expect(anthropicUpstreamHeaders('secret-key')).toMatchObject({
      Authorization: 'Bearer secret-key',
      'x-api-key': 'secret-key',
      'anthropic-version': '2023-06-01',
    });
  });

  it('adds stream accept header when requested', () => {
    expect(anthropicUpstreamHeaders('secret-key', true).Accept).toBe('text/event-stream');
  });

  // Supersedes "adds Claude Code session header for OAuth requests": no supported
  // producer emits routed claude-code OAuth, so the identity that header simulated
  // has no lineage to stand on. The credential scheme it rode alongside is retained
  // by the assertions below.
  it('sends OAuth as Bearer without x-api-key and without synthesized identity', () => {
    const headers = anthropicUpstreamHeaders('oauth-token', true, 'oauth');
    expect(headers).toMatchObject({
      Authorization: 'Bearer oauth-token',
      'anthropic-version': '2023-06-01',
      Accept: 'text/event-stream',
    });
    expect(headers).not.toHaveProperty('x-api-key');
    expectNoSynthesizedIdentity(headers);
  });

  it('emits no anthropic-beta when the provider configures none', () => {
    for (const authType of ['api', 'oauth', 'none'] as const) {
      const headers = anthropicUpstreamHeaders('token', false, authType, { 'X-Plan': 'coding' });
      expect(headers).not.toHaveProperty('anthropic-beta');
      expect(Object.keys(headers).some(isAnthropicBetaHeaderName)).toBe(false);
    }
  });

  it('emits exactly the configured beta, merging case-variant header names', () => {
    const headers = anthropicUpstreamHeaders('token', false, 'api', {
      'Anthropic-Beta': ' alpha-2026-01-01 , beta-2026-02-02 ,, alpha-2026-01-01 ',
      'anthropic-beta': 'beta-2026-02-02,Gamma-2026-03-03',
    });
    // Stable first-seen order, exact-token dedupe, preserved token case, one header only.
    expect(headers['anthropic-beta']).toBe('alpha-2026-01-01,beta-2026-02-02,Gamma-2026-03-03');
    expect(Object.keys(headers).filter(isAnthropicBetaHeaderName)).toEqual(['anthropic-beta']);
    expect(headers).not.toHaveProperty('Anthropic-Beta');
  });

  it('omits authentication headers for anonymous requests', () => {
    const headers = anthropicUpstreamHeaders('', false, 'none', {
      authorization: 'Bearer configured-secret',
      'X-API-Key': 'configured-secret',
      Cookie: 'session=configured-secret',
      'Proxy-Authorization': 'Bearer configured-secret',
      'X-Auth-Token': 'configured-secret',
      'X-Client-Secret': 'configured-secret',
      'X-Credential-Id': 'configured-secret',
      'X-Custom': 'preserved',
    });

    for (const name of [
      'Authorization',
      'authorization',
      'x-api-key',
      'X-API-Key',
      'Cookie',
      'Proxy-Authorization',
      'X-Auth-Token',
      'X-Client-Secret',
      'X-Credential-Id',
    ]) {
      expect(headers).not.toHaveProperty(name);
    }
    expect(headers).toMatchObject({
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'X-Custom': 'preserved',
    });
  });

  it('preserves configured provider headers for authenticated requests', () => {
    expect(anthropicUpstreamHeaders(
      'oauth-token',
      false,
      'oauth',
      { 'X-Plan': 'coding' },
    )).toMatchObject({
      Authorization: 'Bearer oauth-token',
      'X-Plan': 'coding',
    });
  });

  it('keeps a configured beta on an anonymous route while still dropping credentials', () => {
    const headers = anthropicUpstreamHeaders('', false, 'none', {
      'ANTHROPIC-BETA': 'alpha-2026-01-01',
      Authorization: 'Bearer configured-secret',
    });
    expect(headers['anthropic-beta']).toBe('alpha-2026-01-01');
    expect(headers).not.toHaveProperty('Authorization');
    expectNoSynthesizedIdentity(headers);
  });

  it.each(['api', 'oauth', 'none'] as const)(
    'emits an earned capability beta on a %s route, and nothing else the client asked for',
    authType => {
      const headers = anthropicUpstreamHeaders('token', false, authType, { 'X-Plan': 'coding' }, capability({
        clientBeta: [CONTEXT_1M_BETA, TOOL_SEARCH_GATEWAY_BETA, 'client-alpha'],
        body: { tools: TOOL_SEARCH_TOOLS },
      }));
      expect(headers['anthropic-beta']).toBe(`${CONTEXT_1M_BETA},${TOOL_SEARCH_GATEWAY_BETA}`);
      expect(headers['X-Plan']).toBe('coding');
      expect(JSON.stringify(headers)).not.toContain('client-alpha');
      expect(Object.keys(headers).filter(isAnthropicBetaHeaderName)).toEqual(['anthropic-beta']);
      expectNoSynthesizedIdentity(headers);
    },
  );

  it.each(['api', 'oauth', 'none'] as const)(
    'emits no beta at all on a %s route when the predicate is false',
    authType => {
      const headers = anthropicUpstreamHeaders('token', false, authType, undefined, capability({
        // Exact capability tokens, but the route advertises 200K and the
        // request is an ordinary tool call.
        clientBeta: [CONTEXT_1M_BETA, ...TOOL_SEARCH_BETAS],
        advertisedContextWindow: 200_000,
        body: { tools: ORDINARY_TOOLS },
      }));
      expect(headers).not.toHaveProperty('anthropic-beta');
      expect(Object.keys(headers).some(isAnthropicBetaHeaderName)).toBe(false);
    },
  );

  it('unions the operator-configured beta with the earned capability, configured first', () => {
    const headers = anthropicUpstreamHeaders('token', true, 'oauth', {
      'Anthropic-Beta': 'cfg-a , cfg-b',
      'anthropic-beta': 'cfg-b',
    }, capability({ clientBeta: [CONTEXT_1M_BETA] }));
    expect(headers['anthropic-beta']).toBe(`cfg-a,cfg-b,${CONTEXT_1M_BETA}`);
    expect(Object.keys(headers).filter(isAnthropicBetaHeaderName)).toEqual(['anthropic-beta']);
  });
});

describe('capability betas are earned per request, never allowlisted', () => {
  describe('endpoint role is recomputed from the destination', () => {
    it.each([
      ['https://api.anthropic.com/v1/messages', 'messages'],
      ['https://api.anthropic.com/v1/messages/count_tokens', 'count_tokens'],
      // A base URL may carry a path prefix; the well-known suffix still matches.
      ['https://gateway.example/api/anthropic/v1/messages', 'messages'],
      ['https://gateway.example/api/anthropic/v1/messages/count_tokens', 'count_tokens'],
    ])('classifies %s as %s', (url, expected) => {
      expect(classifyAnthropicCapabilityEndpoint(url)).toBe(expected);
    });

    it.each([
      ['https://api.openai.com/v1/chat/completions'],
      ['https://api.anthropic.com/v1/complete'],
      ['https://api.anthropic.com/v1/messages/batches'],
      ['https://api.anthropic.com/'],
      ['not-a-url'],
      [''],
    ])('refuses %s', url => {
      expect(classifyAnthropicCapabilityEndpoint(url)).toBeUndefined();
    });
  });

  describe('context-1m', () => {
    it.each([
      ['/v1/messages', ANTHROPIC_MESSAGES_URL],
      ['/v1/messages/count_tokens', 'https://api.anthropic.com/v1/messages/count_tokens'],
    ])('admits the exact token on %s when the route really advertises 1M', (_label, url) => {
      expect(resolveCapabilityBetaTokens(capability({ url, clientBeta: [CONTEXT_1M_BETA] })))
        .toEqual([CONTEXT_1M_BETA]);
    });

    it.each([
      ['a token that merely looks related', { clientBeta: ['context-1m'] }],
      ['a drifted version of the token', { clientBeta: ['context-1m-2026-08-07'] }],
      ['a case variant of the token', { clientBeta: ['Context-1M-2025-08-07'] }],
      ['no inbound token at all', { clientBeta: [] }],
      ['a requested id without the [1m] surface', {
        clientBeta: [CONTEXT_1M_BETA],
        requestedModelId: 'claude-sonnet-4-6',
      }],
      ['a route whose window is below the threshold', {
        clientBeta: [CONTEXT_1M_BETA],
        advertisedContextWindow: 200_000,
      }],
      ['a window one token short of the threshold', {
        clientBeta: [CONTEXT_1M_BETA],
        advertisedContextWindow: 999_999,
      }],
      ['a translated OpenAI destination', {
        clientBeta: [CONTEXT_1M_BETA],
        url: 'https://api.openai.com/v1/chat/completions',
      }],
      ['a non-messages Anthropic endpoint', {
        clientBeta: [CONTEXT_1M_BETA],
        url: 'https://api.anthropic.com/v1/complete',
      }],
    ])('refuses with %s', (_label, over) => {
      expect(resolveCapabilityBetaTokens(capability(over))).toEqual([]);
    });

    it('is decided by the route, not by the credential scheme or provider label', () => {
      // No auth type, provider id, or destination host reaches this predicate:
      // there is no parameter for one. The same facts decide every route.
      const admitted = resolveCapabilityBetaTokens(capability({
        clientBeta: [CONTEXT_1M_BETA],
        url: 'https://anthropic.internal.example/v1/messages',
      }));
      expect(admitted).toEqual([CONTEXT_1M_BETA]);
    });
  });

  describe('tool search', () => {
    it.each([
      ['first-party/proxy presentation', TOOL_SEARCH_FIRST_PARTY_BETA],
      ['gateway/third-party presentation', TOOL_SEARCH_GATEWAY_BETA],
    ])('admits the %s token on a tool-search request shape', (_label, token) => {
      expect(resolveCapabilityBetaTokens(capability({
        clientBeta: [token],
        body: { tools: TOOL_SEARCH_TOOLS },
      }))).toEqual([token]);
    });

    it.each([
      ['first-party/proxy presentation', TOOL_SEARCH_FIRST_PARTY_BETA],
      ['gateway/third-party presentation', TOOL_SEARCH_GATEWAY_BETA],
    ])('admits the %s token on a deferred-tool request shape', (_label, token) => {
      expect(resolveCapabilityBetaTokens(capability({
        clientBeta: [token],
        body: { tools: DEFERRED_TOOLS },
      }))).toEqual([token]);
    });

    it('admits both presentations at once in fixed policy order', () => {
      expect(resolveCapabilityBetaTokens(capability({
        // Inbound order reversed: the emitted order is the policy's, not the client's.
        clientBeta: [TOOL_SEARCH_GATEWAY_BETA, TOOL_SEARCH_FIRST_PARTY_BETA],
        body: { tools: TOOL_SEARCH_TOOLS },
      }))).toEqual([TOOL_SEARCH_FIRST_PARTY_BETA, TOOL_SEARCH_GATEWAY_BETA]);
    });

    it.each([
      ['an ordinary tool request', { tools: ORDINARY_TOOLS }],
      ['defer_loading explicitly false', { tools: [{ name: 'Read', defer_loading: false }] }],
      ['a defer_loading string rather than true', { tools: [{ name: 'Read', defer_loading: 'true' }] }],
      ['a tool type that only resembles tool search', { tools: [{ type: 'tool_search', name: 'x' }] }],
      ['a tool merely NAMED for tool search', { tools: [{ name: 'tool_search_tool_regex' }] }],
      ['a tool-search RESULT block in the body root', { tools: [], type: 'tool_search_tool_result' }],
      ['no tools array', { model: 'm' }],
      ['a non-array tools field', { tools: { type: 'tool_search_tool_regex_20251119' } }],
      ['a null entry in tools', { tools: [null] }],
      ['a non-object body', 'tool_search_tool_regex_20251119'],
    ])('refuses both tokens for %s', (_label, body) => {
      for (const token of TOOL_SEARCH_BETAS) {
        expect(resolveCapabilityBetaTokens(capability({ clientBeta: [token], body }))).toEqual([]);
      }
    });

    it('refuses a drifted tool-search token even on a real tool-search request', () => {
      expect(resolveCapabilityBetaTokens(capability({
        clientBeta: ['tool-search-tool-2026-10-19', 'advanced-tool-use-2026-11-20'],
        body: { tools: TOOL_SEARCH_TOOLS },
      }))).toEqual([]);
    });

    it('refuses on a translated destination even with the exact token and shape', () => {
      for (const token of TOOL_SEARCH_BETAS) {
        expect(resolveCapabilityBetaTokens(capability({
          clientBeta: [token],
          body: { tools: TOOL_SEARCH_TOOLS },
          url: 'https://generativelanguage.googleapis.com/v1beta/models',
        }))).toEqual([]);
      }
    });
  });

  it('admits nothing for an arbitrary client beta, however it is packaged', () => {
    expect(resolveCapabilityBetaTokens(capability({
      clientBeta: normalizeBetaTokens([
        'client-alpha, client-beta',
        'oauth-2025-04-20',
        'skills-2025-10-02',
        'claude-code-20250219',
      ]),
      body: { tools: [...TOOL_SEARCH_TOOLS, ...DEFERRED_TOOLS] },
    }))).toEqual([]);
  });

  it('admits each capability independently when both are earned', () => {
    expect(resolveCapabilityBetaTokens(capability({
      clientBeta: [CONTEXT_1M_BETA, TOOL_SEARCH_GATEWAY_BETA, 'client-alpha'],
      body: { tools: TOOL_SEARCH_TOOLS },
    }))).toEqual([CONTEXT_1M_BETA, TOOL_SEARCH_GATEWAY_BETA]);
  });

  describe('configured union', () => {
    it('keeps configured tokens first, in their own order, then the capability', () => {
      expect(resolveOutboundBeta(
        { 'Anthropic-Beta': 'cfg-b , cfg-a', 'anthropic-beta': 'cfg-a' },
        capability({ clientBeta: [CONTEXT_1M_BETA] }),
      )).toEqual({ source: 'configured+capability', value: `cfg-b,cfg-a,${CONTEXT_1M_BETA}` });
    });

    it('dedupes a capability token the operator already configured', () => {
      expect(resolveOutboundBeta(
        { 'anthropic-beta': `cfg-a,${CONTEXT_1M_BETA}` },
        capability({ clientBeta: [CONTEXT_1M_BETA] }),
      )).toEqual({ source: 'configured', value: `cfg-a,${CONTEXT_1M_BETA}` });
    });

    it('treats a case-variant configured token as a different exact token', () => {
      // Token case is never folded: an operator spelling and the canonical
      // capability spelling are two tokens, and both are emitted.
      expect(resolveOutboundBeta(
        { 'anthropic-beta': 'CONTEXT-1M-2025-08-07' },
        capability({ clientBeta: [CONTEXT_1M_BETA] }),
      )).toEqual({
        source: 'configured+capability',
        value: `CONTEXT-1M-2025-08-07,${CONTEXT_1M_BETA}`,
      });
    });

    it('reports capability-only and none exactly', () => {
      expect(resolveOutboundBeta(undefined, capability({ clientBeta: [CONTEXT_1M_BETA] })))
        .toEqual({ source: 'capability', value: CONTEXT_1M_BETA });
      expect(resolveOutboundBeta(undefined, capability({ clientBeta: ['client-alpha'] })))
        .toEqual({ source: 'none' });
    });

    it('is byte-identical to the configured-only result when no capability is passed', () => {
      for (const headers of [
        undefined,
        { 'X-Plan': 'coding' },
        { 'Anthropic-Beta': ' cfg-a , cfg-b ,, cfg-a ', 'anthropic-beta': 'Cfg-C' },
      ]) {
        expect(resolveOutboundBeta(headers, undefined)).toEqual(resolveOutboundBeta(headers));
      }
      // Configured operator authority survives with a capability present and unearned.
      expect(resolveOutboundBeta(
        { 'Anthropic-Beta': 'cfg-a' },
        capability({ clientBeta: ['client-alpha'] }),
      )).toEqual({ source: 'configured', value: 'cfg-a' });
    });
  });
});

describe('route-owned credential headers cannot collide', () => {
  /** Every configured spelling that normalizes to one wire header name. */
  const spellingsOf = (headers: Record<string, string>, name: string) =>
    Object.keys(headers).filter(key => key.trim().toLowerCase() === name);

  const COLLIDING = {
    authorization: 'Bearer configured-secret',
    Authorization: 'Bearer configured-secret-2',
    AUTHORIZATION: 'Bearer configured-secret-3',
    'x-api-key': 'configured-secret',
    'X-API-Key': 'configured-secret-2',
    'X-Api-Key ': 'configured-secret-3',
    'X-Plan': 'coding',
    'Anthropic-Beta': 'cfg-a',
  };

  it('lets an API-key route own both credential headers outright', () => {
    const headers = anthropicUpstreamHeaders('route-key', false, 'api', { ...COLLIDING });

    expect(spellingsOf(headers, 'authorization')).toEqual(['Authorization']);
    expect(spellingsOf(headers, 'x-api-key')).toEqual(['x-api-key']);
    expect(headers.Authorization).toBe('Bearer route-key');
    expect(headers['x-api-key']).toBe('route-key');
    // Never concatenated with a configured value.
    expect(JSON.stringify(headers)).not.toContain('configured-secret');
    // Ordinary configured headers survive untouched.
    expect(headers['X-Plan']).toBe('coding');
    expect(headers['anthropic-beta']).toBe('cfg-a');
  });

  it('lets an OAuth route own the bearer and carry no configured x-api-key', () => {
    const headers = anthropicUpstreamHeaders('oauth-token', false, 'oauth', { ...COLLIDING });

    expect(spellingsOf(headers, 'authorization')).toEqual(['Authorization']);
    expect(headers.Authorization).toBe('Bearer oauth-token');
    // OAuth authority is bearer-only: a configured x-api-key is not a second
    // credential it may carry.
    expect(spellingsOf(headers, 'x-api-key')).toEqual([]);
    expect(JSON.stringify(headers)).not.toContain('configured-secret');
    expect(headers['X-Plan']).toBe('coding');
  });

  it('keeps the anonymous route credential-free exactly as before', () => {
    const headers = anthropicUpstreamHeaders('', false, 'none', { ...COLLIDING });

    expect(spellingsOf(headers, 'authorization')).toEqual([]);
    expect(spellingsOf(headers, 'x-api-key')).toEqual([]);
    expect(headers['X-Plan']).toBe('coding');
    expect(headers['anthropic-beta']).toBe('cfg-a');
  });

  it('keeps the retry attempts collision-free and otherwise identical', async () => {
    const refreshToken = vi.fn(async () => 'refreshed-token');
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response('nope', { status: 401 })
        : new Response(JSON.stringify({ id: 'm', type: 'message', model: 'm', content: [] }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
    }));
    const res = new Writable({ write(_c, _e, cb) { cb(); } }) as never as Record<string, unknown>;
    res.writeHead = () => res;
    res.end = () => undefined;

    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'm' },
      'stale-token',
      false,
      { authType: 'oauth', refreshToken, extraHeaders: { ...COLLIDING } },
    );

    const attempts = vi.mocked(fetch).mock.calls.map(
      ([, init]) => (init?.headers ?? {}) as Record<string, string>,
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.Authorization).toBe('Bearer stale-token');
    expect(attempts[1]!.Authorization).toBe('Bearer refreshed-token');
    for (const headers of attempts) {
      expect(spellingsOf(headers, 'authorization')).toEqual(['Authorization']);
      expect(spellingsOf(headers, 'x-api-key')).toEqual([]);
      expect(JSON.stringify(headers)).not.toContain('configured-secret');
      expect(headers['anthropic-beta']).toBe('cfg-a');
    }
    vi.unstubAllGlobals();
  });
});

describe('anthropic beta policy tokens', () => {
  it('normalizes list and comma forms into stable-order exact tokens', () => {
    expect(normalizeBetaTokens(undefined)).toEqual([]);
    expect(normalizeBetaTokens('')).toEqual([]);
    expect(normalizeBetaTokens(' , ,, ')).toEqual([]);
    expect(normalizeBetaTokens('b , a,b')).toEqual(['b', 'a']);
    expect(normalizeBetaTokens([' b ', 'a,b', 'C'])).toEqual(['b', 'a', 'C']);
    // Exact-token dedupe: case variants are distinct upstream identifiers.
    expect(normalizeBetaTokens('alpha,ALPHA')).toEqual(['alpha', 'ALPHA']);
  });

  it('extracts and resolves configured beta case-insensitively', () => {
    expect(isAnthropicBetaHeaderName(' Anthropic-Beta ')).toBe(true);
    expect(isAnthropicBetaHeaderName('anthropic-beta-extra')).toBe(false);
    expect(extractConfiguredBetaTokens(undefined)).toEqual([]);
    expect(extractConfiguredBetaTokens({ 'X-Plan': 'coding' })).toEqual([]);
    expect(extractConfiguredBetaTokens({ 'ANTHROPIC-BETA': 'a,b', 'Anthropic-Beta': 'b,c' }))
      .toEqual(['a', 'b', 'c']);
    expect(resolveOutboundBeta(undefined)).toEqual({ source: 'none' });
    expect(resolveOutboundBeta({ 'anthropic-beta': ' , ' })).toEqual({ source: 'none' });
    expect(resolveOutboundBeta({ 'Anthropic-Beta': 'a, b' }))
      .toEqual({ source: 'configured', value: 'a,b' });
  });
});

describe('fetchWithOAuthRetry', () => {
  it('refreshes once on 401 and retries with the refreshed token', async () => {
    const refreshToken = vi.fn(async () => 'new-token');
    const cancel = vi.fn(async () => {});
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 401, body: { cancel } })
      .mockResolvedValueOnce({ status: 200 });

    const result = await fetchWithOAuthRetry('old-token', request, refreshToken);

    expect(result.response.status).toBe(200);
    expect(result.apiKey).toBe('new-token');
    expect(result.refreshed).toBe(true);
    expect(refreshToken).toHaveBeenCalledWith('old-token');
    expect(request).toHaveBeenNthCalledWith(1, 'old-token');
    expect(request).toHaveBeenNthCalledWith(2, 'new-token');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['the rejected token', 'old-token'],
    ['no token', null],
  ])('does not retry when resolution returns %s', async (_label, resolved) => {
    const refreshToken = vi.fn(async () => resolved);
    const cancel = vi.fn(async () => {});
    const request = vi.fn().mockResolvedValue({ status: 401, body: { cancel } });

    const result = await fetchWithOAuthRetry('old-token', request, refreshToken);

    expect(result.response.status).toBe(401);
    expect(result.refreshed).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('returns a second 401 without entering another refresh loop', async () => {
    const refreshToken = vi.fn(async () => 'new-token');
    const request = vi.fn().mockResolvedValue({ status: 401 });

    const result = await fetchWithOAuthRetry('old-token', request, refreshToken);

    expect(result.response.status).toBe(401);
    expect(result.apiKey).toBe('new-token');
    expect(result.refreshed).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });
});

describe('anthropicSseModelRewrite', () => {
  const collect = async (transform: Transform, chunks: string[]): Promise<string> => {
    const out: Buffer[] = [];
    transform.on('data', chunk => out.push(Buffer.from(chunk)));
    for (const chunk of chunks) transform.write(Buffer.from(chunk, 'utf8'));
    await new Promise<void>((resolve, reject) => {
      transform.on('end', resolve);
      transform.on('error', reject);
      transform.end();
    });
    return Buffer.concat(out).toString('utf8');
  };

  const messageStart = 'event: message_start\n'
    + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5","usage":{"input_tokens":1}}}\n\n';
  const textDelta = 'event: content_block_delta\n'
    + 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"model claude-sonnet-4-5"}}\n\n';

  it('rewrites only the message_start model and passes every other byte through', async () => {
    const out = await collect(anthropicSseModelRewrite('clodex:acme:sonnet[200k]'), [messageStart + textDelta]);
    expect(out).toContain('"model":"clodex:acme:sonnet[200k]"');
    expect(out).not.toContain('"model":"claude-sonnet-4-5"');
    // Content text mentioning the upstream id is untouched.
    expect(out).toContain('"text":"model claude-sonnet-4-5"');
    expect(out.endsWith('\n\n')).toBe(true);
  });

  it('rewrites a message_start split across chunk boundaries mid-field', async () => {
    const whole = messageStart + textDelta;
    const split = whole.indexOf('"model":"claude') + 12;
    const out = await collect(
      anthropicSseModelRewrite('alias-x'),
      [whole.slice(0, split), whole.slice(split)],
    );
    expect(out).toContain('"model":"alias-x"');
    expect(out).not.toContain('"model":"claude-sonnet-4-5"');
  });

  it('passes malformed data lines through unchanged', async () => {
    const malformed = 'data: {"type":"message_start","message":{oops\n\n';
    const out = await collect(anthropicSseModelRewrite('alias-x'), [malformed]);
    expect(out).toBe(malformed);
  });

  it('keeps CRLF line endings on the line it rewrites', async () => {
    // Splitting on \n leaves the \r on every line. Dropping it only from the
    // rewritten line would emit a stream with mixed endings, which is a framing
    // change rather than a model-id change.
    const crlf = 'event: message_start\r\n'
      + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5"}}\r\n\r\n';
    const out = await collect(anthropicSseModelRewrite('alias-x'), [crlf]);
    expect(out).toContain('"model":"alias-x"');
    expect(out).not.toContain('"model":"claude-sonnet-4-5"');
    // Every original line ending survives: no bare \n was introduced.
    expect(out.split('\n').length).toBe(crlf.split('\n').length);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  // Collect what reached the client *before* the stream ended, which is what a
  // relay is for. `collect` cannot see a stall: it ends the transform, so a
  // transform that emitted nothing until flush still returns the whole body.
  const collectBeforeEnd = async (
    transform: Transform,
    chunks: string[],
  ): Promise<{ streamed: string; total: string }> => {
    const out: Buffer[] = [];
    transform.on('data', chunk => out.push(Buffer.from(chunk)));
    for (const chunk of chunks) transform.write(Buffer.from(chunk, 'utf8'));
    await new Promise(resolve => setImmediate(resolve));
    const streamed = Buffer.concat(out).toString('utf8');
    await new Promise<void>((resolve, reject) => {
      transform.on('end', resolve);
      transform.on('error', reject);
      transform.end();
    });
    return { streamed, total: Buffer.concat(out).toString('utf8') };
  };

  const crOnly = 'event: message_start\r'
    + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5"}}\r\r'
    + 'event: ping\rdata: {"type":"ping"}\r\r';

  it('frames a CR-delimited stream instead of holding it until the upstream closes', async () => {
    // SSE terminates a line with CRLF, LF, or a bare CR. Splitting on \n alone
    // finds no line boundary at all in a CR-framed stream, so every byte
    // accumulates in the tail buffer and the client receives nothing until the
    // upstream closes — a stalled relay, not just a missed rewrite.
    const { streamed } = await collectBeforeEnd(anthropicSseModelRewrite('alias-x'), [crOnly]);
    expect(streamed).not.toBe('');
    expect(streamed).toContain('"model":"alias-x"');
  });

  it('emits a complete CR-delimited event before the upstream closes', async () => {
    const event = 'event: message_start\r'
      + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5"}}\r\r';
    const { streamed } = await collectBeforeEnd(anthropicSseModelRewrite('alias-x'), [event]);
    expect(streamed).toBe(event.replace('"model":"claude-sonnet-4-5"', '"model":"alias-x"'));
  });

  it('keeps CR-only line endings on the line it rewrites', async () => {
    const out = await collect(anthropicSseModelRewrite('alias-x'), [crOnly]);
    expect(out).toContain('"model":"alias-x"');
    expect(out).not.toContain('"model":"claude-sonnet-4-5"');
    // Framing is preserved exactly: no \n was introduced and no \r was lost.
    expect(out).not.toContain('\n');
    expect(out.split('\r').length).toBe(crOnly.split('\r').length);
  });

  it('does not split a CRLF whose halves land in different chunks', async () => {
    // Holding the trailing CR keeps a split CRLF as one internal delimiter in
    // spec-shaped framing; the emitted bytes are equivalent without the guard.
    const crlf = 'event: message_start\r\n'
      + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5"}}\r\n\r\n';
    const boundary = crlf.indexOf('\r\n') + 1;
    const out = await collect(
      anthropicSseModelRewrite('alias-x'),
      [crlf.slice(0, boundary), crlf.slice(boundary)],
    );
    expect(out).toContain('"model":"alias-x"');
    expect(out.replace(/\r\n/g, '')).not.toContain('\r');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out.split('\r\n').length).toBe(crlf.split('\r\n').length);
  });

  it('passes an LF stream through with its framing byte-for-byte', async () => {
    // Conservation for the ending Anthropic actually sends.
    const out = await collect(anthropicSseModelRewrite('alias-x'), [messageStart + textDelta]);
    expect(out).not.toContain('\r');
    expect(out).toBe((messageStart + textDelta).replace('"model":"claude-sonnet-4-5"', '"model":"alias-x"'));
  });
});

describe('relayAnthropicMessages responseModelOverride', () => {
  const makeRes = () => {
    const chunks: Buffer[] = [];
    let headers: Record<string, string> = {};
    let status = 0;
    const res = {
      writeHead(code: number, hdrs: Record<string, string>) { status = code; headers = hdrs; return res; },
      write(chunk: unknown) { chunks.push(Buffer.from(chunk as Buffer)); return true; },
      end(chunk?: unknown) { if (chunk) chunks.push(Buffer.from(chunk as Buffer)); res.finished = true; res.emit?.('finish'); },
      destroy() { /* noop */ },
      on() { return res; },
      once() { return res; },
      emit() { return false; },
      removeListener() { return res; },
      finished: false,
      body: () => Buffer.concat(chunks).toString('utf8'),
      status: () => status,
      headers: () => headers,
    };
    return res;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rewrites the JSON body model to the requested id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ id: 'msg_1', type: 'message', model: 'claude-sonnet-4-5', content: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const res = makeRes();
    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'claude-sonnet-4-5' },
      'key',
      false,
      { responseModelOverride: 'clodex:acme:sonnet[200k]' },
    );
    expect(res.status()).toBe(200);
    const body = JSON.parse(res.body()) as { model: string };
    expect(body.model).toBe('clodex:acme:sonnet[200k]');
    expect(res.headers()['Content-Length']).toBe(String(Buffer.byteLength(res.body())));
  });

  it('leaves the JSON body untouched without an override', async () => {
    const raw = JSON.stringify({ id: 'msg_1', type: 'message', model: 'claude-sonnet-4-5', content: [] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    const res = makeRes();
    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'claude-sonnet-4-5' },
      'key',
      false,
      {},
    );
    expect(res.body()).toBe(raw);
  });

  it('leaves a non-message JSON envelope untouched even with an override', async () => {
    // The SSE path only ever rewrites `message_start`; the JSON path must agree
    // and only rewrite an Anthropic Message. An error envelope that happens to
    // carry a `model` is not the assistant's answer, and rewriting it would
    // misreport which model produced the failure.
    const raw = JSON.stringify({
      type: 'error',
      model: 'claude-sonnet-4-5',
      error: { type: 'overloaded_error', message: 'upstream busy' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    const res = makeRes();
    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'claude-sonnet-4-5' },
      'key',
      false,
      { responseModelOverride: 'clodex:acme:sonnet[200k]' },
    );
    expect(res.body()).toBe(raw);
    expect(res.body()).not.toContain('clodex:acme:sonnet[200k]');
  });

  it('leaves a count_tokens-shaped body untouched even with an override', async () => {
    const raw = JSON.stringify({ input_tokens: 42, model: 'claude-sonnet-4-5' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    const res = makeRes();
    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages/count_tokens',
      { model: 'claude-sonnet-4-5' },
      'key',
      false,
      { responseModelOverride: 'clodex:acme:sonnet[200k]' },
    );
    expect(res.body()).toBe(raw);
  });
});

describe('relayAnthropicMessages streaming', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * A REAL Writable, unlike the object mock above: the streaming path reaches
   * the client through `.pipe(res)`, so a plain object never exercises it.
   * That is the gap this suite had — `anthropicSseModelRewrite` was well
   * covered directly, but deleting the `.pipe(...)` that installs it in the
   * relay left every test green.
   */
  function makeStreamRes() {
    const chunks: Buffer[] = [];
    let status = 0;
    let headers: Record<string, string> = {};
    const res = new Writable({
      write(chunk: Buffer, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    }) as Writable & {
      writeHead: (code: number, hdrs?: Record<string, string>) => unknown;
      body: () => string;
      status: () => number;
      headers: () => Record<string, string>;
    };
    res.writeHead = (code, hdrs) => { status = code; headers = hdrs ?? {}; return res; };
    res.body = () => Buffer.concat(chunks).toString('utf8');
    res.status = () => status;
    res.headers = () => headers;
    return res;
  }

  const SSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","model":"qwen3.8-max","content":[]}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  it('pipes the streaming body through the model rewrite', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(SSE, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    const res = makeStreamRes();
    const done = new Promise<void>(resolve => res.on('finish', () => resolve()));

    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'qwen3.8-max', stream: true },
      'key',
      true,
      { responseModelOverride: 'clodex:opencode-go:qwen3.8-max[1m]' },
    );
    await done;

    expect(res.status()).toBe(200);
    expect(res.headers()['Content-Type']).toBe('text/event-stream');
    const body = res.body();
    // The echo invariant: the client sees back exactly the id it asked for.
    expect(body).toContain('"model":"clodex:opencode-go:qwen3.8-max[1m]"');
    expect(body).not.toContain('"model":"qwen3.8-max"');
    // Every other line survives byte-for-byte.
    expect(body).toContain('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}');
    expect(body).toContain('event: message_stop');
  });

  it('streams through untouched without an override', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(SSE, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    const res = makeStreamRes();
    const done = new Promise<void>(resolve => res.on('finish', () => resolve()));

    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'qwen3.8-max', stream: true },
      'key',
      true,
      {},
    );
    await done;

    expect(res.body()).toBe(SSE);
  });
});

describe('relayAnthropicMessages outbound headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeStreamRes() {
    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk: Buffer, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    }) as Writable & { writeHead: (code: number, hdrs?: Record<string, string>) => unknown };
    res.writeHead = () => res;
    return res;
  }

  const capturedHeaders = () => vi.mocked(fetch).mock.calls.map(
    ([, init]) => (init?.headers ?? {}) as Record<string, string>,
  );

  const stubJsonOnce = () => vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ id: 'msg_1', type: 'message', model: 'm', content: [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )));

  /** Relay one non-streaming request and discard the response. */
  const relayJson = (
    options: Parameters<typeof relayAnthropicMessages>[5],
    url = 'https://upstream.example/v1/messages',
    body: Record<string, unknown> = { model: 'm' },
  ) => {
    const res = new Writable({ write(_c, _e, cb) { cb(); } }) as never as Record<string, unknown>;
    res.writeHead = () => res;
    res.end = () => undefined;
    return relayAnthropicMessages(res as never, url, body, 'key', false, options);
  };

  it('carries the configured beta and no client identity on the JSON path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ id: 'msg_1', type: 'message', model: 'm', content: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const res = new Writable({ write(_c, _e, cb) { cb(); } }) as never as {
      writeHead: (code: number, hdrs?: Record<string, string>) => unknown;
    };
    (res as { writeHead: unknown }).writeHead = () => res;
    (res as unknown as { end: unknown }).end = () => undefined;

    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'm' },
      'oauth-token',
      false,
      { authType: 'oauth', extraHeaders: { 'Anthropic-Beta': 'alpha-2026-01-01' } },
    );

    const [headers] = capturedHeaders();
    expect(headers!['anthropic-beta']).toBe('alpha-2026-01-01');
    expect(headers!.Authorization).toBe('Bearer oauth-token');
    expect(headers).not.toHaveProperty('x-api-key');
    expectNoSynthesizedIdentity(headers!);
  });

  it('sends byte-identical headers on the streaming and refresh-retry attempts', async () => {
    const refreshToken = vi.fn(async () => 'refreshed-token');
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response('nope', { status: 401 })
        : new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
            status: 200, headers: { 'Content-Type': 'text/event-stream' },
          });
    }));
    const res = makeStreamRes();
    const done = new Promise<void>(resolve => res.on('finish', () => resolve()));

    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'm', stream: true },
      'stale-token',
      true,
      {
        authType: 'oauth',
        refreshToken,
        extraHeaders: { 'ANTHROPIC-BETA': 'alpha-2026-01-01,alpha-2026-01-01' },
      },
    );
    await done;

    const [first, second] = capturedHeaders();
    expect(refreshToken).toHaveBeenCalledOnce();
    expect(first!.Authorization).toBe('Bearer stale-token');
    expect(second!.Authorization).toBe('Bearer refreshed-token');
    for (const headers of [first!, second!]) {
      expect(headers['anthropic-beta']).toBe('alpha-2026-01-01');
      expect(headers.Accept).toBe('text/event-stream');
      expectNoSynthesizedIdentity(headers);
    }
    // Everything except the credential is identical across the retry.
    const stripAuth = (h: Record<string, string>) => {
      const { Authorization: _drop, ...rest } = h;
      return rest;
    };
    expect(stripAuth(second!)).toEqual(stripAuth(first!));
  });

  // Supersedes "offers no option channel for a client-supplied beta". The
  // capability channel now exists, so the property under test is no longer the
  // absence of a channel — it is that the channel forwards nothing a request
  // has not earned. The original property (no arbitrary client beta reaches an
  // upstream) is retained verbatim in the assertions below and, unchanged, in
  // "carries no beta at all when no option is passed".
  it('carries no beta at all when no option is passed', async () => {
    stubJsonOnce();
    await relayJson({ authType: 'api' });
    const [headers] = capturedHeaders();
    expect(headers).not.toHaveProperty('anthropic-beta');
    expectNoSynthesizedIdentity(headers!);
  });

  it('forwards nothing for an arbitrary client beta handed to the capability channel', async () => {
    stubJsonOnce();
    await relayJson({
      authType: 'api',
      capability: {
        clientBeta: ['client-alpha', 'client-beta', 'oauth-2025-04-20'],
        requestedModelId: 'm[1m]',
        advertisedModelId: 'm[1m]',
        advertisedContextWindow: 1_000_000,
      },
    });
    const [headers] = capturedHeaders();
    expect(headers).not.toHaveProperty('anthropic-beta');
    expect(JSON.stringify(headers)).not.toContain('client-');
    expectNoSynthesizedIdentity(headers!);
  });

  it('takes the destination and body from what it is sending, not from the caller', async () => {
    stubJsonOnce();
    // A tool-search token with a body that carries no tool-search shape: the
    // caller supplies neither the URL nor the body, so it cannot fake either.
    await relayJson({
      authType: 'api',
      capability: {
        clientBeta: [TOOL_SEARCH_GATEWAY_BETA],
        advertisedModelId: 'm',
      },
    });
    const [headers] = capturedHeaders();
    expect(headers).not.toHaveProperty('anthropic-beta');
  });

  it.each([
    ['/v1/messages', 'https://upstream.example/v1/messages'],
    ['/v1/messages/count_tokens', 'https://upstream.example/v1/messages/count_tokens'],
  ])('earns the capability on %s', async (_label, url) => {
    stubJsonOnce();
    await relayJson({
      authType: 'oauth',
      capability: {
        clientBeta: [CONTEXT_1M_BETA, TOOL_SEARCH_FIRST_PARTY_BETA],
        requestedModelId: 'm[1m]',
        advertisedModelId: 'm[1m]',
        advertisedContextWindow: 1_000_000,
      },
    }, url, { model: 'm', tools: TOOL_SEARCH_TOOLS });
    const [headers] = capturedHeaders();
    expect(headers!['anthropic-beta'])
      .toBe(`${CONTEXT_1M_BETA},${TOOL_SEARCH_FIRST_PARTY_BETA}`);
  });

  it('emits no capability beta on a non-Anthropic destination reached through this relay', async () => {
    stubJsonOnce();
    await relayJson({
      authType: 'api',
      capability: {
        clientBeta: [CONTEXT_1M_BETA, ...TOOL_SEARCH_BETAS],
        requestedModelId: 'm[1m]',
        advertisedModelId: 'm[1m]',
        advertisedContextWindow: 1_000_000,
      },
    }, 'https://upstream.example/v1/chat/completions', { model: 'm', tools: TOOL_SEARCH_TOOLS });
    const [headers] = capturedHeaders();
    expect(headers).not.toHaveProperty('anthropic-beta');
  });

  it('recomputes the same capability set on the SSE path and on the refresh retry', async () => {
    const refreshToken = vi.fn(async () => 'refreshed-token');
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response('nope', { status: 401 })
        : new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
            status: 200, headers: { 'Content-Type': 'text/event-stream' },
          });
    }));
    const res = makeStreamRes();
    const done = new Promise<void>(resolve => res.on('finish', () => resolve()));

    await relayAnthropicMessages(
      res as never,
      'https://upstream.example/v1/messages',
      { model: 'm', stream: true, tools: DEFERRED_TOOLS },
      'stale-token',
      true,
      {
        authType: 'oauth',
        refreshToken,
        extraHeaders: { 'ANTHROPIC-BETA': 'cfg-a' },
        capability: {
          clientBeta: [CONTEXT_1M_BETA, TOOL_SEARCH_GATEWAY_BETA, 'client-alpha'],
          requestedModelId: 'm[1m]',
          advertisedModelId: 'm[1m]',
          advertisedContextWindow: 1_000_000,
        },
      },
    );
    await done;

    const [first, second] = capturedHeaders();
    expect(refreshToken).toHaveBeenCalledOnce();
    const expected = `cfg-a,${CONTEXT_1M_BETA},${TOOL_SEARCH_GATEWAY_BETA}`;
    for (const headers of [first!, second!]) {
      expect(headers['anthropic-beta']).toBe(expected);
      expect(headers.Accept).toBe('text/event-stream');
      expect(JSON.stringify(headers)).not.toContain('client-alpha');
      expectNoSynthesizedIdentity(headers);
    }
    const stripAuth = (h: Record<string, string>) => {
      const { Authorization: _drop, ...rest } = h;
      return rest;
    };
    expect(stripAuth(second!)).toEqual(stripAuth(first!));
  });
});
