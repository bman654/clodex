import { shouldHideModel, type CompatibilityAgent } from './model-compatibility.js';
import type { LocalProvider, LocalProviderModel } from './types.js';

export type RelayLaunchTarget =
  | 'claude'
  | 'server';

export interface TargetCompatibilityContext {
  target: RelayLaunchTarget;
  providerId: string;
  authType?: 'api' | 'oauth' | 'none';
  model: LocalProviderModel;
}

export interface TargetCompatibilityResult {
  compatible: boolean;
  reason?: string;
}

function blacklistAgentForTarget(target: RelayLaunchTarget): CompatibilityAgent {
  return target;
}

export function isTargetCompatibleModel(ctx: TargetCompatibilityContext): TargetCompatibilityResult {
  const blacklistAgent = blacklistAgentForTarget(ctx.target);
  if (shouldHideModel({ providerId: ctx.providerId, modelId: ctx.model.id, agent: blacklistAgent })) {
    return { compatible: false, reason: 'model is hidden by compatibility filters' };
  }

  if (ctx.model.modelFormat === 'anthropic') {
    return { compatible: true };
  }

  if (ctx.model.modelFormat === 'openai') {
    if (ctx.model.npm) return { compatible: true };
    return { compatible: false, reason: 'OpenAI-format model is missing an SDK provider package' };
  }

  return { compatible: false, reason: `Unsupported model format: ${ctx.model.modelFormat}` };
}

export function routableModelsForTarget(
  provider: LocalProvider,
  target: RelayLaunchTarget,
): LocalProviderModel[] {
  return provider.models.filter(model =>
    isTargetCompatibleModel({
      target,
      providerId: provider.id,
      authType: provider.authType,
      model,
    }).compatible,
  );
}

export function providerForTarget(provider: LocalProvider, target: RelayLaunchTarget): LocalProvider {
  return { ...provider, models: routableModelsForTarget(provider, target) };
}

export function providersForTarget(
  providers: LocalProvider[],
  target: RelayLaunchTarget,
): LocalProvider[] {
  return providers
    .map(provider => providerForTarget(provider, target))
    .filter(provider => provider.models.length > 0);
}
