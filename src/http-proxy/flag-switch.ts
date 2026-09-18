const MAX_FLAG_SWITCH_ENTRIES = 256;
const REGEXP_SPECIAL = /[\\^$.*+?()[\]{}|]/g;

export interface FlagFallbackRule {
  match: string;
  route: string;
}

/** First matching rule wins; `*` is the only wildcard. */
export function fallbackRouteFor(
  model: string,
  rules: FlagFallbackRule[],
): string | undefined {
  for (const rule of rules) {
    const pattern = rule.match
      .split('*')
      .map(part => part.replace(REGEXP_SPECIAL, '\\$&'))
      .join('.*');
    if (new RegExp(`^${pattern}$`).test(model)) return rule.route;
  }
  return undefined;
}

/** What one decoded SSE block means for the hold. */
export type FlagSignal =
  | { kind: 'content' }
  | { kind: 'refusal'; category?: string };

export function flagSignalFromSseBlock(block: string): FlagSignal | undefined {
  const lines = block.replace(/\r\n/g, '\n').split('\n');
  const event = lines.find(line => line.startsWith('event:'))?.slice('event:'.length).trim();
  const data = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n');
  if (!data) return undefined;

  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const type = parsed.type;
    if (event && event !== type) return undefined;
    if (type === 'content_block_start') return { kind: 'content' };
    if (type !== 'message_delta') return undefined;

    const delta = parsed.delta as Record<string, unknown> | undefined;
    if (delta?.stop_reason !== 'refusal') return undefined;
    const stopDetails = delta.stop_details as Record<string, unknown> | undefined;
    const category = stopDetails?.category;
    return typeof category === 'string'
      ? { kind: 'refusal', category }
      : { kind: 'refusal' };
  } catch {
    return undefined;
  }
}

/** `(session, model)` to route id, bounded by oldest insertion. */
export class FlagSwitchMemory {
  private readonly routes = new Map<string, string>();

  get(sessionId: string, model: string): string | undefined {
    return this.routes.get(JSON.stringify([sessionId, model]));
  }

  set(sessionId: string, model: string, routeId: string): void {
    const key = JSON.stringify([sessionId, model]);
    this.routes.delete(key);
    this.routes.set(key, routeId);
    if (this.routes.size <= MAX_FLAG_SWITCH_ENTRIES) return;
    const oldest = this.routes.keys().next().value;
    if (oldest !== undefined) this.routes.delete(oldest);
  }
}
