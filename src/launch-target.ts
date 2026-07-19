import type { LocalProvider, LocalProviderModel, UserPreferences } from './types.js';

export interface LaunchTarget {
  providerId?: string;
  modelId?: string;
}

export interface LaunchWizardPlan {
  skip: boolean;
  target: LaunchTarget | null;
  error?: string;
}

export function parseModelSlug(modelRef: string): { providerId?: string; modelId: string } {
  const idx = modelRef.indexOf('__');
  if (idx > 0) {
    return { providerId: modelRef.slice(0, idx), modelId: modelRef.slice(idx + 2) };
  }
  return { modelId: modelRef };
}

export function isClaudePrintMode(args: string[]): boolean {
  for (const arg of args) {
    if (arg === '--print' || arg === '-p') return true;
    if (arg.startsWith('--print=')) return true;
  }
  return false;
}

function readFlagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === flag) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.some(arg => arg === flag || arg.startsWith(`${flag}=`));
}

/** Claude -p with JSON or NDJSON on stdout — clodex must stay off stdout. */
export function isClaudeMachineReadableOutput(args: string[]): boolean {
  if (!isClaudePrintMode(args)) return false;
  const outFmt = readFlagValue(args, '--output-format');
  if (outFmt === 'stream-json' || outFmt === 'json') return true;
  const inFmt = readFlagValue(args, '--input-format');
  return inFmt === 'stream-json';
}

export function wantsCleanAgentStdout(agent: 'claude', childArgs: string[]): boolean {
  return isClaudeMachineReadableOutput(childArgs);
}

/** Claude requires --verbose with stream-json in print mode. */
export function normalizeClaudeAgentArgs(args: string[]): string[] {
  const out = [...args];
  const streamOut = readFlagValue(out, '--output-format') === 'stream-json';
  const streamIn = readFlagValue(out, '--input-format') === 'stream-json';
  if ((streamOut || streamIn) && isClaudePrintMode(out) && !hasFlag(out, '--verbose')) {
    out.push('--verbose');
  }
  return out;
}

export function resolveLaunchTarget(
  explicit: LaunchTarget,
  prefs: Pick<UserPreferences, 'lastProvider' | 'lastModel'>,
  _agent: 'claude' = 'claude',
): LaunchTarget | null {
  const slug = explicit.modelId ? parseModelSlug(explicit.modelId) : null;
  const providerId = explicit.providerId ?? slug?.providerId ?? prefs.lastProvider;
  const modelId = slug?.modelId ?? explicit.modelId ?? prefs.lastModel;
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

export function findProviderAndModel(
  providers: LocalProvider[],
  target: LaunchTarget,
): { provider: LocalProvider; model: LocalProviderModel } | null {
  if (!target.providerId || !target.modelId) return null;
  const provider = providers.find(p => p.id === target.providerId);
  if (!provider) return null;
  const model = provider.models.find(m => m.id === target.modelId);
  if (!model) return null;
  return { provider, model };
}

export function hasCompleteExplicitLaunch(explicit: LaunchTarget): boolean {
  if (explicit.providerId && explicit.modelId) return true;
  if (explicit.modelId) {
    const slug = parseModelSlug(explicit.modelId);
    return !!slug.providerId;
  }
  return false;
}

export function planLaunchWizard(opts: {
  explicit: LaunchTarget;
  childArgs: string[];
  agent: 'claude';
  prefs: UserPreferences;
}): LaunchWizardPlan {
  const { explicit, childArgs, prefs } = opts;
  const explicitComplete = hasCompleteExplicitLaunch(explicit);
  const nonInteractive = isClaudePrintMode(childArgs);

  if (explicitComplete) {
    const target = resolveLaunchTarget(explicit, prefs);
    if (!target) {
      return {
        skip: false,
        target: null,
        error: 'Both --provider and --model are required (or use provider__model slug with --model).',
      };
    }
    return { skip: true, target };
  }

  if (explicit.providerId || explicit.modelId) {
    return {
      skip: false,
      target: null,
      error: 'Both --provider and --model are required (or use provider__model slug with --model).',
    };
  }

  if (nonInteractive) {
    const target = resolveLaunchTarget(explicit, prefs);
    if (!target) {
      return {
        skip: false,
        target: null,
        error: 'Print mode requires --provider and --model, or saved preferences from a prior launch.',
      };
    }
    return { skip: true, target };
  }

  return { skip: false, target: null };
}
