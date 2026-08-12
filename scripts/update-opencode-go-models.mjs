#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// OpenCode's own catalog service (the opencode CLI consumes the same feed).
// Supplies per-model metadata: name, context window, cost, modalities.
//
// WHAT THE FEED CAN AND CANNOT CONTROL — the property that keeps this script's
// supply-chain surface narrow, and which is not obvious from reading it:
//
//   Feed-controlled: name, contextWindow, cost, modalities, reasoning.
//   Local-only:      apiUrl, npm, modelFormat, the whole compatibility block,
//                    and which ids exist at all (TRANSPORTS below).
//
// `toClodexModel` hardcodes every routing constant locally and filters ids
// against TRANSPORTS, so a hostile or simply wrong feed cannot produce a bad
// base URL, a bad SDK package, or any code-execution path — the worst it can
// do is a wrong display name, price, or context window, and the ingest
// validation in main() catches the last of those. Keep it that way: never move
// a routing or compatibility field into the feed-derived half.
const MODELS_DEV_URL = 'https://models.dev/api.json';
const PROVIDER_ID = 'opencode-go';
const MODELS_PATH = resolve('src/data/opencode-go-models.json');
const CONSTANTS_PATH = resolve('src/data/opencode-go-models.ts');

const COMPLETIONS_BASE_URL = 'https://opencode.ai/zen/go/v1';
const ANTHROPIC_BASE_URL = 'https://opencode.ai/zen/go';

// models.dev does not publish per-model wire transport, and the family-level
// summary in the Zen docs is not reliable per model (minimax-m3 is
// Anthropic-format while minimax-m2.x are Chat Completions; gpt-5.6-luna rides
// Chat Completions, not Responses). This map is clodex's live-validated
// routing knowledge: catalog entries only exist for ids mapped here. A new
// model on models.dev surfaces in the updater's "unmapped" report and is added
// once its transport is verified against the live endpoint. Responses-only
// models (grok, mainline gpt) are deliberately absent.
const TRANSPORTS = Object.assign(Object.create(null), {
  'deepseek-v4-flash': 'openai-completions',
  'deepseek-v4-pro': 'openai-completions',
  'glm-5.1': 'openai-completions',
  'glm-5.2': 'openai-completions',
  'gpt-5.6-luna': 'openai-completions',
  'hy3': 'openai-completions',
  'kimi-k2.6': 'openai-completions',
  'kimi-k2.7-code': 'openai-completions',
  'kimi-k3': 'openai-completions',
  'mimo-v2.5': 'openai-completions',
  'mimo-v2.5-pro': 'openai-completions',
  'minimax-m2.7': 'openai-completions',
  'minimax-m3': 'anthropic-messages',
  'qwen3.6-plus': 'openai-completions',
  'qwen3.7-max': 'anthropic-messages',
  'qwen3.7-plus': 'anthropic-messages',
  'qwen3.8-max': 'anthropic-messages',
});

// Clodex-side compatibility behavior per model, validated against the live
// endpoint. It travels with the transport map rather than being read from the
// feed, so a hostile or wrong feed cannot change what clodex puts on the wire.
//
// models.dev DOES publish a per-model `reasoning_options` (an effort ladder, a
// bare toggle, or nothing), and it is the closest thing to an authority on
// what OpenCode's GATEWAY accepts — which is not the same set the upstream
// vendor documents for its own endpoint. Treat it as the cross-check these
// entries are validated against, never as their source: `assertEffortLadders`
// below fails this updater if a map would send an effort value the feed does
// not publish, and reports the safe direction rather than failing on it.
const PATCHES = Object.assign(Object.create(null), {
  'deepseek-v4-flash': {
    reasoningEffortMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: 'deepseek',
  },
  'deepseek-v4-pro': {
    reasoningEffortMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: 'deepseek',
  },
  'glm-5.1': {
    // Z.ai: reasoning_effort is "Only supported by GLM-5.2". 5.1 thinks by
    // default and is controlled by the binary `thinking` field, so it reasons
    // but has no effort control to advertise.
    supportsReasoningEffort: false,
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'glm-5.2': {
    // Z.ai's own API documents the full ladder ("max, xhigh, high, medium,
    // low, minimal, none"), but that describes Z.ai's endpoint, not OpenCode's
    // gateway in front of it: models.dev — the feed OpenCode itself routes
    // from — publishes effort=high/max for this model. The gateway is what we
    // actually talk to, so its narrower set wins until the wider one is
    // validated live.
    reasoningEffortMap: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: 'max' },
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'gpt-5.6-luna': {
    // models.dev publishes effort=none/low/medium/high/xhigh/max for OpenCode's
    // Luna — note: no `minimal`. Distinct from the ChatGPT-OAuth Luna, which is
    // a different deployment on the Responses transport and says nothing about
    // what this gateway accepts.
    reasoningEffortMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'hy3': {
    reasoningEffortMap: { off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null },
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'kimi-k2.6': {
    reasoningEffortMap: { minimal: null, low: null, medium: null },
    supportsStore: false,
    supportsDeveloperRole: false,
    thinkingFormat: 'deepseek',
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    supportsLongCacheRetention: false,
  },
  'kimi-k2.7-code': {
    // Moonshot: "thinking is always on and cannot be disabled", driven by the
    // `thinking` field and NOT `reasoning_effort`, which this model does not
    // accept. Stated explicitly so the model-name Kimi rule cannot claim it:
    // reasoning genuinely happens, it just isn't effort-controllable, which is
    // exactly what `supportsReasoningEffort: false` reports (internal-only).
    supportsReasoningEffort: false,
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'kimi-k3': {
    // Moonshot's own API documents low/high/max (default max), but models.dev
    // publishes effort=max for OpenCode's deployment. Same reasoning as
    // glm-5.2: the gateway's set is the one that reaches the wire.
    reasoningEffortMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: 'max' },
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'mimo-v2.5': {
    // Xiaomi's OpenAI-compatible reference documents no reasoning_effort; the
    // request shape carries a `thinking` object ("type": "disabled") like the
    // GLM and Kimi families. Reasoning happens, it is not graded.
    supportsReasoningEffort: false,
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'mimo-v2.5-pro': {
    // Same reference, same `thinking` object, no reasoning_effort.
    supportsReasoningEffort: false,
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'minimax-m2.7': {
    // MiniMax's Chat Completions reference accepts no reasoning_effort at all;
    // reasoning is the `thinking` object, and "for M2.x models, thinking
    // cannot be disabled". Always-on and not effort-controllable.
    supportsReasoningEffort: false,
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  },
  'minimax-m3': {
    // Same reference as M2.7: no reasoning_effort. M3's thinking is
    // "adaptive" by default and can be disabled, but never graded, so there is
    // no effort ladder to advertise. (Anthropic-format, so the generator also
    // stamps supportsCountTokens: false below.)
    supportsReasoningEffort: false,
  },
  'qwen3.6-plus': {
    // Qwen has no reasoning_effort: models.dev publishes a toggle plus a token
    // budget, and DashScope's control is the boolean `enable_thinking`. But
    // `thinkingFormat: 'qwen'` only injects that boolean when a
    // reasoning_effort is PRESENT, so the effort value is load-bearing as an
    // internal signal even though the upstream ignores its value.
    //
    // Without a map, mapCodexEffortToOpenAI dropped `off`, `minimal` and also
    // `max` — so choosing MAX silently disabled thinking while `low` enabled
    // it. Every level except `off` now maps to something, which is what fixes
    // that: any level thinks, `off` does not.
    //
    // DISTINCT values, not one repeated. Collapsing them to a single value is
    // tempting — the grades are cosmetic while the upstream control is a
    // boolean — but getPatchReasoningCapabilities dedups identical provider
    // options, and `projectNativeEffort` in patch-transforms.ts discards any
    // capability missing low/medium/high. A one-level capability therefore
    // leaves a patched client with NO effort control at all, which is worse
    // than cosmetic grades. The upstream ignores the string either way.
    //
    // Grading this for real means sending enable_thinking + thinking_budget
    // and dropping reasoning_effort. That changes the wire and needs a live
    // key to validate, so it is tracked separately rather than guessed here.
    reasoningEffortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', minimal: null, off: null },
    supportsStore: false,
    supportsDeveloperRole: false,
    thinkingFormat: 'qwen',
    maxTokensField: 'max_tokens',
  },
});

/**
 * Cross-check every local effort map against what the feed publishes.
 *
 * The invariant is a SUBSET, not equality, and the asymmetry is the point.
 * Sending a value the gateway does not publish risks a rejected request, so it
 * fails the update. Sending fewer than it publishes is merely conservative —
 * `deepseek-v4-flash` omits a `low` the feed lists — so that is reported and
 * left to a human, because widening a ladder is exactly the change that wants
 * live validation rather than a script's confidence.
 *
 * This exists because the vendor's own API and OpenCode's gateway disagree:
 * Z.ai documents seven effort levels for GLM-5.2 and Moonshot documents three
 * for K3, while the feed publishes `high/max` and `max`. Two entries were
 * briefly widened to the vendor ladders before that was understood.
 */
function assertEffortLadders(supported, devModels) {
  const errors = [];
  const notes = [];
  for (const model of supported) {
    const options = devModels[model.id]?.reasoning_options;
    const published = new Set(
      (Array.isArray(options) ? options : [])
        .filter(option => option?.type === 'effort')
        .flatMap(option => option.values ?? []),
    );
    const compatibility = model.compatibility ?? {};
    if (compatibility.supportsReasoningEffort === false) {
      if (published.size > 0) {
        notes.push(`${model.id}: suppressed locally, feed publishes ${[...published].sort().join('/')}`);
      }
      continue;
    }
    const map = compatibility.reasoningEffortMap;
    if (!map) {
      notes.push(`${model.id}: no local map — falls back to generic rules, cannot be cross-checked`);
      continue;
    }
    const sent = new Set(Object.values(map).filter(value => value !== null));
    // A model the feed describes as a bare TOGGLE, mapped locally with a
    // thinkingFormat, is the one legitimate way to send an effort the feed does
    // not publish: the value is an internal signal that makes the transform
    // inject the upstream's real control (`enable_thinking`), and the upstream
    // ignores the effort string itself. Recognised by shape rather than by id,
    // so any future toggle-only model gets the same treatment — and still
    // reported, because the honest fix is to send the vendor's own field.
    const togglesOnly = published.size === 0
      && (Array.isArray(options) ? options : []).some(option => option?.type === 'toggle')
      && compatibility.thinkingFormat !== undefined;
    if (togglesOnly) {
      notes.push(
        `${model.id}: effort is a toggle proxy (feed publishes a toggle, not a ladder) — `
        + 'the value is an internal signal for the thinkingFormat transform',
      );
      continue;
    }
    const unpublished = [...sent].filter(value => !published.has(value)).sort();
    if (unpublished.length > 0) {
      errors.push(
        `${model.id}: maps to ${unpublished.join('/')}, which models.dev does not publish `
        + `(feed: ${[...published].sort().join('/') || 'no effort ladder'})`,
      );
      continue;
    }
    const unused = [...published].filter(value => !sent.has(value)).sort();
    if (unused.length > 0) {
      notes.push(`${model.id}: feed also publishes ${unused.join('/')}, not sent locally`);
    }
  }
  return { errors, notes };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'clodex-opencode-go-catalog-updater' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  return response.json();
}

function toClodexModel(id, devModel) {
  const transport = TRANSPORTS[id];
  const anthropic = transport === 'anthropic-messages';
  const devCost = devModel.cost ?? {};
  const cost = {
    input: devCost.input ?? 0,
    output: devCost.output ?? 0,
    ...(devCost.cache_read ? { cache_read: devCost.cache_read } : {}),
    ...(devCost.cache_write ? { cache_write: devCost.cache_write } : {}),
  };
  // OpenCode Zen documents /v1/responses, /v1/chat/completions and
  // /v1/messages, and no token-counting endpoint. Marked on the anthropic-
  // format entries so the proxy answers count_tokens from its local estimate
  // instead of forwarding to a path that 404s into the client's token
  // accounting. Hardcoded here, like every other routing constant, so the
  // upstream feed cannot influence it.
  // Defaults every anthropic-format entry carries, overridable per model.
  //
  // supportsCountTokens: OpenCode Zen documents /v1/responses,
  // /v1/chat/completions and /v1/messages, and no token-counting endpoint, so
  // the proxy answers count_tokens from its local estimate instead of
  // forwarding to a path that 404s into the client's token accounting.
  //
  // supportsReasoningEffort: structural, not a vendor claim. Effort reaches an
  // upstream through `effortProviderOptions` and the `thinkingFormat`
  // transform, both of which act on an OpenAiCompatibleRequestBody. A
  // passthrough Messages body is forwarded untouched, so there is no way to
  // send a graded effort on this route however the vendor spells it — these
  // models still reason, via whatever `thinking` the client itself sends.
  // Advertising a control clodex cannot operate is what this prevents.
  const compatibility = anthropic
    ? { supportsCountTokens: false, supportsReasoningEffort: false, ...(PATCHES[id] ?? {}) }
    : PATCHES[id];
  const modalities = (devModel.modalities?.input ?? ['text'])
    .filter(value => value === 'text' || value === 'image');

  return {
    id,
    name: devModel.name ?? id,
    contextWindow: devModel.limit?.context,
    cost,
    modelFormat: anthropic ? 'anthropic' : 'openai',
    npm: anthropic ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
    apiUrl: anthropic ? ANTHROPIC_BASE_URL : COMPLETIONS_BASE_URL,
    reasoning: devModel.reasoning === true,
    modalities,
    ...(compatibility ? { compatibility } : {}),
    upstreamModelId: id,
    family: id.split('-')[0] ?? id,
  };
}

/**
 * Resolve the new constants file content WITHOUT writing it.
 *
 * Ordering alone cannot make two file writes atomic — whichever goes first, an
 * interruption leaves the other stale. What it can do is move the one failure
 * that is actually likely, the regex ceasing to match after an unrelated edit
 * to the constants file, ahead of every write. Both writes then fail only on
 * real I/O trouble, and the catalog goes first so the timestamp is a commit
 * marker for a catalog already on disk rather than a promise about one.
 */
async function prepareSourceConstant(fetchedAt) {
  const source = await readFile(CONSTANTS_PATH, 'utf8');
  const pattern = /export const OPENCODE_GO_SOURCE_FETCHED_AT = '[^']*';/;
  if (!pattern.test(source)) {
    throw new Error('Could not find OPENCODE_GO_SOURCE_FETCHED_AT in opencode-go-models.ts');
  }
  return source.replace(pattern, `export const OPENCODE_GO_SOURCE_FETCHED_AT = '${fetchedAt}';`);
}

async function main() {
  const catalog = await fetchJson(MODELS_DEV_URL);
  const provider = catalog?.[PROVIDER_ID];
  const devModels = provider?.models;
  if (!devModels || typeof devModels !== 'object') {
    throw new Error(`models.dev catalog has no "${PROVIDER_ID}" provider models`);
  }

  const supported = [];
  const unmapped = [];
  for (const [id, devModel] of Object.entries(devModels).sort(([a], [b]) => a.localeCompare(b))) {
    if (!TRANSPORTS[id]) {
      unmapped.push(id);
      continue;
    }
    supported.push(toClodexModel(id, devModel));
  }

  const missing = Object.keys(TRANSPORTS).filter(id => !Object.hasOwn(devModels, id));
  if (missing.length > 0) {
    throw new Error(`Transport-mapped models missing from models.dev: ${missing.join(', ')}`);
  }
  if (supported.length === 0) {
    throw new Error('models.dev catalog produced no supported models');
  }

  // Validate at ingest, before anything is written. contextWindow flows into
  // the patched client's context map, where a bad value breaks auto-compaction
  // silently rather than failing here; a name with control characters or
  // newlines corrupts every list that renders it.
  const invalid = [];
  for (const model of supported) {
    if (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0 || model.contextWindow > 10_000_000) {
      invalid.push(`${model.id}: contextWindow=${JSON.stringify(model.contextWindow)}`);
    }
    // eslint-disable-next-line no-control-regex
    if (typeof model.name !== 'string' || model.name.trim() === '' || /[\x00-\x1f\x7f]/.test(model.name)) {
      invalid.push(`${model.id}: name=${JSON.stringify(model.name)}`);
    }
  }
  if (invalid.length > 0) {
    throw new Error(`models.dev returned unusable metadata:\n  ${invalid.join('\n  ')}`);
  }

  const ladders = assertEffortLadders(supported, devModels);
  if (ladders.errors.length > 0) {
    throw new Error(
      'Local effort maps send values models.dev does not publish for the OpenCode gateway:\n  '
      + ladders.errors.join('\n  '),
    );
  }

  // Resolve the constants content before either write, so the likely failure —
  // the regex no longer matching — aborts with both files untouched rather
  // than stranding one of them. Catalog first, timestamp second: the timestamp
  // then marks a catalog that is already on disk.
  const constantsContent = await prepareSourceConstant(new Date().toISOString());
  await writeFile(MODELS_PATH, `${JSON.stringify(supported, null, 2)}\n`);
  await writeFile(CONSTANTS_PATH, constantsContent);

  console.log(`Updated ${supported.length} OpenCode Go models from ${MODELS_DEV_URL} (${PROVIDER_ID}).`);
  for (const note of ladders.notes) {
    console.log(`Effort ladder note — ${note}`);
  }
  if (unmapped.length > 0) {
    console.log(
      'Present on models.dev but not transport-mapped (verify wire protocol '
      + `against the live endpoint, then add to TRANSPORTS): ${unmapped.join(', ')}`,
    );
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
