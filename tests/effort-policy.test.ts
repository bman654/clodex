import { describe, expect, it } from 'vitest';
import {
  CANONICAL_EFFORT_LEVELS,
  DEFAULT_UNSUPPORTED_EFFORT_POLICY,
  EffortResolutionError,
  UNSUPPORTED_EFFORT_POLICIES,
  isCanonicalEffortLevel,
  isUnsupportedEffortPolicy,
  effortResolutionDiagnostic,
  resolveEffort,
  type CanonicalEffortLevel,
  type UnsupportedEffortPolicy,
} from '../src/effort-policy.js';

const ALL_POLICIES = [...UNSUPPORTED_EFFORT_POLICIES];

function caughtResolutionError(run: () => unknown): EffortResolutionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(EffortResolutionError);
    return error as EffortResolutionError;
  }
  throw new Error('Expected an EffortResolutionError');
}

describe('effort policy vocabulary', () => {
  it('defaults to provider-default', () => {
    expect(DEFAULT_UNSUPPORTED_EFFORT_POLICY).toBe('provider-default');
    expect(resolveEffort('medium', ['high'])).toEqual({
      kind: 'provider-default',
      policy: 'provider-default',
      requestedEffort: 'medium',
      resolvedEffort: undefined,
    });
  });

  it('recognizes only canonical effort levels and supported policies', () => {
    for (const level of CANONICAL_EFFORT_LEVELS) {
      expect(isCanonicalEffortLevel(level)).toBe(true);
    }
    for (const policy of ALL_POLICIES) {
      expect(isUnsupportedEffortPolicy(policy)).toBe(true);
    }
    expect(isCanonicalEffortLevel('MEDIUM')).toBe(false);
    expect(isCanonicalEffortLevel('turbo')).toBe(false);
    expect(isUnsupportedEffortPolicy('nearest')).toBe(false);
  });
});

describe('resolveEffort exact matches', () => {
  it.each(ALL_POLICIES)('passes every supported canonical level under %s', policy => {
    for (const requestedEffort of CANONICAL_EFFORT_LEVELS) {
      expect(resolveEffort(requestedEffort, CANONICAL_EFFORT_LEVELS, policy)).toEqual({
        kind: 'exact',
        policy,
        requestedEffort,
        resolvedEffort: requestedEffort,
      });
    }
  });

  it('deduplicates and canonically orders the ladder without mutating it', () => {
    const levels = Object.freeze(['high', 'low', 'high'] as const);
    const before = [...levels];

    expect(resolveEffort('medium', levels, 'up')).toEqual({
      kind: 'rounded',
      policy: 'up',
      requestedEffort: 'medium',
      resolvedEffort: 'high',
      saturated: false,
    });
    expect(levels).toEqual(before);
  });
});

describe('resolveEffort rounding', () => {
  const sparseLadder = ['low', 'high', 'max'] as const;
  const cases: Array<{
    requested: CanonicalEffortLevel;
    up: CanonicalEffortLevel;
    upSaturated: boolean;
    down: CanonicalEffortLevel;
    downSaturated: boolean;
  }> = [
    { requested: 'off', up: 'low', upSaturated: false, down: 'low', downSaturated: true },
    { requested: 'none', up: 'low', upSaturated: false, down: 'low', downSaturated: true },
    { requested: 'minimal', up: 'low', upSaturated: false, down: 'low', downSaturated: true },
    { requested: 'low', up: 'low', upSaturated: false, down: 'low', downSaturated: false },
    { requested: 'medium', up: 'high', upSaturated: false, down: 'low', downSaturated: false },
    { requested: 'high', up: 'high', upSaturated: false, down: 'high', downSaturated: false },
    { requested: 'xhigh', up: 'max', upSaturated: false, down: 'high', downSaturated: false },
    { requested: 'max', up: 'max', upSaturated: false, down: 'max', downSaturated: false },
  ];

  it.each(cases)('resolves $requested against a sparse ladder', testCase => {
    const up = resolveEffort(testCase.requested, sparseLadder, 'up');
    const down = resolveEffort(testCase.requested, sparseLadder, 'down');

    expect(up).toMatchObject({
      kind: testCase.up === testCase.requested ? 'exact' : 'rounded',
      policy: 'up',
      requestedEffort: testCase.requested,
      resolvedEffort: testCase.up,
      ...(testCase.up === testCase.requested ? {} : { saturated: testCase.upSaturated }),
    });
    expect(down).toMatchObject({
      kind: testCase.down === testCase.requested ? 'exact' : 'rounded',
      policy: 'down',
      requestedEffort: testCase.requested,
      resolvedEffort: testCase.down,
      ...(testCase.down === testCase.requested ? {} : { saturated: testCase.downSaturated }),
    });
  });

  it('saturates up to the highest level when every supported level is lower', () => {
    expect(resolveEffort('max', ['low', 'high'], 'up')).toEqual({
      kind: 'rounded',
      policy: 'up',
      requestedEffort: 'max',
      resolvedEffort: 'high',
      saturated: true,
    });
  });

  it('saturates down to the lowest level when every supported level is higher', () => {
    expect(resolveEffort('off', ['medium', 'high'], 'down')).toEqual({
      kind: 'rounded',
      policy: 'down',
      requestedEffort: 'off',
      resolvedEffort: 'medium',
      saturated: true,
    });
  });

  it('treats off and none as equal-rank spellings with a stable canonical tie-break', () => {
    expect(resolveEffort('none', ['off'], 'up')).toMatchObject({
      kind: 'rounded',
      resolvedEffort: 'off',
      saturated: false,
    });
    expect(resolveEffort('minimal', ['none', 'off'], 'down')).toMatchObject({
      kind: 'rounded',
      resolvedEffort: 'off',
      saturated: false,
    });
  });
});

describe('resolveEffort unsupported behavior', () => {
  it('omits an unsupported effort under provider-default without losing diagnostics', () => {
    expect(resolveEffort('medium', ['low', 'high'], 'provider-default')).toEqual({
      kind: 'provider-default',
      policy: 'provider-default',
      requestedEffort: 'medium',
      resolvedEffort: undefined,
    });
  });

  it('rejects an unsupported effort under exact with a safe 400 error', () => {
    const error = caughtResolutionError(() => resolveEffort('medium', ['low', 'high'], 'exact'));

    expect(error).toMatchObject({
      name: 'EffortResolutionError',
      code: 'unsupported-effort',
      statusCode: 400,
      requestedEffort: 'medium',
      policy: 'exact',
    });
    expect(error.message).toBe('Effort "medium" is unsupported. This model supports: low, high.');
  });

  it('omits on an empty ladder only under provider-default', () => {
    expect(resolveEffort('high', [], 'provider-default')).toEqual({
      kind: 'provider-default',
      policy: 'provider-default',
      requestedEffort: 'high',
      resolvedEffort: undefined,
    });

    for (const policy of ['up', 'down', 'exact'] satisfies UnsupportedEffortPolicy[]) {
      const error = caughtResolutionError(() => resolveEffort('high', [], policy));
      expect(error).toMatchObject({
        code: 'no-supported-efforts',
        statusCode: 400,
        requestedEffort: 'high',
        policy,
      });
    }
  });

  it.each(['turbo', 'MEDIUM', '', ' high '])('rejects noncanonical request %j', requestedEffort => {
    const error = caughtResolutionError(() => resolveEffort(requestedEffort, ['high'], 'up'));

    expect(error).toMatchObject({
      code: 'invalid-effort',
      statusCode: 400,
      requestedEffort,
      policy: 'up',
    });
    expect(error.message).not.toContain(requestedEffort || '<empty>');
  });

  it('rejects a noncanonical supported ladder instead of silently changing it', () => {
    const levels = Object.freeze(['low', 'turbo', 'high'] as const);
    const before = [...levels];
    const error = caughtResolutionError(() => resolveEffort('medium', levels, 'up'));

    expect(error).toMatchObject({
      code: 'invalid-supported-effort',
      statusCode: 500,
    });
    expect(error.message).toBe('Model effort capabilities contain a non-canonical level.');
    expect(levels).toEqual(before);
  });

  it('rejects an invalid runtime policy defensively', () => {
    const error = caughtResolutionError(() => resolveEffort(
      'medium',
      ['high'],
      'nearest' as UnsupportedEffortPolicy,
    ));

    expect(error).toMatchObject({
      code: 'invalid-policy',
      statusCode: 500,
      requestedEffort: 'medium',
      policy: 'nearest',
    });
    expect(error.message).toBe('Configured effort policy is invalid.');
  });
});

describe('effortResolutionDiagnostic', () => {
  it('is silent for exact matches and names every non-exact decision', () => {
    expect(effortResolutionDiagnostic(resolveEffort('high', ['high'], 'up'))).toBeUndefined();
    expect(effortResolutionDiagnostic(resolveEffort('xhigh', ['high', 'max'], 'up')))
      .toBe('requested=xhigh;resolved=max;policy=up;saturated=false');
    expect(effortResolutionDiagnostic(resolveEffort('medium', ['high'], 'provider-default')))
      .toBe('requested=medium;resolved=provider-default;policy=provider-default');
  });

  it('encodes and bounds caller-controlled diagnostic context', () => {
    const diagnostic = effortResolutionDiagnostic(
      resolveEffort('xhigh', ['high', 'max'], 'up'),
      {
        targetId: `provider:model\r\nx-injected: yes${'x'.repeat(256)}`,
        supportedLevels: ['high', 'max'],
      },
    );

    expect(diagnostic).toContain('target=provider%3Amodel%0D%0Ax-injected%3A%20yes');
    expect(diagnostic).toContain(';supported=high|max');
    expect(diagnostic).not.toContain('\r');
    expect(diagnostic).not.toContain('\n');
    expect(diagnostic!.length).toBeLessThan(512);
  });

  it('fails closed when diagnostic context contains invalid Unicode', () => {
    const diagnostic = effortResolutionDiagnostic(
      resolveEffort('medium', ['high'], 'provider-default'),
      { targetId: 'provider:\ud800' },
    );

    expect(diagnostic).toContain(';target=invalid-unicode');
  });
});
