import {
  effortProviderOptions as providerEffortOptions,
  getReasoningCapabilities,
  type ReasoningCapabilities,
  type ReasoningMetadata,
} from './provider-factory.js';

export type {
  ReasoningCapabilities,
  ReasoningMetadata,
  ReasoningMode,
  ReasoningSource,
  ReasoningConfidence,
  ReasoningWireFormat,
} from './provider-factory.js';

export interface ResolveReasoningInput extends ReasoningMetadata {
  npm: string;
  modelId: string;
}

export function resolveReasoningCapabilities(input: ResolveReasoningInput): ReasoningCapabilities {
  const { npm, modelId, ...metadata } = input;
  return getReasoningCapabilities(npm, modelId, metadata);
}

export function effortProviderOptions(
  npm: string,
  effort?: string,
  modelId?: string,
  metadata?: ReasoningMetadata,
): Record<string, Record<string, unknown>> | undefined {
  return providerEffortOptions(npm, effort, modelId, metadata);
}
