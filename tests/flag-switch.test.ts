import { describe, expect, it } from 'vitest';

const sse = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

describe('flag switch pure functions', () => {
  it('U1 fallbackRouteFor uses the first matching wildcard rule and returns undefined without one', async () => {
    const { fallbackRouteFor } = await import('../src/http-proxy/flag-switch.js');
    const rules = [
      { match: 'claude-fable-*', route: 'kimi-k3' },
      { match: '*', route: 'deepseek-flash' },
    ];

    expect(fallbackRouteFor('claude-fable-5-1', rules)).toBe('kimi-k3');
    expect(fallbackRouteFor('claude-haiku-4-5', rules)).toBe('deepseek-flash');
    expect(fallbackRouteFor('claude-fable-5-1', [])).toBeUndefined();
  });

  it('U2 flagSignalFromSseBlock distinguishes content, refusal, and non-signals', async () => {
    const { flagSignalFromSseBlock } = await import('../src/http-proxy/flag-switch.js');

    expect(flagSignalFromSseBlock(sse('content_block_start', {
      index: 0,
      content_block: { type: 'text', text: '' },
    }))).toEqual({ kind: 'content' });
    expect(flagSignalFromSseBlock(sse('message_delta', {
      delta: {
        stop_reason: 'refusal',
        stop_details: { category: 'cyber' },
      },
    }))).toEqual({ kind: 'refusal', category: 'cyber' });
    expect(flagSignalFromSseBlock(sse('message_delta', {
      delta: { stop_reason: 'end_turn' },
    }))).toBeUndefined();
    expect(flagSignalFromSseBlock(sse('ping', {}))).toBeUndefined();
    expect(flagSignalFromSseBlock('event: message_delta\ndata: {not json}\n\n')).toBeUndefined();
  });

  it('U3 FlagSwitchMemory isolates session-model pairs and evicts its oldest entry past 256', async () => {
    const { FlagSwitchMemory } = await import('../src/http-proxy/flag-switch.js');
    const memory = new FlagSwitchMemory();

    memory.set('session-1', 'claude-fable-5-1', 'kimi-k3');
    expect(memory.get('session-1', 'claude-fable-5-1')).toBe('kimi-k3');
    expect(memory.get('session-1', 'claude-haiku-4-5')).toBeUndefined();
    expect(memory.get('session-2', 'claude-fable-5-1')).toBeUndefined();

    for (let index = 1; index <= 256; index += 1) {
      memory.set(`session-${index + 1}`, 'claude-fable-5-1', `route-${index}`);
    }

    expect(memory.get('session-1', 'claude-fable-5-1')).toBeUndefined();
    expect(memory.get('session-257', 'claude-fable-5-1')).toBe('route-256');
  });
});
