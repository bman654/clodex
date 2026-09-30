// src/registry/openai-oauth-catalog.ts — ChatGPT/Codex-plan OAuth model catalog discovery

import { readCodexClientVersion } from '../codex-client-version.js';
import { CODEX_RESPONSES_LITE_VERSION } from '../constants.js';
import type { CachedModel } from './types.js';
import {
  buildOpenAiOAuthModels,
  CHATGPT_CODEX_UNSUPPORTED_MODELS,
  openAiPricingMetadata,
} from '../data/openai-oauth-models.js';
import { deriveBrand } from '../models.js';
import { lookupKnownContextWindow } from '../context-window.js';
import { getInstalledClaudeVersion } from '../launch.js';
import { modelPrefersResponsesApi } from '../provider-factory.js';

/** A parsed model entry, including backend-reported transport capability flags. */
interface OpenAiModelEntry {
  id: string;
  name: string;
  context_window?: number;
  /** Ceiling the client may raise `context_window` to; account-dependent. */
  max_context_window?: number;
  /** Share of the raw window the client should fill. */
  effective_context_window_percent?: number;
  max_output_tokens?: number;
  /** Backend flags: model needs the Responses-Lite shape / WebSocket transport. */
  useResponsesLite?: boolean;
  preferWebSockets?: boolean;
  minimalClientVersion?: string;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Read the context-budget fields the Codex catalog carries alongside the window. */
function readContextFields(
  m: Record<string, unknown>,
): Pick<OpenAiModelEntry, 'context_window' | 'max_context_window' | 'effective_context_window_percent' | 'max_output_tokens'> {
  return {
    context_window: positiveInteger(m['context_window']),
    max_context_window: positiveInteger(m['max_context_window']),
    effective_context_window_percent: positiveInteger(m['effective_context_window_percent']),
    max_output_tokens: positiveInteger(m['max_output_tokens']),
  };
}

/** Read the Responses-Lite / WebSocket capability flags off a raw model entry. */
function readCapabilityFlags(m: Record<string, unknown>): Pick<OpenAiModelEntry, 'useResponsesLite' | 'preferWebSockets' | 'minimalClientVersion'> {
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
  return {
    useResponsesLite: bool(m['use_responses_lite']),
    preferWebSockets: bool(m['prefer_websockets']),
    minimalClientVersion: readCodexClientVersion(m['minimal_client_version']),
  };
}

/** Parse model entries from OpenAI-standard or ChatGPT-internal response shapes. */
function parseOpenAiModelEntries(body: unknown): OpenAiModelEntry[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;

  // ChatGPT backend format: { models: [{ slug, title }] }
  if (Array.isArray(b.models)) {
    return (b.models as Array<Record<string, unknown>>)
      .map(m => ({
        id: (m.slug as string) ?? '',
        name: (m.title as string) ?? (m.name as string) ?? (m.slug as string) ?? '',
        ...readContextFields(m),
        ...readCapabilityFlags(m),
      }))
      .filter(m => m.id.length > 0);
  }
  // Standard OpenAI format: { data: [{ id, name }] }
  if (Array.isArray(b.data)) {
    return (b.data as Array<Record<string, unknown>>)
      .map(m => ({
        id: (m.id as string) ?? '',
        name: (m.name as string) ?? (m.id as string) ?? '',
        ...readContextFields(m),
        ...readCapabilityFlags(m),
      }))
      .filter(m => m.id.length > 0);
  }
  return [];
}

/**
 * Build a CachedModel for a discovered OpenAI OAuth model. The live backend is
 * authoritative for context and capability flags: when the model is also seeded,
 * live values are merged over the seed (the seed is only a fallback).
 */
function buildDynamicOAuthModel(
  entry: OpenAiModelEntry,
  seedById: Map<string, CachedModel>,
  /**
   * True only for the Codex-specific listing. That endpoint returns just the
   * agentic models Codex supports, which is what makes the reasoning default
   * below safe; the general ChatGPT catalog is the web model picker and includes
   * plainly non-reasoning models.
   */
  codexCatalog: boolean,
): CachedModel {
  const seed = seedById.get(entry.id);
  if (seed) {
    return {
      ...seed,
      contextWindow: entry.context_window ?? seed.contextWindow,
      // A catalog that omits the ceiling is not a catalog that reports there is
      // none, so the seed's ceiling survives rather than collapsing the `max`
      // stop down onto the standard one.
      maxContextWindow: entry.max_context_window ?? seed.maxContextWindow,
      effectiveContextPercent: entry.effective_context_window_percent
        ?? seed.effectiveContextPercent,
      maxOutputTokens: entry.max_output_tokens ?? seed.maxOutputTokens,
      useResponsesLite: entry.useResponsesLite ?? seed.useResponsesLite,
      preferWebSockets: entry.preferWebSockets ?? seed.preferWebSockets,
      minimalClientVersion: entry.minimalClientVersion ?? seed.minimalClientVersion,
    };
  }
  const { id } = entry;
  const prefix = id.split('-')[0] ?? id;
  return {
    id,
    name: entry.name,
    upstreamModelId: id,
    family: prefix,
    brand: deriveBrand(prefix),
    contextWindow: entry.context_window ?? lookupKnownContextWindow(id),
    maxContextWindow: entry.max_context_window,
    // Absent means no reduction. clodex reports the window the provider actually
    // gives; deciding how much of it to leave free is the client's job, and Claude
    // Code already reserves a flat 33,000 tokens below whatever it is told.
    effectiveContextPercent: entry.effective_context_window_percent,
    maxOutputTokens: entry.max_output_tokens,
    ...openAiPricingMetadata(id),
    modelFormat: 'openai' as const,
    npm: '@ai-sdk/openai',
    // Assume a model from the Codex listing reasons. That endpoint reports no
    // reasoning field of its own, so the old `modelPrefersResponsesApi(id)` was an
    // id-pattern GUESS that silently said "no" to every family it had not been
    // taught yet — gpt-6-astra and gpt-daybreak-blue-latest both landed as
    // non-reasoning that way, which dropped the user's chosen effort and removed
    // the effort selector from the patched binary (getPatchReasoningCapabilities
    // early-returns on a `false`). Verified against all 11 models in the live
    // catalog on 2026-09-04.
    //
    // This only decides what the effort UI offers. It is NOT on its own enough to
    // put reasoning.effort on the wire — effortProviderOptions admits by family —
    // so a wrong `true` here costs an unusable menu entry, not a 400.
    reasoning: codexCatalog ? true : modelPrefersResponsesApi(id),
    useResponsesLite: entry.useResponsesLite,
    preferWebSockets: entry.preferWebSockets,
    minimalClientVersion: entry.minimalClientVersion,
  };
}

/** Fetch and parse JSON from a URL with auth and timeout, returning null on any failure. */
async function fetchJsonWithAuth(
  url: string,
  accessToken: string,
  timeoutMs: number,
): Promise<{ body: unknown | null; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().then(t => t.slice(0, 200)).catch(() => '');
      return { body: null, error: `HTTP ${response.status}${detail ? `: ${detail}` : ''}` };
    }
    return { body: await response.json() };
  } catch (err) {
    return { body: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) {
      controller.abort(new Error('OpenAI catalog request completed'));
    }
  }
}

/**
 * The Codex catalog filters on `client_version`, and its published
 * `minimal_client_version` can understate that filter: gpt-6.1-sol reported 0.153.0
 * but was omitted at 0.156.0 and 0.158.0, where its requests were also refused, and
 * listed and accepted at 0.159.0 (#298). Ask again at the version clodex sends and
 * mark each row that answer omits with that version.
 * Projection hides a marked row only when it uses Responses-Lite (other requests omit
 * the version) and only while the bundled version is at or below the mark.
 *
 * An unusable answer (see `readOfferedIds`) is no new evidence, so it keeps this
 * account's previous markers on the rows still discovered rather than re-offering a
 * model last seen withheld; it never fails the refresh. A usable answer replaces every
 * marker.
 */
async function markModelsWithheldAtRequestVersion(
  models: CachedModel[],
  accessToken: string,
  timeoutMs: number,
  previous: readonly CachedModel[],
): Promise<CachedModel[]> {
  const pinned = await fetchJsonWithAuth(
    `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_RESPONSES_LITE_VERSION}`,
    accessToken,
    timeoutMs,
  );
  const offered = readOfferedIds(pinned.body);
  if (!offered) return carryWithheldMarkers(models, previous);
  return models.map(model => (offered.has(model.id)
    ? model
    : { ...model, withheldAtClientVersion: CODEX_RESPONSES_LITE_VERSION }));
}

/**
 * The ids in the answer at the version clodex sends, or undefined when it proves nothing.
 * Strict on purpose: a model is hidden for being ABSENT from this list, so an empty
 * answer, or one with any row lacking a non-blank string id free of surrounding
 * whitespace, cannot show that the rows it fails to name are withheld. Reads the same
 * two shapes as `parseOpenAiModelEntries`.
 */
function readOfferedIds(body: unknown): Set<string> | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  const shape = Array.isArray(record.models) ? { rows: record.models as unknown[], key: 'slug' }
    : Array.isArray(record.data) ? { rows: record.data as unknown[], key: 'id' }
      : undefined;
  if (!shape || shape.rows.length === 0) return undefined;
  const ids = new Set<string>();
  for (const row of shape.rows) {
    const id = row !== null && typeof row === 'object'
      ? (row as Record<string, unknown>)[shape.key]
      : undefined;
    if (typeof id !== 'string' || id === '' || id !== id.trim()) return undefined;
    ids.add(id);
  }
  return ids;
}

/**
 * Re-apply the last pinned answer's markers when this refresh could not get a new one.
 * Verbatim: a marker at or below a newer pin already hides nothing, and only the same
 * account's cache is passed in.
 */
function carryWithheldMarkers(models: CachedModel[], previous: readonly CachedModel[]): CachedModel[] {
  const withheld = new Map(previous.flatMap(model => {
    const version = readCodexClientVersion(model.withheldAtClientVersion);
    return version ? [[model.id, version] as const] : [];
  }));
  if (withheld.size === 0) return models;
  return models.map(model => {
    const version = withheld.get(model.id);
    return version ? { ...model, withheldAtClientVersion: version } : model;
  });
}

/**
 * Fetch OpenAI OAuth (ChatGPT) models using a 3-tier strategy:
 *
 * 1. chatgpt.com/backend-api/codex/models — Codex-specific endpoint.
 *    If it exists, it returns ONLY models the Codex API actually supports,
 *    including their minimum client versions. It is fetched with Claude Code's
 *    version number, far above any Codex client version, so the answer is
 *    effectively unfiltered; a second fetch at the version clodex sends marks
 *    the models withheld from it (or, when unusable, keeps the previous marks).
 *    Projection hides incompatible models.
 *
 * 2. chatgpt.com/backend-api/models — all ChatGPT models, filtered by the
 *    confirmed-bad set. Used when the Codex endpoint doesn't exist or returns nothing.
 *
 * 3. Static seed — emergency fallback with no network dependency.
 */
export async function refreshOpenAiOAuthModels(
  accessToken: string,
  /** This account's cached rows; supplies markers when the pinned fetch is unusable. */
  previous: readonly CachedModel[] = [],
): Promise<{
  models: CachedModel[];
  source: 'live' | 'seed';
  failureReason?: string;
  credentialRejected?: boolean;
}> {
  const TIMEOUT_MS = 10_000;
  const seedById = new Map(buildOpenAiOAuthModels().map(m => [m.id, m]));
  const toModels = (entries: OpenAiModelEntry[], codexCatalog: boolean) =>
    entries.map(entry => buildDynamicOAuthModel(entry, seedById, codexCatalog));

  const claudeVersion = getInstalledClaudeVersion();

  // Tier 1: Codex-specific model listing — source of truth for Codex availability.
  const codexResult = await fetchJsonWithAuth(
    `https://chatgpt.com/backend-api/codex/models?client_version=${claudeVersion}`,
    accessToken,
    TIMEOUT_MS,
  );
  const codexEntries = parseOpenAiModelEntries(codexResult.body);
  if (codexEntries.length > 0) {
    const models = toModels(codexEntries, true);
    return {
      models: await markModelsWithheldAtRequestVersion(models, accessToken, TIMEOUT_MS, previous),
      source: 'live',
    };
  }

  // Tier 2: General ChatGPT model list, filtered by known Codex restrictions.
  const chatGptResult = await fetchJsonWithAuth(
    'https://chatgpt.com/backend-api/models',
    accessToken,
    TIMEOUT_MS,
  );
  const chatGptEntries = parseOpenAiModelEntries(chatGptResult.body)
    .filter(({ id }) => !CHATGPT_CODEX_UNSUPPORTED_MODELS.has(id));
  if (chatGptEntries.length > 0) {
    // This list says nothing about Codex version gating; keep the last pinned answer's markers.
    return {
      models: carryWithheldMarkers(toModels(chatGptEntries, false), previous),
      source: 'live',
    };
  }

  // Tier 3: Static seed — reuse already-built map instead of calling the builder again.
  const failures = [codexResult.error, chatGptResult.error]
    .filter((error): error is string => error !== undefined);
  const credentialFailure = failures.find(error => /(?:\brejected\b|\b401\b|\b403\b)/i.test(error));
  return {
    models: [...seedById.values()],
    source: 'seed',
    failureReason: credentialFailure ?? chatGptResult.error ?? codexResult.error,
    credentialRejected: credentialFailure !== undefined,
  };
}
