import { describe, expect, it } from 'vitest';
import {
  CANONICAL_EFFORT_LEVELS,
  DEFAULT_UNSUPPORTED_EFFORT_POLICY,
  EffortResolutionError,
  UNSUPPORTED_EFFORT_POLICIES,
  isCanonicalEffortLevel,
  isUnsupportedEffortPolicy,
  nativeEffortLevel,
  profileLevels,
  resolveEffort,
  resolveRequestEffort,
  type CanonicalEffortLevel,
  type EffortProfile,
} from '../src/effort-policy.js';
import { openCodeGoEffortProfile } from '../src/data/opencode-go-effort-profiles.js';
import { buildOpenCodeGoModels } from '../src/data/opencode-go-models.js';
import { effortProviderOptions, getPatchReasoningCapabilities } from '../src/provider-factory.js';
import { projectNativeEffort } from '../src/patch-transforms.js';
import { transformOpenAiCompatibleRequestBody } from '../src/model-runtime-compatibility.js';

function profile(
  modelId: string,
  levels: Array<[CanonicalEffortLevel, string]>,
  defaultLevel: CanonicalEffortLevel | null = null,
): EffortProfile {
  return {
    modelId,
    transport: 'openai-completions',
    defaultLevel,
    levels: levels.map(([level, value]) => ({ level, native: { kind: 'reasoning-effort', value } })),
  };
}

/** deepseek-v4-flash's real shape: a two-rung ladder with a wide gap below it. */
const SPARSE = profile('deepseek-v4-flash', [['high', 'high'], ['max', 'max']]);
/** gpt-5.6-luna's real shape, including the off→none spelling change. */
const FULL = profile('gpt-5.6-luna', [
  ['off', 'none'], ['low', 'low'], ['medium', 'medium'],
  ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max'],
]);
/** glm-5.1's real shape: reasoning happens, but clodex can't grade it. */
const NO_CONTROL = profile('glm-5.1', []);

describe('effort policy vocabulary', () => {
  it('names the eight global levels and the four policies', () => {
    expect(CANONICAL_EFFORT_LEVELS).toEqual([
      'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
    ]);
    expect(UNSUPPORTED_EFFORT_POLICIES).toEqual(['provider-default', 'up', 'down', 'exact']);
    expect(DEFAULT_UNSUPPORTED_EFFORT_POLICY).toBe('provider-default');
    expect(isCanonicalEffortLevel('xhigh')).toBe(true);
    expect(isCanonicalEffortLevel('turbo')).toBe(false);
    expect(isUnsupportedEffortPolicy('down')).toBe(true);
    expect(isUnsupportedEffortPolicy('nearest')).toBe(false);
  });

  it('rejects a level outside the vocabulary rather than guessing', () => {
    expect(() => resolveEffort('turbo', FULL)).toThrow(EffortResolutionError);
    expect(() => resolveEffort('turbo', FULL)).toThrow(/Unknown effort level "turbo"/);
  });
});

describe('resolveEffort', () => {
  it('sends a supported level unchanged under every policy', () => {
    for (const policy of UNSUPPORTED_EFFORT_POLICIES) {
      expect(resolveEffort('high', SPARSE, policy), policy).toEqual({
        requested: 'high',
        resolved: 'high',
        outcome: 'exact',
      });
    }
  });

  it('omits the effort field for an unsupported level under provider-default', () => {
    expect(resolveEffort('low', SPARSE, 'provider-default')).toEqual({
      requested: 'low',
      outcome: 'provider-default',
    });
    expect(resolveEffort('low', SPARSE, 'provider-default').resolved).toBeUndefined();
  });

  it('rounds up to the nearest supported level', () => {
    expect(resolveEffort('low', SPARSE, 'up')).toEqual({
      requested: 'low',
      resolved: 'high',
      outcome: 'rounded-up',
      saturated: false,
    });
  });

  it('rounds down to the nearest supported level', () => {
    expect(resolveEffort('xhigh', SPARSE, 'down')).toEqual({
      requested: 'xhigh',
      resolved: 'high',
      outcome: 'rounded-down',
      saturated: false,
    });
  });

  it('saturates at the far edge when the ladder runs out in the asked-for direction', () => {
    // Nothing at or below `low`, so rounding DOWN has to use the lowest rung
    // that exists and say so.
    expect(resolveEffort('low', SPARSE, 'down')).toEqual({
      requested: 'low',
      resolved: 'high',
      outcome: 'rounded-down',
      saturated: true,
    });
    expect(resolveEffort('minimal', SPARSE, 'up')).toMatchObject({
      resolved: 'high',
      saturated: false,
    });
  });

  it('treats off and none as one level before selecting any policy', () => {
    // Luna spells "no reasoning" as `none` on the wire but exposes it as `off`.
    // Asking for either spelling is exact equivalence, never unsupported effort.
    for (const policy of UNSUPPORTED_EFFORT_POLICIES) {
      expect(resolveEffort('none', FULL, policy), policy).toEqual({
        requested: 'none',
        resolved: 'off',
        outcome: 'exact',
      });
    }

    const noneProfile = profile('none-model', [['none', 'none'], ['low', 'low']]);
    for (const policy of UNSUPPORTED_EFFORT_POLICIES) {
      expect(resolveEffort('off', noneProfile, policy), policy).toEqual({
        requested: 'off',
        resolved: 'none',
        outcome: 'exact',
      });
    }
  });

  it('refuses an unsupported level under exact instead of substituting', () => {
    expect(() => resolveEffort('low', SPARSE, 'exact')).toThrow(EffortResolutionError);
    try {
      resolveEffort('low', SPARSE, 'exact');
      expect.unreachable('exact must refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(EffortResolutionError);
      expect((err as EffortResolutionError).statusCode).toBe(400);
      expect((err as EffortResolutionError).message)
        .toBe('Effort "low" is not supported by deepseek-v4-flash. Supported levels: high, max.');
    }
  });

  it('omits rather than fails when the route has no effort control at all', () => {
    // Not an unsupported LEVEL — there is no ladder to round along and no
    // substitution for `exact` to refuse, so every policy sends nothing.
    for (const policy of UNSUPPORTED_EFFORT_POLICIES) {
      expect(resolveEffort('high', NO_CONTROL, policy), policy).toEqual({
        requested: 'high',
        outcome: 'no-effort-control',
      });
    }
  });

  it('never invents a level the profile does not carry', () => {
    for (const policy of UNSUPPORTED_EFFORT_POLICIES) {
      for (const level of CANONICAL_EFFORT_LEVELS) {
        let resolution;
        try {
          resolution = resolveEffort(level, SPARSE, policy);
        } catch (err) {
          expect(err, `${policy}/${level}`).toBeInstanceOf(EffortResolutionError);
          continue;
        }
        if (resolution.resolved === undefined) continue;
        expect(profileLevels(SPARSE), `${policy}/${level}`).toContain(resolution.resolved);
      }
    }
  });
});

describe('resolveRequestEffort', () => {
  it('sends nothing when the client omits effort and the provider declares no default', () => {
    expect(resolveRequestEffort(undefined, SPARSE)).toBeUndefined();
  });

  it('uses a declared default when the client omits effort', () => {
    const withDefault = profile('fixture', [['high', 'high'], ['max', 'max']], 'max');
    expect(resolveRequestEffort(undefined, withDefault)).toEqual({
      requested: 'max',
      resolved: 'max',
      outcome: 'exact',
    });
  });

  it('lets an explicit client effort win over a declared default', () => {
    const withDefault = profile('fixture', [['high', 'high'], ['max', 'max']], 'max');
    expect(resolveRequestEffort('high', withDefault)).toMatchObject({ resolved: 'high' });
  });
});

describe('nativeEffortLevel', () => {
  it('recognises a value already spelled the way the upstream expects', () => {
    expect(nativeEffortLevel(FULL, 'none')).toBe('off');
    expect(nativeEffortLevel(FULL, 'xhigh')).toBe('xhigh');
    expect(nativeEffortLevel(SPARSE, 'low')).toBeUndefined();
  });
});

describe('generated OpenCode Go profiles', () => {
  it('are attached by model id and absent for models nobody reviewed', () => {
    expect(openCodeGoEffortProfile('gpt-5.6-luna')).toMatchObject({
      modelId: 'gpt-5.6-luna',
      transport: 'openai-completions',
      defaultLevel: null,
    });
    expect(openCodeGoEffortProfile('grok-4.5')).toBeUndefined();
    expect(openCodeGoEffortProfile('gpt-5.6-sol')).toBeUndefined();
  });

  it('cannot be edited in place by a consumer', () => {
    const luna = openCodeGoEffortProfile('gpt-5.6-luna')!;
    expect(Object.isFrozen(luna)).toBe(true);
    expect(Object.isFrozen(luna.levels)).toBe(true);
    expect(() => {
      (luna as { defaultLevel: CanonicalEffortLevel | null }).defaultLevel = 'max';
    }).toThrow();
    expect(openCodeGoEffortProfile('gpt-5.6-luna')!.defaultLevel).toBeNull();
  });

  it('agrees with the reviewed wire map for every reviewed model', () => {
    // The profile is the policy's view and the map is the wire's view. If they
    // ever disagree, one request path would resolve a level the other cannot
    // send.
    for (const model of buildOpenCodeGoModels()) {
      const entry = openCodeGoEffortProfile(model.id);
      expect(entry, model.id).toBeDefined();
      const map = model.compatibility?.reasoningEffortMap;
      const suppressed = model.compatibility?.supportsReasoningEffort === false;
      const executable = suppressed || !map
        ? []
        : Object.entries(map).filter(([, value]) => value !== null).map(([level]) => level);
      expect(profileLevels(entry!).slice().sort(), model.id).toEqual(executable.slice().sort());
      for (const level of entry!.levels) {
        expect(level.native, `${model.id}.${level.level}`)
          .toEqual({ kind: 'reasoning-effort', value: map![level.level] });
      }
    }
  });
});

/**
 * Both request paths translate effort, and they must agree byte for byte.
 *
 * The SDK path maps the resolved level through `effortProviderOptions` before
 * the AI SDK serializes, then `transformOpenAiCompatibleRequestBody` runs over
 * that serialized body. The direct forward hands the resolved level straight to
 * the same transform. Anything that made those two disagree would send a
 * different request depending on which endpoint the client happened to use.
 */
describe('SDK and direct paths agree on the wire', () => {
  const models = buildOpenCodeGoModels().filter(model => model.modelFormat === 'openai');

  function sdkBody(model: (typeof models)[number], level: string): Record<string, unknown> {
    const options = effortProviderOptions(model.npm!, level, model.id, {
      reasoning: model.reasoning,
      compatibility: model.compatibility,
      providerId: 'opencode-go',
    } as never) as Record<string, Record<string, unknown>> | undefined;
    const serialized: Record<string, unknown> = { model: model.id };
    const effort = options?.opencodeGo?.reasoningEffort;
    if (typeof effort === 'string') serialized.reasoning_effort = effort;
    return transformOpenAiCompatibleRequestBody(serialized, model.compatibility ?? {});
  }

  function directBody(model: (typeof models)[number], level: string): Record<string, unknown> {
    return transformOpenAiCompatibleRequestBody(
      { model: model.id, reasoning_effort: level },
      model.compatibility ?? {},
    );
  }

  it('produces identical bodies for every executable level of every model', () => {
    let compared = 0;
    for (const model of models) {
      for (const level of profileLevels(openCodeGoEffortProfile(model.id)!)) {
        expect(JSON.stringify(sdkBody(model, level)), `${model.id}/${level}`)
          .toBe(JSON.stringify(directBody(model, level)));
        compared += 1;
      }
    }
    // Guards the loop itself: a profile lookup that silently returned empty
    // ladders would make every assertion above vacuous.
    // 2+2+2+6+3+1+5 across the seven Chat Completions models that grade effort.
    expect(compared).toBe(21);
  });

  it('never translates an already-native value twice', () => {
    for (const model of models) {
      const entry = openCodeGoEffortProfile(model.id)!;
      for (const level of entry.levels) {
        const native = (level.native as { value: string }).value;
        // Whatever the map sends must survive a second pass unchanged — that is
        // what lets the direct path forward a native value untouched.
        const once = directBody(model, level.level);
        const twice = transformOpenAiCompatibleRequestBody(once, model.compatibility ?? {});
        expect(twice.reasoning_effort, `${model.id}/${level.level}`).toBe(native);
        expect(JSON.stringify(twice), `${model.id}/${level.level}`).toBe(JSON.stringify(once));
      }
    }
  });
});

/**
 * What the patched client can be told, versus what the policy can resolve.
 *
 * The patch transforms are at version 6, whose native effort representation is
 * a dense low/medium/high(/xhigh/max) picker: `projectNativeEffort` discards any
 * capability missing one of the base three. Most reviewed ladders are sparse, so
 * they reach the patched client with no native effort control — accurately, and
 * that is the deferral, not a defect. Representing a sparse ladder needs a new
 * transform version, which this slice deliberately does not ship.
 *
 * This pins both halves so neither can drift silently: the exposure stays within
 * the validated-map levels wherever version 6 can express them, and the models it
 * cannot express are named.
 */
describe('patched-client exposure stays within transform version 6', () => {
  const models = buildOpenCodeGoModels().filter(model => model.modelFormat === 'openai');

  function patchCapabilities(model: (typeof models)[number]) {
    return getPatchReasoningCapabilities(model.npm!, model.id, {
      providerId: 'opencode-go',
      reasoning: model.reasoning,
      compatibility: model.compatibility,
      upstreamModelId: model.id,
    } as never);
  }

  it('advertises only validated-map levels, never more', () => {
    for (const model of models) {
      const executable = new Set(profileLevels(openCodeGoEffortProfile(model.id)!));
      for (const level of patchCapabilities(model).levels) {
        expect(executable.has(level as CanonicalEffortLevel), `${model.id}/${level}`).toBe(true);
      }
    }
  });

  it('reaches the native picker only for the two dense ladders', () => {
    const native = models
      .filter(model => {
        const caps = patchCapabilities(model);
        return caps.defaultLevel !== undefined
          && projectNativeEffort({ levels: caps.levels, defaultLevel: caps.defaultLevel }) !== undefined;
      })
      .map(model => model.id);

    // Every other reviewed ladder is sparse. Exposing one would need the sparse
    // picker representation, which is a separate transform-version change.
    expect(native).toEqual(['gpt-5.6-luna', 'qwen3.6-plus']);
  });
});
