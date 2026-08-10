#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const SNAPSHOT_PATH = resolve(REPO_ROOT, 'src/data/opencode-go-cli-snapshot.json');
const MODELS_PATH = resolve(REPO_ROOT, 'src/data/opencode-go-models.json');

const PROVIDER_ID = 'opencode-go';
const RELEASE_REPOSITORY = 'https://github.com/anomalyco/opencode';
const SOURCE_COMMAND = 'opencode --pure models opencode-go --verbose';
const REFRESH_COMMAND = 'opencode --pure models opencode-go --refresh';
const COMPLETIONS_NPM = '@ai-sdk/openai-compatible';
const MESSAGES_NPM = '@ai-sdk/anthropic';
const RESPONSES_NPM = '@ai-sdk/openai';
const KNOWN_NPMS = new Set([COMPLETIONS_NPM, MESSAGES_NPM, RESPONSES_NPM]);
const CANONICAL_EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const REVIEWED_ANTHROPIC_THINKING_BUDGETS = new Map([
  ['qwen3.6-plus', { high: 16_000, max: 31_999 }],
  ['qwen3.7-max', { high: 16_000, max: 31_999 }],
  ['qwen3.7-plus', { high: 16_000, max: 31_999 }],
  ['qwen3.8-max', { high: 16_000, max: 31_999 }],
]);
const OFFICIAL_API_URL = 'https://opencode.ai/zen/go/v1';
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SAFE_VARIANT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SENSITIVE_KEY = /(?:^|[_-])(authorization|auth|api[_-]?key|cookie|credential|password|secret|token)(?:$|[_-])/i;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function assertSafeString(value, field) {
  const string = assertString(value, field);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(string) || /[\p{Cc}\p{Cf}]/u.test(string)) {
    throw new Error(`${field} contains a control character`);
  }
  return string;
}

function assertExactKeys(value, field, allowed, required = allowed) {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${field} contains unsupported key ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${field} is missing required key ${key}`);
    }
  }
}

function assertSafeTree(value, field) {
  if (typeof value === 'string') {
    assertSafeString(value, field);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeTree(entry, `${field}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key) || SENSITIVE_KEY.test(key)) {
      throw new Error(`${field} contains forbidden key ${key}`);
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(key)) throw new Error(`${field} contains a control-character key`);
    assertSafeTree(entry, `${field}.${key}`);
  }
}

function assertBoolean(value, field) {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function assertFiniteNonNegative(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  return value;
}

function assertPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0 || value > 10_000_000) {
    throw new Error(`${field} must be a positive integer no greater than 10000000`);
  }
  return value;
}

function validateCacheCost(value, field) {
  assertExactKeys(value, field, ['read', 'write']);
  assertFiniteNonNegative(value.read, `${field}.read`);
  assertFiniteNonNegative(value.write, `${field}.write`);
}

function validateCost(value, field) {
  assertExactKeys(
    value,
    field,
    ['input', 'output', 'cache', 'experimentalOver200K', 'tiers'],
    ['input', 'output', 'cache'],
  );
  assertFiniteNonNegative(value.input, `${field}.input`);
  assertFiniteNonNegative(value.output, `${field}.output`);
  validateCacheCost(value.cache, `${field}.cache`);
  if (value.experimentalOver200K !== undefined) {
    assertExactKeys(value.experimentalOver200K, `${field}.experimentalOver200K`, ['input', 'output', 'cache']);
    assertFiniteNonNegative(value.experimentalOver200K.input, `${field}.experimentalOver200K.input`);
    assertFiniteNonNegative(value.experimentalOver200K.output, `${field}.experimentalOver200K.output`);
    validateCacheCost(value.experimentalOver200K.cache, `${field}.experimentalOver200K.cache`);
  }
  if (value.tiers !== undefined) {
    if (!Array.isArray(value.tiers)) throw new Error(`${field}.tiers must be an array`);
    value.tiers.forEach((tier, index) => {
      const tierField = `${field}.tiers[${index}]`;
      assertExactKeys(tier, tierField, ['input', 'output', 'cache', 'tier']);
      assertFiniteNonNegative(tier.input, `${tierField}.input`);
      assertFiniteNonNegative(tier.output, `${tierField}.output`);
      validateCacheCost(tier.cache, `${tierField}.cache`);
      assertExactKeys(tier.tier, `${tierField}.tier`, ['size', 'type']);
      assertPositiveInteger(tier.tier.size, `${tierField}.tier.size`);
      if (tier.tier.type !== 'context') throw new Error(`${tierField}.tier.type must be context`);
    });
  }
}

function validateModalities(value, field) {
  const keys = ['audio', 'image', 'pdf', 'text', 'video'];
  assertExactKeys(value, field, keys);
  for (const key of keys) assertBoolean(value[key], `${field}.${key}`);
}

function validateCapabilities(value, field) {
  assertExactKeys(value, field, [
    'attachment',
    'input',
    'interleaved',
    'output',
    'reasoning',
    'temperature',
    'toolcall',
  ]);
  assertBoolean(value.attachment, `${field}.attachment`);
  assertBoolean(value.reasoning, `${field}.reasoning`);
  assertBoolean(value.temperature, `${field}.temperature`);
  assertBoolean(value.toolcall, `${field}.toolcall`);
  validateModalities(value.input, `${field}.input`);
  validateModalities(value.output, `${field}.output`);
  if (value.interleaved !== false) {
    assertExactKeys(value.interleaved, `${field}.interleaved`, ['field']);
    if (assertSafeString(value.interleaved.field, `${field}.interleaved.field`) !== 'reasoning_content') {
      throw new Error(`${field}.interleaved.field is unsupported`);
    }
  }
}

function validateVariant(variant, field, npm) {
  if (npm === COMPLETIONS_NPM) {
    assertExactKeys(variant, field, ['reasoningEffort']);
    const effort = assertSafeString(variant.reasoningEffort, `${field}.reasoningEffort`);
    if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
      throw new Error(`${field}.reasoningEffort is unsupported`);
    }
    return;
  }
  if (npm === MESSAGES_NPM) {
    assertExactKeys(variant, field, ['thinking']);
    assertExactKeys(variant.thinking, `${field}.thinking`, ['type', 'budgetTokens'], ['type']);
    if (!['adaptive', 'disabled', 'enabled'].includes(variant.thinking.type)) {
      throw new Error(`${field}.thinking.type is unsupported`);
    }
    if (variant.thinking.type === 'enabled') {
      assertPositiveInteger(variant.thinking.budgetTokens, `${field}.thinking.budgetTokens`);
    } else if (variant.thinking.budgetTokens !== undefined) {
      throw new Error(`${field}.thinking.budgetTokens is only valid for enabled thinking`);
    }
    return;
  }
  assertExactKeys(variant, field, ['include', 'reasoningEffort', 'reasoningSummary']);
  if (!Array.isArray(variant.include) || variant.include.length === 0) {
    throw new Error(`${field}.include must be a non-empty string array`);
  }
  variant.include.forEach((entry, index) => assertSafeString(entry, `${field}.include[${index}]`));
  const effort = assertSafeString(variant.reasoningEffort, `${field}.reasoningEffort`);
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new Error(`${field}.reasoningEffort is unsupported`);
  }
  if (assertSafeString(variant.reasoningSummary, `${field}.reasoningSummary`) !== 'auto') {
    throw new Error(`${field}.reasoningSummary is unsupported`);
  }
}

function validateResolvedModel(model) {
  assertSafeTree(model, 'model');
  assertExactKeys(model, 'model', [
    'api',
    'capabilities',
    'cost',
    'family',
    'headers',
    'id',
    'limit',
    'name',
    'options',
    'providerID',
    'release_date',
    'status',
    'variants',
  ]);
  const id = assertSafeString(model.id, 'model.id');
  if (!SAFE_ID.test(id)) throw new Error(`${id}: id contains unsafe characters`);
  if (model.providerID !== PROVIDER_ID) throw new Error(`${id}: providerID must be ${PROVIDER_ID}`);
  assertSafeString(model.name, `${id}.name`);
  assertSafeString(model.family, `${id}.family`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(assertSafeString(model.release_date, `${id}.release_date`))) {
    throw new Error(`${id}.release_date must be YYYY-MM-DD`);
  }
  if (model.status !== 'active') throw new Error(`${id}: status must be active`);
  assertExactKeys(model.headers, `${id}.headers`, [], []);
  assertExactKeys(model.options, `${id}.options`, [], []);

  assertExactKeys(model.api, `${id}.api`, ['id', 'npm', 'url']);
  if (model.api.id !== id) throw new Error(`${id}: api.id must match id`);
  const npm = assertSafeString(model.api.npm, `${id}.api.npm`);
  if (!KNOWN_NPMS.has(npm)) throw new Error(`${id}: unsupported SDK transport ${npm}`);
  const rawApiUrl = assertSafeString(model.api.url, `${id}.api.url`);
  const apiUrl = new URL(rawApiUrl);
  if (
    rawApiUrl !== OFFICIAL_API_URL
    || apiUrl.protocol !== 'https:'
    || apiUrl.hostname !== 'opencode.ai'
    || apiUrl.pathname !== '/zen/go/v1'
    || apiUrl.port
    || apiUrl.username
    || apiUrl.password
    || apiUrl.search
    || apiUrl.hash
  ) {
    throw new Error(`${id}: api.url must be exactly ${OFFICIAL_API_URL} without credentials, query, or fragment`);
  }

  assertExactKeys(model.limit, `${id}.limit`, ['context', 'input', 'output'], ['context', 'output']);
  assertPositiveInteger(model.limit.context, `${id}.limit.context`);
  assertPositiveInteger(model.limit.output, `${id}.limit.output`);
  if (model.limit.input !== undefined) assertPositiveInteger(model.limit.input, `${id}.limit.input`);
  validateCost(model.cost, `${id}.cost`);
  validateCapabilities(model.capabilities, `${id}.capabilities`);

  assertExactKeys(model.variants, `${id}.variants`, Object.keys(model.variants), []);
  for (const [variantName, variant] of Object.entries(model.variants)) {
    if (!SAFE_VARIANT_NAME.test(variantName)) throw new Error(`${id}: unsafe variant name ${variantName}`);
    validateVariant(variant, `${id}.variants.${variantName}`, npm);
  }
  return structuredClone(model);
}

function recursivelySortKeys(value) {
  if (Array.isArray(value)) return value.map(recursivelySortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, recursivelySortKeys(value[key])]),
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Canonical resolved-model representation used for provenance hashing.
 *
 * This is byte-for-byte equivalent to:
 *   jq -s -cS . objects.jsonstream
 * for the CLI object stream: model order is normalized by id, every object key
 * is sorted recursively, JSON is compact, and one trailing LF is included.
 */
export function canonicalizeResolvedModels(models) {
  const ordered = [...models].sort((a, b) => compareAscii(String(a?.id), String(b?.id)));
  return `${JSON.stringify(recursivelySortKeys(ordered))}\n`;
}

/** Parse either the verbose CLI output, its JSON-object stream, or a JSON array. */
export function parseOpenCodeVerboseOutput(input) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('OpenCode CLI output is empty');

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('OpenCode CLI snapshot must be an array');
    return parsed;
  }

  const labels = [...input.matchAll(/^([a-z0-9-]+)\/([^\r\n]+)\r?$/gm)]
    .map(match => ({ provider: match[1], id: match[2] }));
  const withoutLabels = input.replace(/^opencode-go\/[^\r\n]+\r?\n/gm, '');
  const models = [];
  let offset = 0;

  while (offset < withoutLabels.length) {
    while (/\s/.test(withoutLabels[offset] ?? '')) offset += 1;
    if (offset >= withoutLabels.length) break;
    if (withoutLabels[offset] !== '{') {
      throw new Error(`Unexpected content at byte ${offset}; expected a JSON model object`);
    }

    const start = offset;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; offset < withoutLabels.length; offset += 1) {
      const char = withoutLabels[offset];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          offset += 1;
          models.push(JSON.parse(withoutLabels.slice(start, offset)));
          break;
        }
      }
    }
    if (depth !== 0 || inString) throw new Error('OpenCode CLI output ended inside a JSON object');
  }

  if (labels.length > 0) {
    if (labels.length !== models.length) {
      throw new Error(`OpenCode CLI emitted ${labels.length} labels but ${models.length} model objects`);
    }
    labels.forEach((label, index) => {
      if (label.provider !== PROVIDER_ID) {
        throw new Error(`Unexpected CLI provider label ${label.provider}/${label.id}`);
      }
      if (models[index]?.id !== label.id) {
        throw new Error(`CLI label ${label.id} does not match object ${String(models[index]?.id)}`);
      }
    });
  }

  return models;
}

function validateResolvedModels(models) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('OpenCode CLI resolved no models');
  }

  const ids = new Set();
  return models.map(model => {
    if (!isRecord(model)) throw new Error('Every resolved model must be an object');
    const validated = validateResolvedModel(model);
    const id = validated.id;
    if (ids.has(id)) throw new Error(`OpenCode CLI returned duplicate model ${id}`);
    ids.add(id);
    return validated;
  });
}

function normalizeCost(model) {
  const input = model.cost.input;
  const output = model.cost.output;
  const cost = { input, output };
  const cacheRead = model.cost?.cache?.read;
  const cacheWrite = model.cost?.cache?.write;
  if (cacheRead !== undefined) {
    if (!Number.isFinite(cacheRead) || cacheRead < 0) throw new Error(`${model.id}: invalid cache read cost`);
    cost.cache_read = cacheRead;
  }
  if (cacheWrite !== undefined) {
    if (!Number.isFinite(cacheWrite) || cacheWrite < 0) throw new Error(`${model.id}: invalid cache write cost`);
    cost.cache_write = cacheWrite;
  }
  return cost;
}

function reasoningEffortMap(model) {
  const mapped = new Map();
  for (const [variantName, variant] of Object.entries(model.variants)) {
    if (!isRecord(variant) || variant.reasoningEffort === undefined) continue;
    const wireValue = assertString(
      variant.reasoningEffort,
      `${model.id}.variants.${variantName}.reasoningEffort`,
    );
    const clodexLevel = variantName === 'none' ? 'off' : variantName;
    if (!CANONICAL_EFFORT_LEVELS.includes(clodexLevel)) {
      throw new Error(`${model.id}: cannot map OpenCode reasoning variant ${variantName}`);
    }
    if (mapped.has(clodexLevel)) throw new Error(`${model.id}: duplicate reasoning level ${clodexLevel}`);
    mapped.set(clodexLevel, wireValue);
  }

  if (mapped.size === 0) return null;
  return Object.fromEntries(
    CANONICAL_EFFORT_LEVELS
      .filter(level => mapped.has(level))
      .map(level => [level, mapped.get(level)]),
  );
}

function anthropicThinkingBudgetMap(model) {
  const mapped = new Map();
  let sawNonBudgetVariant = false;
  for (const [variantName, variant] of Object.entries(model.variants)) {
    if (!isRecord(variant?.thinking)) continue;
    if (variant.thinking.type !== 'enabled') {
      sawNonBudgetVariant = true;
      continue;
    }
    if (!CANONICAL_EFFORT_LEVELS.includes(variantName)) {
      throw new Error(`${model.id}: cannot map OpenCode thinking variant ${variantName}`);
    }
    mapped.set(variantName, variant.thinking.budgetTokens);
  }

  const reviewed = REVIEWED_ANTHROPIC_THINKING_BUDGETS.get(model.id);
  if (mapped.size === 0) {
    if (reviewed) throw new Error(`${model.id}: reviewed Anthropic thinking budgets are missing`);
    return null;
  }
  if (sawNonBudgetVariant) {
    throw new Error(`${model.id}: cannot partially map mixed Anthropic thinking variants`);
  }
  if (!reviewed) {
    throw new Error(`${model.id}: enabled Anthropic thinking budgets require an explicit reviewed mapping`);
  }
  const result = Object.fromEntries(
    CANONICAL_EFFORT_LEVELS
      .filter(level => mapped.has(level))
      .map(level => [level, mapped.get(level)]),
  );
  if (JSON.stringify(result) !== JSON.stringify(reviewed)) {
    throw new Error(`${model.id}: Anthropic thinking budgets changed from the reviewed mapping`);
  }
  return result;
}

function messagesBaseUrl(url) {
  return url.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

/** Convert the committed CLI resolver output into clodex's runtime catalog. */
export function convertResolvedModels(models) {
  const validatedModels = validateResolvedModels(models);
  const supported = [];
  const omittedResponses = [];
  const seenReviewedAnthropicBudgets = new Set();

  for (const model of [...validatedModels].sort((a, b) => compareAscii(a.id, b.id))) {
    const npm = model.api.npm;
    if (npm === RESPONSES_NPM) {
      omittedResponses.push(model.id);
      continue;
    }

    if (
      model.capabilities.input.text !== true
      || model.capabilities.output.text !== true
      || model.capabilities.toolcall !== true
    ) {
      throw new Error(`${model.id}: supported runtime models must support text input, text output, and tool calls`);
    }

    const anthropic = npm === MESSAGES_NPM;
    const efforts = anthropic ? null : reasoningEffortMap(model);
    const thinkingBudgets = anthropic ? anthropicThinkingBudgetMap(model) : null;
    if (anthropic && REVIEWED_ANTHROPIC_THINKING_BUDGETS.has(model.id)) {
      seenReviewedAnthropicBudgets.add(model.id);
    }
    const compatibility = anthropic
      ? {
          ...(thinkingBudgets
            ? {
                anthropicThinkingBudgetMap: thinkingBudgets,
                reasoningEffortDefault: null,
              }
            : { supportsReasoningEffort: false }),
          supportsCountTokens: false,
        }
      : {
          ...(efforts
            ? { reasoningEffortMap: efforts, reasoningEffortDefault: null }
            : { supportsReasoningEffort: false }),
          supportsStore: false,
          supportsDeveloperRole: false,
          ...(model.capabilities.temperature ? {} : { supportsTemperature: false }),
          maxTokensField: 'max_tokens',
        };
    const modalities = ['text', 'image']
      .filter(modality => model.capabilities?.input?.[modality] === true);

    supported.push({
      id: model.id,
      name: model.name,
      contextWindow: model.limit.context,
      cost: normalizeCost(model),
      modelFormat: anthropic ? 'anthropic' : 'openai',
      npm,
      apiUrl: anthropic ? messagesBaseUrl(model.api.url) : model.api.url.replace(/\/$/, ''),
      reasoning: model.capabilities?.reasoning === true,
      ...(isRecord(model.capabilities.interleaved)
        ? { interleavedReasoningField: model.capabilities.interleaved.field }
        : {}),
      codingCapabilitiesAuthoritative: true,
      modalities,
      compatibility,
      upstreamModelId: model.api.id,
      family: model.family ?? (model.id.split('-')[0] || model.id),
    });
  }

  const missingReviewedBudgets = [...REVIEWED_ANTHROPIC_THINKING_BUDGETS.keys()]
    .filter(id => !seenReviewedAnthropicBudgets.has(id));
  if (missingReviewedBudgets.length > 0) {
    throw new Error(
      `Reviewed Anthropic thinking-budget models are missing or changed transport: ${missingReviewedBudgets.join(', ')}`,
    );
  }

  if (supported.length === 0) throw new Error('OpenCode CLI produced no supported Messages/Chat models');
  return { supported, omittedResponses };
}

function parseArgs(argv) {
  const options = { check: false, input: undefined, provenance: {} };
  const valueFlags = new Map([
    ['--input', 'input'],
    ['--opencode-version', 'openCodeVersion'],
    ['--release-tag', 'releaseTag'],
    ['--release-commit', 'releaseCommit'],
    ['--release-asset-file', 'releaseAssetFile'],
    ['--raw-catalog-file', 'rawCatalogFile'],
    ['--captured-at', 'capturedAt'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      options.check = true;
      continue;
    }
    const key = valueFlags.get(arg);
    if (!key) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    index += 1;
    if (key === 'input' || key.endsWith('File')) options[key] = resolve(value);
    else options.provenance[key] = value;
  }
  if (options.check && options.input) throw new Error('--check cannot be combined with --input');
  if (!options.input && (
    options.releaseAssetFile
    || options.rawCatalogFile
    || Object.keys(options.provenance).length > 0
  )) {
    throw new Error('capture provenance flags require --input');
  }
  return options;
}

export function snapshotFrom(models, provenance) {
  const required = [
    'openCodeVersion',
    'releaseTag',
    'releaseCommit',
    'releaseAsset',
    'releaseAssetSha256',
    'rawCatalogSha256',
    'capturedAt',
  ];
  assertExactKeys(provenance, 'capture provenance', required);
  assertSafeTree(provenance, 'capture provenance');
  for (const key of required) assertSafeString(provenance[key], `--${key}`);
  if (provenance.releaseTag !== `v${provenance.openCodeVersion}`) {
    throw new Error('--release-tag must equal v followed by --opencode-version');
  }
  const validatedModels = validateResolvedModels(models);
  const canonical = canonicalizeResolvedModels(validatedModels);
  const orderedModels = JSON.parse(canonical);
  const snapshot = {
    _meta: {
      schemaVersion: 1,
      provider: PROVIDER_ID,
      releaseRepository: RELEASE_REPOSITORY,
      sourceCommand: SOURCE_COMMAND,
      refreshCommand: REFRESH_COMMAND,
      normalization: 'models sorted by id; object keys recursively sorted; compact JSON array plus LF',
      openCodeVersion: provenance.openCodeVersion,
      releaseTag: provenance.releaseTag,
      releaseCommit: provenance.releaseCommit,
      releaseAsset: provenance.releaseAsset,
      releaseAssetSha256: provenance.releaseAssetSha256,
      rawCatalogSha256: provenance.rawCatalogSha256,
      capturedAt: provenance.capturedAt,
      normalizedModelsSha256: sha256(canonical),
    },
    models: orderedModels,
  };
  validateSnapshot(snapshot);
  return snapshot;
}

function validateSnapshot(snapshot) {
  if (!isRecord(snapshot) || !isRecord(snapshot._meta) || !Array.isArray(snapshot.models)) {
    throw new Error('Committed OpenCode CLI snapshot has an invalid shape');
  }
  assertSafeTree(snapshot, 'snapshot');
  assertExactKeys(snapshot, 'snapshot', ['_meta', 'models']);
  assertExactKeys(snapshot._meta, 'snapshot._meta', [
    'capturedAt',
    'normalization',
    'normalizedModelsSha256',
    'openCodeVersion',
    'provider',
    'rawCatalogSha256',
    'refreshCommand',
    'releaseAsset',
    'releaseAssetSha256',
    'releaseCommit',
    'releaseRepository',
    'releaseTag',
    'schemaVersion',
    'sourceCommand',
  ]);
  if (snapshot._meta.schemaVersion !== 1 || snapshot._meta.provider !== PROVIDER_ID) {
    throw new Error('Committed OpenCode CLI snapshot has unsupported provenance');
  }
  if (
    snapshot._meta.releaseRepository !== RELEASE_REPOSITORY
    || snapshot._meta.sourceCommand !== SOURCE_COMMAND
    || snapshot._meta.refreshCommand !== REFRESH_COMMAND
  ) {
    throw new Error('Committed OpenCode CLI snapshot does not identify the official resolver commands');
  }
  for (const field of ['openCodeVersion', 'releaseTag', 'releaseAsset']) {
    assertString(snapshot._meta[field], `snapshot._meta.${field}`);
  }
  if (snapshot._meta.releaseTag !== `v${snapshot._meta.openCodeVersion}`) {
    throw new Error('Committed OpenCode CLI snapshot release tag/version mismatch');
  }
  if (!/^\d+\.\d+\.\d+$/.test(snapshot._meta.openCodeVersion)) {
    throw new Error('Committed OpenCode CLI snapshot openCodeVersion must be a semantic version');
  }
  if (!/^opencode-[a-z0-9-]+\.zip$/.test(snapshot._meta.releaseAsset)) {
    throw new Error('Committed OpenCode CLI snapshot releaseAsset must be an official zip asset name');
  }
  if (basename(snapshot._meta.releaseAsset) !== snapshot._meta.releaseAsset) {
    throw new Error('Committed OpenCode CLI snapshot releaseAsset must be a file name');
  }
  if (
    snapshot._meta.normalization
    !== 'models sorted by id; object keys recursively sorted; compact JSON array plus LF'
  ) {
    throw new Error('Committed OpenCode CLI snapshot has unsupported normalization');
  }
  for (const [field, length] of [
    ['releaseCommit', 40],
    ['releaseAssetSha256', 64],
    ['rawCatalogSha256', 64],
    ['normalizedModelsSha256', 64],
  ]) {
    const value = snapshot._meta[field];
    if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
      throw new Error(`Committed OpenCode CLI snapshot has an invalid ${field}`);
    }
  }
  if (Number.isNaN(Date.parse(snapshot._meta.capturedAt))) {
    throw new Error('Committed OpenCode CLI snapshot has an invalid capturedAt');
  }
  validateResolvedModels(snapshot.models);
  const actualHash = sha256(canonicalizeResolvedModels(snapshot.models));
  if (actualHash !== snapshot._meta.normalizedModelsSha256) {
    throw new Error(
      `Committed OpenCode CLI snapshot hash mismatch: expected ${snapshot._meta.normalizedModelsSha256}, got ${actualHash}`,
    );
  }
}

async function readSnapshot() {
  const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  validateSnapshot(snapshot);
  return snapshot;
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizedSnapshotContent(snapshot) {
  const normalized = {
    _meta: recursivelySortKeys(snapshot._meta),
    models: JSON.parse(canonicalizeResolvedModels(snapshot.models)),
  };
  return prettyJson(normalized);
}

async function assertCurrent(path, expected, label) {
  const actual = await readFile(path, 'utf8').catch(() => '');
  if (actual !== expected) {
    throw new Error(`${label} is stale; run pnpm update:opencode-go`);
  }
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  let snapshot;
  if (options.input) {
    const models = parseOpenCodeVerboseOutput(await readFile(options.input, 'utf8'));
    if (!options.releaseAssetFile) throw new Error('--release-asset-file is required with --input');
    if (!options.rawCatalogFile) throw new Error('--raw-catalog-file is required with --input');
    snapshot = snapshotFrom(models, {
      ...options.provenance,
      releaseAsset: basename(options.releaseAssetFile),
      releaseAssetSha256: await sha256File(options.releaseAssetFile),
      rawCatalogSha256: await sha256File(options.rawCatalogFile),
    });
  } else {
    snapshot = await readSnapshot();
  }

  validateSnapshot(snapshot);
  const { supported, omittedResponses } = convertResolvedModels(snapshot.models);
  const snapshotContent = normalizedSnapshotContent(snapshot);
  const modelsContent = prettyJson(supported);

  if (options.check) {
    await assertCurrent(SNAPSHOT_PATH, snapshotContent, 'OpenCode CLI source snapshot');
    await assertCurrent(MODELS_PATH, modelsContent, 'OpenCode Go runtime catalog');
    console.log(
      `OpenCode Go catalog is current: ${supported.length} supported, `
      + `${omittedResponses.length} Responses-only omitted.`,
    );
    return;
  }

  await writeFile(SNAPSHOT_PATH, snapshotContent);
  await writeFile(MODELS_PATH, modelsContent);
  console.log(
    `Updated ${supported.length} OpenCode Go models from committed OpenCode CLI metadata; `
    + `omitted Responses-only: ${omittedResponses.join(', ') || 'none'}.`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  run().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
