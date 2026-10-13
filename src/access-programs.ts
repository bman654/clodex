/**
 * OpenAI Responses API access-program selection (`access_programs`), e.g. the
 * Daybreak cybersecurity programs: https://developers.openai.com/api/docs/guides/daybreak
 *
 * Configured per saved model alias (`modelAliases[].accessPrograms`). An unset or
 * invalid value means the field is omitted entirely; the API rejects `null`.
 */
export const CYBER_ACCESS_PROGRAMS = ['standard', 'daybreak_blue', 'daybreak_red'] as const;
export type CyberAccessProgram = (typeof CYBER_ACCESS_PROGRAMS)[number];

export interface AccessPrograms {
  cyber?: CyberAccessProgram;
}

export function isCyberAccessProgram(value: unknown): value is CyberAccessProgram {
  return typeof value === 'string' && (CYBER_ACCESS_PROGRAMS as readonly string[]).includes(value);
}

/** Returns a validated copy, or undefined when nothing valid is configured. */
export function normalizeAccessPrograms(value: unknown): AccessPrograms | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const cyber = (value as { cyber?: unknown }).cyber;
  return isCyberAccessProgram(cyber) ? { cyber } : undefined;
}

export function applyAccessPrograms<T extends Record<string, unknown>>(
  payload: T,
  accessPrograms: AccessPrograms | undefined,
): T {
  if (!accessPrograms?.cyber) return payload;
  const existing = payload.access_programs && typeof payload.access_programs === 'object'
    ? (payload.access_programs as Record<string, unknown>)
    : {};
  return { ...payload, access_programs: { ...existing, cyber: accessPrograms.cyber } };
}

/** Wraps a fetch so JSON request bodies carry the configured access programs. */
export function withAccessPrograms(
  inner: typeof fetch,
  accessPrograms: AccessPrograms | undefined,
): typeof fetch {
  if (!accessPrograms?.cyber) return inner;
  return (input, init) => {
    if (typeof init?.body !== 'string') return inner(input, init);
    let parsed: unknown;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      return inner(input, init);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return inner(input, init);
    const body = JSON.stringify(applyAccessPrograms(parsed as Record<string, unknown>, accessPrograms));
    return inner(input, { ...init, body });
  };
}
