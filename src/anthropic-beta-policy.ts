// src/anthropic-beta-policy.ts — Negative-only Anthropic beta/identity policy.
//
// clodex ships no supported producer of generic Anthropic OAuth or routed
// `claude-code` OAuth credentials, and a provider id or auth type does not
// prove credential lineage. This module therefore models the NEGATIVE side of
// that policy only:
//
//   * it can classify a destination strictly enough to prove a URL negative;
//   * it always reports native-identity synthesis as suppressed;
//   * it resolves the outbound `anthropic-beta` header from a provider's
//     CONFIGURED headers, and from nothing else;
//   * it names the credential headers a route owns, so a configured spelling can
//     never ride alongside the route's own credential.
//
// There is deliberately no allow variant of the suppression result and no
// positive synthesis path. Adding one requires a separately approved supported
// native-Claude credential/template producer plus an immutable lineage
// authority; a route label, a provider id, an auth type, or a hand-built
// providerData object is none of those things and must never become one.
//
// Provenance and classification may never select or substitute a destination or
// an auth scheme. Every side-effect boundary recomputes from its current
// effective context, and the current result always suppresses synthesis.

import {
  ONE_M_CONTEXT_WINDOW,
  hasOneMContextSuffix,
} from './context-model-id.js';
import { resolveContextWindow } from './context-window.js';
import { TOOL_SEARCH_TYPE_PREFIX } from './tool-search.js';

/** Canonical outbound header name. Configured spellings are matched case-insensitively. */
export const ANTHROPIC_BETA_HEADER = 'anthropic-beta';

/**
 * The credential header names a route's own auth ownership sets — exactly these
 * two, matched case-insensitively after trimming.
 *
 * A configured header record can hold several spellings of one wire name
 * (`authorization`, `Authorization`, `AUTHORIZATION`) and a plain object keeps
 * them all; the HTTP layer then normalizes and APPENDS them, putting a
 * configured value and the route's own credential on a single header. Removing
 * every spelling before the route adds its canonical credential is what stops
 * the two from concatenating. Nothing beyond this exact pair is route-owned.
 */
const ROUTE_OWNED_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
]);

/** True for any case/whitespace spelling of a credential header the route owns. */
export function isRouteOwnedCredentialHeaderName(name: string): boolean {
  return ROUTE_OWNED_CREDENTIAL_HEADERS.has(name.trim().toLowerCase());
}

/**
 * The one fixed destination that native Claude traffic is addressed to. Private
 * on purpose: nothing outside this module may compare against it, because a
 * destination match grants nothing and must never be read as if it did.
 */
const CANONICAL_ANTHROPIC_HOST = 'api.anthropic.com';
const CANONICAL_ANTHROPIC_ORIGIN = `https://${CANONICAL_ANTHROPIC_HOST}`;

/** Why a destination is not the canonical fixed native Anthropic origin. */
export type AnthropicDestinationRejection =
  | 'malformed'
  | 'non-https'
  | 'userinfo'
  | 'host-mismatch'
  | 'non-default-port'
  | 'non-root-path'
  | 'query'
  | 'fragment';

export type AnthropicDestination =
  | { readonly kind: 'canonical-native'; readonly normalized: string }
  | { readonly kind: 'other'; readonly rejection: AnthropicDestinationRejection };

/**
 * Strictly classify an upstream base URL against the canonical native origin.
 *
 * Strict means every deviation is a rejection with a named reason: userinfo, a
 * query, a fragment, a non-root path, an explicit non-default port, a plaintext
 * scheme, a trailing-dot or subdomain host alias, or an unparseable value. Host
 * comparison uses the URL parser's own normalization, so an ASCII-case variant
 * of the canonical host still classifies as canonical while `api.anthropic.com.`
 * and `api.anthropic.com.example.test` do not.
 *
 * This exists to prove negatives. Classifying as `canonical-native` grants
 * nothing: it never selects a destination, an auth scheme, or an identity.
 */
export function classifyAnthropicDestination(raw: string | undefined): AnthropicDestination {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { kind: 'other', rejection: 'malformed' };
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { kind: 'other', rejection: 'malformed' };
  }
  if (url.protocol !== 'https:') return { kind: 'other', rejection: 'non-https' };
  if (url.username !== '' || url.password !== '') return { kind: 'other', rejection: 'userinfo' };
  if (url.hostname !== CANONICAL_ANTHROPIC_HOST) return { kind: 'other', rejection: 'host-mismatch' };
  if (url.port !== '') return { kind: 'other', rejection: 'non-default-port' };
  if (url.pathname !== '/' && url.pathname !== '') return { kind: 'other', rejection: 'non-root-path' };
  if (url.search !== '') return { kind: 'other', rejection: 'query' };
  if (url.hash !== '') return { kind: 'other', rejection: 'fragment' };
  return { kind: 'canonical-native', normalized: CANONICAL_ANTHROPIC_ORIGIN };
}

/**
 * Why native-identity synthesis is suppressed. Both members suppress; the
 * distinction is diagnostic only.
 */
export type NativeIdentitySuppressionReason =
  /** No supported producer of native Claude credentials exists, so no lineage can be proven. */
  | 'no-supported-native-credential-producer'
  /** The destination is not even the canonical fixed native origin. */
  | 'destination-not-canonical-native';

/**
 * The result of asking whether native Claude identity may be synthesized.
 *
 * By construction this type carries a reason and nothing else: it has no allow
 * variant, so no caller can branch into synthesis and no future edit can flip a
 * boolean to enable one.
 */
export interface NativeIdentitySuppression {
  readonly reason: NativeIdentitySuppressionReason;
}

/**
 * Always suppresses. The production positive native-identity set is empty, so
 * the only input that can vary is the diagnostic reason.
 *
 * The function deliberately accepts the destination and NOTHING else. Provider
 * id, auth type, and stored providerData have no parameter to arrive through,
 * which is what makes "no route label or hand-built object can enable
 * synthesis" a structural property rather than a behavioural check.
 */
export function resolveNativeIdentitySuppression(
  destinationUrl: string | undefined,
): NativeIdentitySuppression {
  return classifyAnthropicDestination(destinationUrl).kind === 'canonical-native'
    ? { reason: 'no-supported-native-credential-producer' }
    : { reason: 'destination-not-canonical-native' };
}

/** True for any case/whitespace spelling of the `anthropic-beta` header name. */
export function isAnthropicBetaHeaderName(name: string): boolean {
  return name.trim().toLowerCase() === ANTHROPIC_BETA_HEADER;
}

/**
 * Normalize beta values into stable-order exact tokens.
 *
 * Accepts the list and comma forms already representable in the current header
 * types (`string | string[]`), splits on commas, trims, drops empties, and
 * dedupes exact tokens keeping the first occurrence. Token case is preserved:
 * a beta token is an opaque upstream identifier, not something to fold.
 */
export function normalizeBetaTokens(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  const raw = typeof value === 'string' ? [value] : value;
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    for (const part of entry.split(',')) {
      const token = part.trim();
      if (token === '' || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Collect a provider's configured beta tokens, merging every case-insensitive
 * spelling of the header name in the record's own key order.
 */
export function extractConfiguredBetaTokens(
  headers: Record<string, string> | undefined,
): string[] {
  if (!headers) return [];
  const values: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (isAnthropicBetaHeaderName(name) && typeof value === 'string') values.push(value);
  }
  return normalizeBetaTokens(values);
}

// ── Capability betas ────────────────────────────────────────────────────────
//
// A routed Anthropic-protocol request can legitimately REQUIRE a per-request beta.
// Claude Code emits `context-1m-2025-08-07` whenever the model id clodex handed
// it carries the `[1m]` suffix, and one of the two tool-search betas whenever it
// sends a tool-search / deferred-tool request. Dropping those made clodex
// advertise a surface that the forwarded request then failed to claim: the 1M
// window clodex itself advertised was silently served as 200K, and a
// tool-search request was rejected by the upstream that never saw its beta.
//
// This is NOT a token allowlist, and a token name alone admits nothing. Each
// token is admitted only when the request independently proves the feature is
// in use: the EXACT inbound token, an Anthropic-protocol Messages/count_tokens
// ENDPOINT PATH recomputed from the URL actually being called, and a per-token
// predicate over the resolved route and the exact forwarded body. The check is
// on the path, not the host: any third-party provider clodex routes to over the
// Anthropic protocol qualifies, which is deliberate — those routes serve the
// same beta-gated request shapes. (Host is a separate question, and it is
// answered separately by the native-identity suppression above, which grants
// nothing either way.) A token whose predicate is false is dropped exactly like
// an arbitrary one. An unknown or version-drifted token has no predicate at all
// and therefore fails closed.
//
// Adding a token here requires a named supported feature, an exact
// route/request predicate, and tests for the positive and every negative.

/** Long-context capability beta; canonical fixed spelling, matched exactly. */
export const CONTEXT_1M_BETA = 'context-1m-2025-08-07';

/**
 * The two tool-search capability betas, canonical fixed spellings.
 *
 * Claude Code picks between them by PRESENTATION, not by feature: the
 * first-party/proxy presentation sends `advanced-tool-use-2025-11-20` and the
 * gateway/third-party presentation (also selected when the child runs with
 * experimental betas disabled) sends `tool-search-tool-2025-10-19`. clodex
 * routes both presentations, so both are admissible — and both are gated by the
 * same request-shape predicate, because the request shape is what the beta
 * actually unlocks.
 */
export const TOOL_SEARCH_BETAS: readonly string[] = [
  'advanced-tool-use-2025-11-20',
  'tool-search-tool-2025-10-19',
];

/** The Anthropic-protocol endpoint paths a capability beta may ride on. */
export type AnthropicCapabilityEndpoint = 'messages' | 'count_tokens';

/**
 * Classify the URL a routed request is about to be sent to.
 *
 * The endpoint role is recomputed here from the destination itself rather than
 * taken from a caller's word for it, so a boundary shared with a translated
 * route (the direct OpenAI chat-completions relay reuses this same header
 * builder) can never admit a capability beta by being handed the wrong context.
 * Base URLs may carry a path prefix, so the well-known suffix is what matches.
 */
export function classifyAnthropicCapabilityEndpoint(
  url: string,
): AnthropicCapabilityEndpoint | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  if (path.endsWith('/v1/messages/count_tokens')) return 'count_tokens';
  if (path.endsWith('/v1/messages')) return 'messages';
  return undefined;
}

/**
 * The route facts a capability predicate is evaluated against. Every field is
 * a fact about the resolved route or the inbound request — there is
 * deliberately no "allow" flag, so a propagated boolean cannot admit anything.
 */
export interface AnthropicCapabilityRouteFacts {
  /** Exact inbound `anthropic-beta` tokens, normalized. Non-authoritative. */
  readonly clientBeta: readonly string[];
  /** The model id the client addressed, before any upstream rewrite. */
  readonly requestedModelId?: string;
  /** The catalog/alias id this route advertises to the client. */
  readonly advertisedModelId: string;
  /** The route's immutable configured context window, when one is configured. */
  readonly advertisedContextWindow?: number;
}

/**
 * A full capability evaluation: route facts plus the destination and body the
 * final boundary is actually about to send. The relay supplies `url` and `body`
 * from what it is sending, so a caller cannot misdescribe either.
 */
export interface AnthropicCapabilityRequest extends AnthropicCapabilityRouteFacts {
  readonly url: string;
  readonly body: unknown;
}

/**
 * True when the route really resolves a 1M window AND the client addressed the
 * `[1m]` surface.
 *
 * Both halves are required and neither implies the other. The window is the
 * route's own immutable fact (configured value, else the id's resolved window);
 * the suffix on the requested id is the exact condition under which Claude Code
 * emits the token at all, so a token arriving without it did not come from the
 * capability this predicate governs.
 */
function requestUsesOneMContext(capability: AnthropicCapabilityRequest): boolean {
  if (!hasOneMContextSuffix(capability.requestedModelId ?? '')) return false;
  // Resolved from the UNSTRIPPED advertised id, exactly as the advertisement
  // surfaces do. With no configured window the id is the only evidence, and
  // `context-window` carries a heuristic that fires only on a full `[1m]` id —
  // so stripping first resolved a different window than the one advertised and
  // denied the beta on a route that had genuinely advertised 1M. A configured
  // window still wins outright; only this fallback reads the id.
  const window = resolveContextWindow(
    capability.advertisedModelId,
    capability.advertisedContextWindow,
  );
  return window >= ONE_M_CONTEXT_WINDOW;
}

/**
 * True when the forwarded body structurally uses tool search.
 *
 * Both markers are beta-gated request fields of the one capability: a
 * `tool_search_tool_*`-typed server tool, and a tool carrying `defer_loading`.
 * Either alone is enough — Claude Code sends the tool-search tool with no
 * deferred tool while MCP servers are still connecting, and sends deferred
 * tools once they are discovered. An ordinary tool (name/description/schema)
 * matches neither, so an ordinary request cannot admit the token.
 */
function requestUsesToolSearch(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const tools = (body as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return false;
  return tools.some(tool => {
    if (!tool || typeof tool !== 'object') return false;
    const entry = tool as { type?: unknown; defer_loading?: unknown };
    if (typeof entry.type === 'string' && entry.type.startsWith(TOOL_SEARCH_TYPE_PREFIX)) return true;
    return entry.defer_loading === true;
  });
}

/**
 * The capability tokens this exact request has earned, in fixed policy order.
 *
 * Returns the empty list for a URL whose path is not the Anthropic-protocol
 * Messages/count_tokens path, for a token that is not one of the fixed
 * capability literals, and for a capability literal whose request predicate is
 * false. Host is not part of this decision.
 */
export function resolveCapabilityBetaTokens(
  capability: AnthropicCapabilityRequest,
): string[] {
  if (classifyAnthropicCapabilityEndpoint(capability.url) === undefined) return [];
  const inbound = new Set(capability.clientBeta);
  const admitted: string[] = [];
  if (inbound.has(CONTEXT_1M_BETA) && requestUsesOneMContext(capability)) {
    admitted.push(CONTEXT_1M_BETA);
  }
  if (requestUsesToolSearch(capability.body)) {
    for (const token of TOOL_SEARCH_BETAS) {
      if (inbound.has(token)) admitted.push(token);
    }
  }
  return admitted;
}

export type OutboundBetaResolution =
  | {
      readonly source: 'configured' | 'capability' | 'configured+capability';
      readonly value: string;
    }
  | { readonly source: 'none' };

/**
 * Resolve the `anthropic-beta` header a routed upstream request may carry.
 *
 * Configured provider beta is explicit operator authority and always survives,
 * first and in its own order. A validated capability token is appended after
 * it, deduped against it by exact token. With neither, none is emitted.
 *
 * The client's inbound beta reaches this function only inside `capability`,
 * where it is one input to a predicate rather than a value to forward: a
 * caller that omits `capability` gets the configured-only result byte for byte,
 * which is what keeps the SDK construction path and the translated routes
 * unchanged.
 */
export function resolveOutboundBeta(
  configuredHeaders: Record<string, string> | undefined,
  capability?: AnthropicCapabilityRequest,
): OutboundBetaResolution {
  const configured = extractConfiguredBetaTokens(configuredHeaders);
  const admitted = (capability ? resolveCapabilityBetaTokens(capability) : [])
    .filter(token => !configured.includes(token));
  if (configured.length === 0 && admitted.length === 0) return { source: 'none' };
  const source = configured.length === 0
    ? 'capability'
    : admitted.length === 0
      ? 'configured'
      : 'configured+capability';
  return { source, value: [...configured, ...admitted].join(',') };
}
