// Context-window stops for models whose provider prices large prompts differently.
// GPT-5.6 bills prompts above 272,000 input tokens at a higher rate for the whole
// request, so the default stop sits under that line and the larger one is opt-in.
// The field shape mirrors the Codex model catalog.

export type ContextStopName = 'standard' | 'max';
export type ContextStop = ContextStopName | number;

export interface ContextLimits {
  /** Default raw window; the `standard` stop. */
  contextWindow: number;
  /** Highest raw window the model accepts. Absent means the default is the ceiling. */
  maxContextWindow?: number;
  /** Share of the raw window to fill, when a provider declares one. Absent means all of it. */
  effectiveContextPercent?: number;
  /** Raw input size above which the provider bills at a higher rate. */
  pricingBoundary?: number;
  /** How the provider prices above the boundary, for the user-facing warning. */
  pricingBoundaryNote?: string;
}

export interface ResolvedContextStop {
  stop: ContextStop;
  /** Raw window after clamping to the ceiling. */
  raw: number;
  /** Window reported to clients: floor(raw * percent / 100). */
  effective: number;
  /** Set when the requested raw window was above the ceiling. */
  clampedFrom?: number;
  /** True when this window lets a session reach the provider's higher-rate band. */
  crossesPricingBoundary: boolean;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** An undeclared or out-of-range percent means no reduction, never a silent 95%. */
function normalizedPercent(value: unknown): number {
  const percent = positiveInteger(value);
  if (percent === undefined || percent > 100) return 100;
  return percent;
}

/** Window a client should actually fill for a given raw window. */
export function effectiveContextWindow(raw: number, percent?: number): number {
  const usable = positiveInteger(raw);
  if (usable === undefined) return 0;
  return Math.floor((usable * normalizedPercent(percent)) / 100);
}

/**
 * Parse a `--context name=<stop>` right-hand side.
 *
 * Returns `null` for the reset spellings, which clear a saved stop rather than
 * selecting one. A malformed value returns an error instead of quietly defaulting,
 * so a typo cannot silently leave a model on the wrong side of a pricing boundary.
 */
export function parseContextStop(value: string): ContextStop | null | { error: string } {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return { error: 'Context stop must be standard, max, default, or a token count.' };
  if (normalized === 'default' || normalized === 'reset' || normalized === 'unset') return null;
  if (normalized === 'standard' || normalized === 'max') return normalized;

  const shorthand = /^(\d+)k$/.exec(normalized);
  const raw = shorthand ? Number(shorthand[1]) * 1_000 : Number(normalized);
  const parsed = positiveInteger(raw);
  if (parsed === undefined) {
    return { error: `Could not read ${JSON.stringify(value)}. Expected standard, max, default, or a token count such as 500k.` };
  }
  return parsed;
}

/** Resolve a stop into the numbers every downstream consumer needs. */
export function resolveContextStop(
  limits: ContextLimits,
  stop: ContextStop = 'standard',
): ResolvedContextStop {
  const standardRaw = positiveInteger(limits.contextWindow) ?? 0;
  const ceiling = positiveInteger(limits.maxContextWindow) ?? standardRaw;
  const requested = stop === 'standard'
    ? standardRaw
    : stop === 'max'
      ? ceiling
      : positiveInteger(stop) ?? standardRaw;

  const raw = Math.min(requested, ceiling);
  const effective = effectiveContextWindow(raw, limits.effectiveContextPercent);
  const boundary = positiveInteger(limits.pricingBoundary);

  return {
    stop,
    raw,
    effective,
    ...(requested > ceiling ? { clampedFrom: requested } : {}),
    crossesPricingBoundary: boundary !== undefined && effective > boundary,
  };
}

function withThousands(value: number): string {
  return value.toLocaleString('en-US');
}

/** Message for a stop that reaches the provider's higher-rate band, else null. */
export function pricingBoundaryWarning(
  modelLabel: string,
  limits: ContextLimits,
  resolved: ResolvedContextStop,
): string | null {
  const boundary = positiveInteger(limits.pricingBoundary);
  if (boundary === undefined || !resolved.crossesPricingBoundary) return null;
  const note = limits.pricingBoundaryNote?.trim();
  return `${modelLabel}: a ${withThousands(resolved.effective)}-token window can grow past the `
    + `${withThousands(boundary)}-token pricing boundary.`
    + (note ? ` ${note}` : '')
    + ' Use the standard stop to stay under it.';
}

/** Message for a requested window that exceeded the model ceiling, else null. */
export function contextClampNotice(
  modelLabel: string,
  resolved: ResolvedContextStop,
): string | null {
  if (resolved.clampedFrom === undefined) return null;
  return `${modelLabel}: ${withThousands(resolved.clampedFrom)} is above the model ceiling; `
    + `using ${withThousands(resolved.raw)} (${withThousands(resolved.effective)} effective).`;
}

/** Stable preference key for a saved stop. */
export function contextModeKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

/** Read a saved stop, ignoring malformed entries rather than throwing. */
export function readContextStop(
  modes: Record<string, unknown> | undefined,
  providerId: string,
  modelId: string,
): ContextStop | undefined {
  const value = modes?.[contextModeKey(providerId, modelId)];
  if (value === 'standard' || value === 'max') return value;
  return positiveInteger(value);
}

/**
 * Launch-scoped stops from `--context`. Set during argument parsing and never
 * written to preferences, so a one-off large-window session leaves the saved
 * default alone. Only applies within this process; a shared background `clodex
 * server` uses saved stops for every client it bridges.
 */
let sessionContextStops: Record<string, ContextStop> = Object.create(null);

/**
 * Saved stops, primed once from preferences at process start. The registry layer
 * deliberately does not read configuration, so the value is handed to it rather
 * than fetched. An unprimed process resolves every model to `standard`, which is
 * the current behavior and the safe side of a pricing boundary.
 */
let savedContextStops: Record<string, unknown> | undefined;

export function setSessionContextStops(stops: Record<string, ContextStop>): void {
  sessionContextStops = { ...stops };
}

export function primeSavedContextStops(stops: Record<string, unknown> | undefined): void {
  savedContextStops = stops;
}

export function resetContextStops(): void {
  sessionContextStops = Object.create(null);
  savedContextStops = undefined;
}

/**
 * Session override first, then the saved stop, then the standard default. Callers
 * that already hold preferences may pass them rather than relying on the prime.
 */
export function selectContextStop(
  providerId: string,
  modelId: string,
  savedOverride?: Record<string, unknown>,
): ContextStop {
  const session = sessionContextStops[contextModeKey(providerId, modelId)];
  if (session !== undefined) return session;
  return readContextStop(savedOverride ?? savedContextStops, providerId, modelId) ?? 'standard';
}

/** Limits carried by a catalog entry, in the shape the resolver needs. */
export function contextLimitsFrom(
  model: Partial<ContextLimits>,
  fallbackContextWindow: number,
): ContextLimits {
  return {
    contextWindow: positiveInteger(model.contextWindow) ?? fallbackContextWindow,
    maxContextWindow: model.maxContextWindow,
    effectiveContextPercent: model.effectiveContextPercent,
    pricingBoundary: model.pricingBoundary,
    pricingBoundaryNote: model.pricingBoundaryNote,
  };
}
