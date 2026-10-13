/**
 * OpenAI Daybreak cybersecurity access programs on ChatGPT/Codex OAuth routes:
 * https://developers.openai.com/api/docs/guides/daybreak
 *
 * The Codex model catalog advertises, per model and per account, which programs
 * a request may select (`available_access_programs.cyber`). A saved alias opts
 * in with `daybreak: true`; the program it sends is chosen from that list the
 * way native Codex chooses it, so the user never names a vendor value and an
 * ineligible model is reported before the first request instead of failing it
 * with a 403.
 */
import { isOpenAiOAuthRoute } from './sdk-adapter.js';

export const CYBER_ACCESS_PROGRAMS = ['standard', 'daybreak_blue', 'daybreak_red'] as const;
export type CyberAccessProgram = (typeof CYBER_ACCESS_PROGRAMS)[number];
export type DaybreakAccessProgram = Exclude<CyberAccessProgram, 'standard'>;

/** The Responses `access_programs` request field. */
export interface AccessPrograms {
  cyber: CyberAccessProgram;
}

/** Native Codex prefers Blue over Red when a model advertises both. */
const DAYBREAK_PREFERENCE: readonly DaybreakAccessProgram[] = ['daybreak_blue', 'daybreak_red'];

const DAYBREAK_LABELS: Record<DaybreakAccessProgram, string> = {
  daybreak_blue: 'Daybreak Blue',
  daybreak_red: 'Daybreak Red',
};

function isCyberAccessProgram(value: unknown): value is CyberAccessProgram {
  return typeof value === 'string' && (CYBER_ACCESS_PROGRAMS as readonly string[]).includes(value);
}

/**
 * Read a catalog row's `available_access_programs`. Undefined means the catalog
 * said nothing, which is not the same answer as an empty list. Programs this
 * version does not know are dropped rather than failing the row, so a new
 * server-side program cannot break catalog refresh.
 */
export function readCyberAccessPrograms(value: unknown): CyberAccessProgram[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return cyberAccessProgramList((value as { cyber?: unknown }).cyber);
}

/** Validate a stored program list; the registry cache is read back from disk unchecked. */
export function cyberAccessProgramList(value: unknown): CyberAccessProgram[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter(isCyberAccessProgram))];
}

export function daybreakProgramLabel(program: CyberAccessProgram): string {
  return program === 'standard' ? 'Standard' : DAYBREAK_LABELS[program];
}

/** What an alias's route needs to know to pick a Daybreak program. */
export interface DaybreakTarget {
  modelId: string;
  npm?: string;
  authType?: string;
  cyberAccessPrograms?: readonly CyberAccessProgram[];
}

export type AliasDaybreak =
  | { kind: 'off' }
  | { kind: 'on'; accessPrograms: AccessPrograms }
  | { kind: 'unavailable'; reason: string };

/**
 * Decide what a saved alias sends. An alias that asked for Daybreak never falls
 * back to sending nothing: that would quietly run the user's prompts under the
 * default treatment they opted out of.
 */
export function resolveAliasDaybreak(
  alias: { daybreak?: boolean },
  target: DaybreakTarget,
): AliasDaybreak {
  if (alias.daybreak !== true) return { kind: 'off' };
  if (!isOpenAiOAuthRoute(target)) {
    return { kind: 'unavailable', reason: 'Daybreak needs a ChatGPT/Codex sign-in (openai-oauth)' };
  }
  if (target.cyberAccessPrograms === undefined) {
    return {
      kind: 'unavailable',
      reason: `the saved catalog has no Daybreak information for ${target.modelId}; `
        + 'run `clodex providers refresh-models` to load it',
    };
  }
  const program = DAYBREAK_PREFERENCE.find(candidate => target.cyberAccessPrograms!.includes(candidate));
  if (!program) {
    return {
      kind: 'unavailable',
      reason: `Daybreak isn't available for ${target.modelId} on this ChatGPT account`,
    };
  }
  return { kind: 'on', accessPrograms: { cyber: program } };
}

/** Wraps a fetch so its JSON request bodies carry `access_programs`. */
export function withAccessPrograms(
  inner: typeof fetch,
  accessPrograms: AccessPrograms | undefined,
): typeof fetch {
  if (!accessPrograms) return inner;
  return (input, init) => {
    if (typeof init?.body !== 'string') return inner(input, init);
    let parsed: unknown;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      return inner(input, init);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return inner(input, init);
    const body = JSON.stringify({ ...parsed, access_programs: accessPrograms });
    return inner(input, { ...init, body });
  };
}
