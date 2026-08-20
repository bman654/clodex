// One warning per model per process when a request crosses a provider's higher-rate
// input boundary. Window math cannot catch this: Claude Code counts tokens in
// Anthropic shape and the provider counts them after translation, so only the
// returned usage settles it.

const warnedModels = new Set<string>();

export interface PricingBoundaryObservation {
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
 */
export function reportPricingBoundaryCrossing(
  observation: PricingBoundaryObservation,
  emit: (message: string) => void = message => console.error(message),
): boolean {
  const { modelLabel, pricingBoundary, inputTokens } = observation;
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
  if (warnedModels.has(modelLabel)) return false;
  warnedModels.add(modelLabel);
  emit(formatPricingBoundaryWarning(modelLabel, pricingBoundary, inputTokens));
  return true;
}

export function resetPricingBoundaryWarnings(): void {
  warnedModels.clear();
}
