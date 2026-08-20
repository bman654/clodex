// src/data/openai-oauth-models.ts
//
// Static seed list of GPT models accessible via ChatGPT Plus / Pro OAuth.
//
// WHY STATIC: OAuth access tokens from auth.openai.com are NOT developer API keys
// (sk-...) and are rejected by api.openai.com/v1/models. The Codex backend exposes
// its own account-scoped catalog, which discovery reads when reachable; these seeds
// are the fallback and stay authoritative whenever that probe fails or returns
// nothing. Availability still varies by tier, so the full set is listed and the user
// discovers what their plan unlocks at inference time.

import { DEFAULT_EFFECTIVE_CONTEXT_PERCENT } from '../context-modes.js';
import { resolveContextWindow } from '../context-window.js';
import { deriveBrand } from '../models.js';
import type { CachedModel } from '../registry/types.js';

interface OAuthModelSeed {
  id: string;
  name: string;
  /** ChatGPT Codex client input window, which may differ from the public API model. */
  contextWindow?: number;
  /** Highest input window the Codex catalog allows, reachable via the `max` stop. */
  maxContextWindow?: number;
  /** Share of the raw window a client fills; mirrors the Codex catalog field. */
  effectiveContextPercent?: number;
  /** Input size above which the provider bills the whole request at a higher rate. */
  pricingBoundary?: number;
  pricingBoundaryNote?: string;
  /** Largest output the model accepts, independent of the input window. */
  maxOutputTokens?: number;
  reasoning?: boolean;
  /** Backend capability seed — mirrors the live use_responses_lite/prefer_websockets flags. */
  useResponsesLite?: boolean;
  preferWebSockets?: boolean;
}

/**
 * GPT-5.6 prices prompts above this input size at 2x input and 1.5x output for the
 * full request, not just the overage. That is why the Codex-reported window sits
 * here rather than at the model ceiling.
 */
const GPT_5_6_PRICING_BOUNDARY = 272_000;
const GPT_5_6_PRICING_NOTE =
  'Above it, OpenAI prices the full request at 2x input and 1.5x output.';

// Models that the ChatGPT Codex backend (chatgpt.com/backend-api/codex) explicitly rejects
// for OAuth-authenticated ChatGPT accounts. The API returns HTTP 400 with:
//   "The '<model>' model is not supported when using Codex with a ChatGPT account."
// These models may be valid via OpenAI developer API keys (api.openai.com) — they are
// only excluded from the OAuth path. Update this set when OpenAI changes availability.
export const CHATGPT_CODEX_UNSUPPORTED_MODELS = new Set<string>([
  'gpt-5.5-fast',   // confirmed: rejected by chatgpt.com/backend-api/codex
]);

// Models available via ChatGPT Plus/Pro OAuth (chatgpt.com/backend-api/codex).
// Ordered from newest to oldest within each tier.
// Ceilings are what the Codex catalog reports, which is lower than the published
// model spec and varies by plan, so discovery overrides these whenever it answers.
// A model with no ceiling here has none above its default window.
const OPENAI_OAUTH_MODEL_SEEDS: OAuthModelSeed[] = [
  // GPT-5.6 family (Sol / Terra / Luna)
  { id: 'gpt-5.6-sol',          name: 'GPT-5.6 Sol',       contextWindow: 272_000, maxContextWindow: 872_000, maxOutputTokens: 128_000, reasoning: true },
  { id: 'gpt-5.6-terra',        name: 'GPT-5.6 Terra',     contextWindow: 272_000, maxContextWindow: 872_000, maxOutputTokens: 128_000, reasoning: true },
  { id: 'gpt-5.6-luna',         name: 'GPT-5.6 Luna',      contextWindow: 272_000, maxContextWindow: 872_000, maxOutputTokens: 128_000, reasoning: true, useResponsesLite: true, preferWebSockets: true },
  // GPT-5.5 family (Pro)
  { id: 'gpt-5.5',              name: 'GPT-5.5',           contextWindow: 272_000, maxOutputTokens: 128_000, reasoning: true },
  // GPT-5.4 family
  { id: 'gpt-5.4',              name: 'GPT-5.4',           contextWindow: 272_000, maxContextWindow: 1_000_000 },
  { id: 'gpt-5.4-mini',         name: 'GPT-5.4 Mini',      contextWindow: 272_000 },
  // GPT-5 base (Pro / Plus)
  { id: 'gpt-5',                name: 'GPT-5',             contextWindow: 272_000, reasoning: true },
  // o-series reasoning (Plus+)
  { id: 'o4-mini',              name: 'o4 Mini',           reasoning: true },
  { id: 'o3',                   name: 'o3',                reasoning: true },
  { id: 'o3-mini',              name: 'o3 Mini',           reasoning: true },
  { id: 'o1',                   name: 'o1',                reasoning: true },
  { id: 'o1-mini',              name: 'o1 Mini',           reasoning: true },
];

/** Models priced with a higher-rate band above a documented input size. */
const PRICING_BOUNDARY_FAMILIES = /^gpt-5\.[56]/;

/**
 * Pricing-band metadata for a Codex model id, applied to discovered models too so a
 * model that is not in the seed still reports its boundary.
 */
export function openAiPricingMetadata(
  id: string,
): { pricingBoundary?: number; pricingBoundaryNote?: string } {
  if (!PRICING_BOUNDARY_FAMILIES.test(id)) return {};
  return {
    pricingBoundary: GPT_5_6_PRICING_BOUNDARY,
    pricingBoundaryNote: GPT_5_6_PRICING_NOTE,
  };
}

/**
 * Fill context metadata that a catalog cached before these fields existed is missing.
 * Only absent fields are filled, so live discovery always wins; without this a stale
 * cache reports a raw window with no headroom and no reachable ceiling.
 */
export function applyOAuthSeedContextMetadata(models: CachedModel[]): CachedModel[] {
  const seedById = new Map(buildOpenAiOAuthModels().map(model => [model.id, model]));
  return models.map(model => {
    const seed = seedById.get(model.id);
    const pricing = openAiPricingMetadata(model.id);
    return {
      ...model,
      maxContextWindow: model.maxContextWindow ?? seed?.maxContextWindow,
      effectiveContextPercent: model.effectiveContextPercent
        ?? seed?.effectiveContextPercent
        ?? DEFAULT_EFFECTIVE_CONTEXT_PERCENT,
      pricingBoundary: model.pricingBoundary ?? seed?.pricingBoundary ?? pricing.pricingBoundary,
      pricingBoundaryNote: model.pricingBoundaryNote
        ?? seed?.pricingBoundaryNote
        ?? pricing.pricingBoundaryNote,
      maxOutputTokens: model.maxOutputTokens ?? seed?.maxOutputTokens,
    };
  });
}

export function buildOpenAiOAuthModels(): CachedModel[] {
  return OPENAI_OAUTH_MODEL_SEEDS.map(seed => {
    const prefix = seed.id.split('-')[0] ?? seed.id;
    const pricing = openAiPricingMetadata(seed.id);
    return {
      id: seed.id,
      name: seed.name,
      upstreamModelId: seed.id,
      family: prefix,
      brand: deriveBrand(prefix),
      contextWindow: resolveContextWindow(seed.id, seed.contextWindow),
      maxContextWindow: seed.maxContextWindow,
      effectiveContextPercent: seed.effectiveContextPercent ?? DEFAULT_EFFECTIVE_CONTEXT_PERCENT,
      pricingBoundary: seed.pricingBoundary ?? pricing.pricingBoundary,
      pricingBoundaryNote: seed.pricingBoundaryNote ?? pricing.pricingBoundaryNote,
      maxOutputTokens: seed.maxOutputTokens,
      modelFormat: 'openai' as const,
      npm: '@ai-sdk/openai',
      reasoning: seed.reasoning,
      useResponsesLite: seed.useResponsesLite,
      preferWebSockets: seed.preferWebSockets,
    };
  });
}
