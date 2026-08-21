// One warning per model per process when a request crosses a provider's higher-rate
// input boundary. Window math cannot catch this: Claude Code counts tokens in
// Anthropic shape and the provider counts them after translation, so only the
// returned usage settles it.

import { emitParentNotice } from './parent-notice.js';

const warnedModels = new Set<string>();

export interface PricingBoundaryObservation {
  /**
   * Stable identity the latch is keyed on. Two providers can share a display
   * name, and a long-lived `clodex server` bridges them in one process, so
   * latching on the label would let one route silence another.
   */
  modelKey: string;
  /** Model name as the user would recognize it. */
  modelLabel: string;
  /** Input size above which the provider bills the whole request at a higher rate. */
  pricingBoundary?: number;
  /** Total prompt tokens the provider counted, cached portion included. */
  inputTokens?: number;
}

function withThousands(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatPricingBoundaryWarning(
  modelLabel: string,
  boundary: number,
  inputTokens: number,
): string {
  return `clodex: ${modelLabel} request counted ${withThousands(inputTokens)} input tokens, `
    + `above the ${withThousands(boundary)}-token pricing boundary. `
    + 'The provider prices the full request at a higher rate above this point. '
    + 'Set this model to the standard context stop to stay under it.';
}

/**
 * Warn once per model. A missing boundary or missing usage means no warning: an
 * unreported token count is not evidence that the request stayed under the line.
 *
 * emitParentNotice rather than console.error: this fires from a request while
 * `clodex claude` has the parent's stdout/stderr muted for Claude Code's TUI, and
 * console.error resolves the muted write at call time, so the warning would be
 * swallowed on every launch-path session.
 */
export function reportPricingBoundaryCrossing(
  observation: PricingBoundaryObservation,
  emit: (message: string) => void = emitParentNotice,
): boolean {
  const { modelKey, modelLabel, pricingBoundary, inputTokens } = observation;
  if (
    pricingBoundary === undefined
    || !Number.isFinite(pricingBoundary)
    || pricingBoundary <= 0
    || inputTokens === undefined
    || !Number.isFinite(inputTokens)
  ) {
    return false;
  }
  if (inputTokens <= pricingBoundary) return false;
  if (warnedModels.has(modelKey)) return false;
  // Latched only after the write is handed off. Consuming it first would spend the
  // single warning on a channel that dropped it and suppress every later crossing.
  emit(formatPricingBoundaryWarning(modelLabel, pricingBoundary, inputTokens));
  warnedModels.add(modelKey);
  return true;
}

export function resetPricingBoundaryWarnings(): void {
  warnedModels.clear();
}
