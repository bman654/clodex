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

export const UNSUPPORTED_EFFORT_POLICIES = [
  'provider-default',
  'up',
  'down',
  'exact',
] as const;

export type UnsupportedEffortPolicy = (typeof UNSUPPORTED_EFFORT_POLICIES)[number];

export const DEFAULT_UNSUPPORTED_EFFORT_POLICY: UnsupportedEffortPolicy = 'provider-default';
export const EFFORT_RESOLUTION_HEADER = 'x-clodex-effort-resolution';
export const MAX_EFFORT_RESOLUTION_WARNINGS = 32;

interface EffortResolutionBase {
  policy: UnsupportedEffortPolicy;
  requestedEffort: CanonicalEffortLevel;
}

export interface ExactEffortResolution extends EffortResolutionBase {
  kind: 'exact';
  resolvedEffort: CanonicalEffortLevel;
}

export interface RoundedEffortResolution extends EffortResolutionBase {
  kind: 'rounded';
  policy: 'up' | 'down';
  resolvedEffort: CanonicalEffortLevel;
  /** True when no level existed in the requested direction and the opposite edge was used. */
  saturated: boolean;
}

export interface ProviderDefaultEffortResolution extends EffortResolutionBase {
  kind: 'provider-default';
  policy: 'provider-default';
  resolvedEffort: undefined;
}

export type EffortResolution =
  | ExactEffortResolution
  | RoundedEffortResolution
  | ProviderDefaultEffortResolution;

function safeDiagnosticComponent(value: string): string {
  const bounded = value.slice(0, 128);
  try {
    return encodeURIComponent(bounded);
  } catch {
    return 'invalid-unicode';
  }
}

/** Safe, compact value for the x-clodex-effort-resolution response header. */
export function effortResolutionDiagnostic(
  resolution: EffortResolution,
  context?: { targetId?: string; supportedLevels?: readonly string[] },
): string | undefined {
  if (resolution.kind === 'exact') return undefined;
  const target = context?.targetId
    ? `;target=${safeDiagnosticComponent(context.targetId)}`
    : '';
  const supported = context?.supportedLevels
    ? `;supported=${context.supportedLevels.map(safeDiagnosticComponent).join('|') || 'none'}`
    : '';
  if (resolution.kind === 'rounded') {
    return `requested=${resolution.requestedEffort};resolved=${resolution.resolvedEffort};policy=${resolution.policy};saturated=${resolution.saturated}${target}${supported}`;
  }
  return `requested=${resolution.requestedEffort};resolved=provider-default;policy=${resolution.policy}${target}${supported}`;
}

export type EffortResolutionErrorCode =
  | 'invalid-effort'
  | 'invalid-policy'
  | 'invalid-supported-effort'
  | 'no-supported-efforts'
  | 'unsupported-effort';

export class EffortResolutionError extends Error {
  readonly code: EffortResolutionErrorCode;
  readonly statusCode: number;
  readonly requestedEffort?: string;
  readonly policy?: string;

  constructor(options: {
    code: EffortResolutionErrorCode;
    message: string;
    statusCode: number;
    requestedEffort?: string;
    policy?: string;
  }) {
    super(options.message);
    this.name = 'EffortResolutionError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.requestedEffort = options.requestedEffort;
    this.policy = options.policy;
  }
}

const CANONICAL_EFFORT_SET: ReadonlySet<string> = new Set(CANONICAL_EFFORT_LEVELS);
const UNSUPPORTED_EFFORT_POLICY_SET: ReadonlySet<string> = new Set(UNSUPPORTED_EFFORT_POLICIES);

// `off` and `none` are provider-specific spellings for the same semantic level.
// Keeping both in the canonical order gives ties a stable winner (`off`) without
// pretending that one spelling asks for more reasoning than the other.
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

function canonicalSupportedLevels(levels: readonly string[]): CanonicalEffortLevel[] {
  if (levels.some(level => !isCanonicalEffortLevel(level))) {
    throw new EffortResolutionError({
      code: 'invalid-supported-effort',
      message: 'Model effort capabilities contain a non-canonical level.',
      statusCode: 500,
    });
  }

  const supported = new Set(levels);
  return CANONICAL_EFFORT_LEVELS.filter(level => supported.has(level));
}

function edgeLevel(
  levels: readonly CanonicalEffortLevel[],
  edge: 'lowest' | 'highest',
): CanonicalEffortLevel {
  const edgeRank = edge === 'lowest'
    ? Math.min(...levels.map(level => EFFORT_RANK[level]))
    : Math.max(...levels.map(level => EFFORT_RANK[level]));

  // `levels` is already in canonical order, which deterministically breaks the
  // `off`/`none` semantic-rank tie.
  return levels.find(level => EFFORT_RANK[level] === edgeRank)!;
}

function nearestLevel(
  requestedEffort: CanonicalEffortLevel,
  supportedLevels: readonly CanonicalEffortLevel[],
  policy: 'up' | 'down',
): { resolvedEffort: CanonicalEffortLevel; saturated: boolean } {
  const requestedRank = EFFORT_RANK[requestedEffort];
  const directional = supportedLevels.filter(level => (
    policy === 'up'
      ? EFFORT_RANK[level] >= requestedRank
      : EFFORT_RANK[level] <= requestedRank
  ));

  if (directional.length === 0) {
    return {
      resolvedEffort: edgeLevel(supportedLevels, policy === 'up' ? 'highest' : 'lowest'),
      saturated: true,
    };
  }

  return {
    resolvedEffort: edgeLevel(directional, policy === 'up' ? 'lowest' : 'highest'),
    saturated: false,
  };
}

/**
 * Resolve one explicit client effort against a model's exact effort ladder.
 *
 * The function is pure: it neither mutates the supplied ladder nor applies a
 * provider default itself. A `provider-default` result deliberately carries an
 * undefined effort so the caller can omit the wire field while still reporting
 * that decision.
 */
export function resolveEffort(
  requestedEffort: string,
  supportedEffortLevels: readonly string[],
  policy: UnsupportedEffortPolicy = DEFAULT_UNSUPPORTED_EFFORT_POLICY,
): EffortResolution {
  if (!isCanonicalEffortLevel(requestedEffort)) {
    throw new EffortResolutionError({
      code: 'invalid-effort',
      message: `Invalid effort level. Expected one of: ${CANONICAL_EFFORT_LEVELS.join(', ')}.`,
      statusCode: 400,
      requestedEffort,
      policy,
    });
  }
  if (!isUnsupportedEffortPolicy(policy)) {
    throw new EffortResolutionError({
      code: 'invalid-policy',
      message: 'Configured effort policy is invalid.',
      statusCode: 500,
      requestedEffort,
      policy,
    });
  }

  const supportedLevels = canonicalSupportedLevels(supportedEffortLevels);
  if (supportedLevels.includes(requestedEffort)) {
    return {
      kind: 'exact',
      policy,
      requestedEffort,
      resolvedEffort: requestedEffort,
    };
  }

  if (policy === 'provider-default') {
    return {
      kind: 'provider-default',
      policy,
      requestedEffort,
      resolvedEffort: undefined,
    };
  }

  if (supportedLevels.length === 0) {
    throw new EffortResolutionError({
      code: 'no-supported-efforts',
      message: `Effort "${requestedEffort}" cannot be applied because this model exposes no supported effort levels.`,
      statusCode: 400,
      requestedEffort,
      policy,
    });
  }

  if (policy === 'exact') {
    throw new EffortResolutionError({
      code: 'unsupported-effort',
      message: `Effort "${requestedEffort}" is unsupported. This model supports: ${supportedLevels.join(', ')}.`,
      statusCode: 400,
      requestedEffort,
      policy,
    });
  }

  const rounded = nearestLevel(requestedEffort, supportedLevels, policy);
  return {
    kind: 'rounded',
    policy,
    requestedEffort,
    ...rounded,
  };
}
