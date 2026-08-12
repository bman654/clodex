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

export type OutboundBetaResolution =
  | { readonly source: 'configured'; readonly value: string }
  | { readonly source: 'none' };

/**
 * Resolve the `anthropic-beta` header a routed upstream request may carry.
 *
 * Explicit configured provider beta wins; with no configured beta, none is
 * emitted. The client's inbound beta has no parameter to arrive through, so it
 * cannot reach a routed upstream — a client beta may travel the internal HTTP
 * adapter hop as non-authoritative context, and this boundary drops it.
 */
export function resolveOutboundBeta(
  configuredHeaders: Record<string, string> | undefined,
): OutboundBetaResolution {
  const tokens = extractConfiguredBetaTokens(configuredHeaders);
  return tokens.length > 0
    ? { source: 'configured', value: tokens.join(',') }
    : { source: 'none' };
}
