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

/** Claude -p with JSON or NDJSON on stdout — relay-ai must stay off stdout. */
export function isClaudeMachineReadableOutput(args: string[]): boolean {
  if (!isClaudePrintMode(args)) return false;
  const outFmt = readFlagValue(args, '--output-format');
  if (outFmt === 'stream-json' || outFmt === 'json') return true;
  const inFmt = readFlagValue(args, '--input-format');
  return inFmt === 'stream-json';
}

/** Codex exec --json — JSONL events on stdout. */
export function isCodexMachineReadableOutput(args: string[]): boolean {
  return args.includes('--json');
}

export function wantsCleanAgentStdout(agent: 'claude' | 'codex', childArgs: string[]): boolean {
  return agent === 'claude'
    ? isClaudeMachineReadableOutput(childArgs)
    : isCodexMachineReadableOutput(childArgs);
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

function skipAttachedFlagValue(args: string[], index: number): number {
  const arg = args[index]!;
  if (!arg.startsWith('-') || arg === '--' || arg.includes('=')) return index;
  const next = args[index + 1];
  if (next && !next.startsWith('-')) return index + 1;
  return index;
}

/** True when Codex gets a subcommand or positional prompt (not flag-only). */
export function isCodexNonInteractive(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') return false;
    if (arg.startsWith('-')) {
      i = skipAttachedFlagValue(args, i);
      continue;
    }
    return true;
  }
  return false;
}

export function resolveLaunchTarget(
  explicit: LaunchTarget,
  prefs: Pick<UserPreferences, 'lastProvider' | 'lastModel' | 'lastCodexProvider' | 'lastCodexModel'>,
  agent: 'claude' | 'codex',
): LaunchTarget | null {
  const slug = explicit.modelId ? parseModelSlug(explicit.modelId) : null;
  const providerId = explicit.providerId
    ?? slug?.providerId
    ?? (agent === 'claude' ? prefs.lastProvider : prefs.lastCodexProvider);
  const modelId = slug?.modelId
    ?? explicit.modelId
    ?? (agent === 'claude' ? prefs.lastModel : prefs.lastCodexModel);
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
  agent: 'claude' | 'codex';
  prefs: UserPreferences;
}): LaunchWizardPlan {
  const { explicit, childArgs, agent, prefs } = opts;
  const explicitComplete = hasCompleteExplicitLaunch(explicit);
  const nonInteractive = agent === 'claude'
    ? isClaudePrintMode(childArgs)
    : isCodexNonInteractive(childArgs);

  if (explicitComplete) {
    const target = resolveLaunchTarget(explicit, prefs, agent);
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
    const target = resolveLaunchTarget(explicit, prefs, agent);
    if (!target) {
      return {
        skip: false,
        target: null,
        error: nonInteractiveLaunchError(agent),
      };
    }
    return { skip: true, target };
  }

  return { skip: false, target: null };
}

function nonInteractiveLaunchError(agent: 'claude' | 'codex'): string {
  return agent === 'claude'
    ? 'Print mode requires --provider and --model, or saved preferences from a prior launch.'
    : 'Non-interactive Codex launch requires --provider and --model, or saved preferences from a prior launch.';
}
