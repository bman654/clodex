// src/effort-policy.ts — one global effort vocabulary, one resolution.
//
// Every client-facing surface speaks the same eight levels. What a given model
// can actually run is its EFFORT PROFILE: the reviewed wire map for clodex's
// validated route, generated at build time with resolver variants retained only
// as cross-check evidence (see `scripts/update-opencode-go-models.mjs`). This
// module owns the question of what to do when a client asks for a level a profile does not
// carry, and nothing else — it reads no config, touches no request body, and
// picks no defaults of its own.

/** The global effort vocabulary, ascending. */
export const CANONICAL_EFFORT_LEVELS = [
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type CanonicalEffortLevel = (typeof CANONICAL_EFFORT_LEVELS)[number];

/**
 * What to do with an explicit effort the target model does not support.
 *
 * `provider-default` is the default and reproduces clodex's long-standing
 * behavior exactly: send no effort field and let the provider choose.
 */
export const UNSUPPORTED_EFFORT_POLICIES = ['provider-default', 'up', 'down', 'exact'] as const;

export type UnsupportedEffortPolicy = (typeof UNSUPPORTED_EFFORT_POLICIES)[number];

export const DEFAULT_UNSUPPORTED_EFFORT_POLICY: UnsupportedEffortPolicy = 'provider-default';

/**
 * How one global level is spelled on a model's own wire.
 *
 * Both arms exist because the resolver snapshot advertises both, and telling
 * them apart is what lets the generator DENY the one the running transport
 * cannot carry — an Anthropic thinking object offered for a model clodex routes
 * over Chat Completions. Only representations the reviewed route can execute
 * reach a profile.
 */
export type EffortNativeRepresentation =
  | { kind: 'reasoning-effort'; value: string }
  | { kind: 'anthropic-thinking'; thinking: Record<string, unknown> };

export interface EffortProfileLevel {
  level: CanonicalEffortLevel;
  native: EffortNativeRepresentation;
}

/** The reviewed, generated statement of one model's executable effort control. */
export interface EffortProfile {
  modelId: string;
  /** The reviewed route this profile describes, e.g. `openai-completions`. */
  transport: string;
  /**
   * The level to use when the client sends none. `null` means the provider
   * declares no default, so clodex sends nothing rather than inventing one.
   */
  defaultLevel: CanonicalEffortLevel | null;
  /** Executable levels, ascending. Empty means this route has no effort control at all. */
  levels: EffortProfileLevel[];
}

export type EffortResolutionOutcome =
  /** The requested level is executable and is sent as-is. */
  | 'exact'
  /** The requested level was unsupported and moved along the ladder. */
  | 'rounded-up'
  | 'rounded-down'
  /** The requested level was unsupported; no effort field is sent. */
  | 'provider-default'
  /** This route carries no clodex-operable effort control; no effort field is sent. */
  | 'no-effort-control';

export interface EffortResolution {
  requested: CanonicalEffortLevel;
  /** The level to send. `undefined` means send no effort field at all. */
  resolved?: CanonicalEffortLevel;
  outcome: EffortResolutionOutcome;
  /** True when rounding ran out of ladder and used the far edge instead. */
  saturated?: boolean;
}

export class EffortResolutionError extends Error {
  readonly statusCode: number;
  readonly requestedEffort: string;

  constructor(message: string, requestedEffort: string, statusCode = 400) {
    super(message);
    this.name = 'EffortResolutionError';
    this.statusCode = statusCode;
    this.requestedEffort = requestedEffort;
  }
}

const CANONICAL_EFFORT_SET: ReadonlySet<string> = new Set(CANONICAL_EFFORT_LEVELS);
const UNSUPPORTED_EFFORT_POLICY_SET: ReadonlySet<string> = new Set(UNSUPPORTED_EFFORT_POLICIES);

// `off` and `none` are two provider spellings of the same "do not reason"
// level, so they share a rank: neither asks for more reasoning than the other.
// Ties are broken by the canonical ORDER above, which is stable.
const EFFORT_RANK: Readonly<Record<CanonicalEffortLevel, number>> = {
  off: 0,
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

export function isCanonicalEffortLevel(value: string): value is CanonicalEffortLevel {
  return CANONICAL_EFFORT_SET.has(value);
}

export function isUnsupportedEffortPolicy(value: string): value is UnsupportedEffortPolicy {
  return UNSUPPORTED_EFFORT_POLICY_SET.has(value);
}

/** The executable levels of a profile, ascending. */
export function profileLevels(profile: EffortProfile): CanonicalEffortLevel[] {
  return profile.levels.map(entry => entry.level);
}

function supportedProfileLevel(
  profile: EffortProfile,
  requested: CanonicalEffortLevel,
): CanonicalEffortLevel | undefined {
  if (profile.levels.some(entry => entry.level === requested)) return requested;

  // Providers use both names for the same zero-reasoning state. Canonicalize
  // that equivalence before policy selection so `exact` cannot reject it and
  // `provider-default` cannot silently omit it on only one request path.
  if (requested === 'off' || requested === 'none') {
    const equivalent = requested === 'off' ? 'none' : 'off';
    if (profile.levels.some(entry => entry.level === equivalent)) return equivalent;
  }
  return undefined;
}

/**
 * The global level a value already spelled in the model's own wire vocabulary
 * stands for, if any.
 *
 * The direct chat-completions forward can receive either spelling: a client
 * that speaks clodex's global levels, or one that already wrote what the
 * upstream expects. Recognising the second is what stops a value being
 * translated twice — the generator guarantees the mapping is one-to-one, so
 * this lookup is unambiguous.
 */
export function nativeEffortLevel(
  profile: EffortProfile,
  value: string,
): CanonicalEffortLevel | undefined {
  return profile.levels.find(
    entry => entry.native.kind === 'reasoning-effort' && entry.native.value === value,
  )?.level;
}

function edgeLevel(
  levels: readonly EffortProfileLevel[],
  edge: 'lowest' | 'highest',
): CanonicalEffortLevel {
  // `levels` is generated in canonical order, so scanning it in that order
  // deterministically breaks the shared off/none rank.
  let winner = levels[0]!;
  for (const candidate of levels) {
    const better = edge === 'lowest'
      ? EFFORT_RANK[candidate.level] < EFFORT_RANK[winner.level]
      : EFFORT_RANK[candidate.level] > EFFORT_RANK[winner.level];
    if (better) winner = candidate;
  }
  return winner.level;
}

/**
 * Resolve one requested global level against a model's executable ladder.
 *
 * Pure: it neither reads the request nor applies the answer. A `resolved` of
 * `undefined` means "send no effort field", which is a decision, not a failure.
 *
 * An empty ladder is deliberately NOT an unsupported level. A route with no
 * clodex-operable effort control has nothing to round along and nothing to
 * reject against, so every policy omits the field there — including `exact`,
 * which exists to refuse a silent SUBSTITUTION, and makes none here.
 */
export function resolveEffort(
  requestedEffort: string,
  profile: EffortProfile,
  policy: UnsupportedEffortPolicy = DEFAULT_UNSUPPORTED_EFFORT_POLICY,
): EffortResolution {
  if (!isCanonicalEffortLevel(requestedEffort)) {
    throw new EffortResolutionError(
      `Unknown effort level "${requestedEffort}". Expected one of: ${CANONICAL_EFFORT_LEVELS.join(', ')}.`,
      requestedEffort,
    );
  }
  const requested = requestedEffort;

  if (profile.levels.length === 0) {
    return { requested, outcome: 'no-effort-control' };
  }
  const supported = supportedProfileLevel(profile, requested);
  if (supported !== undefined) {
    return { requested, resolved: supported, outcome: 'exact' };
  }

  if (policy === 'exact') {
    throw new EffortResolutionError(
      `Effort "${requested}" is not supported by ${profile.modelId}. `
      + `Supported levels: ${profileLevels(profile).join(', ')}.`,
      requested,
    );
  }
  if (policy !== 'up' && policy !== 'down') {
    return { requested, outcome: 'provider-default' };
  }

  const requestedRank = EFFORT_RANK[requested];
  const directional = profile.levels.filter(entry => (
    policy === 'up'
      ? EFFORT_RANK[entry.level] >= requestedRank
      : EFFORT_RANK[entry.level] <= requestedRank
  ));
  const saturated = directional.length === 0;
  const pool = saturated ? profile.levels : directional;
  const resolved = saturated
    ? edgeLevel(pool, policy === 'up' ? 'highest' : 'lowest')
    : edgeLevel(pool, policy === 'up' ? 'lowest' : 'highest');

  return {
    requested,
    resolved,
    outcome: policy === 'up' ? 'rounded-up' : 'rounded-down',
    saturated,
  };
}

/**
 * Resolve the effort for one request, including the omitted-effort case.
 *
 * A client that sends no effort gets the profile's DECLARED default, and only
 * that: where a provider declares none, clodex sends none.
 */
export function resolveRequestEffort(
  requestedEffort: string | undefined,
  profile: EffortProfile,
  policy: UnsupportedEffortPolicy = DEFAULT_UNSUPPORTED_EFFORT_POLICY,
): EffortResolution | undefined {
  const requested = requestedEffort ?? profile.defaultLevel ?? undefined;
  if (requested === undefined) return undefined;
  return resolveEffort(requested, profile, policy);
}
