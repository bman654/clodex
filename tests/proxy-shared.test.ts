import { describe, expect, it } from 'vitest';
import {
  parseDsmlToolCalls,
  rememberToolReasoning,
  getToolReasoning,
  resetToolReasoningRegistryForTests,
} from '../src/proxy-shared.js';

describe('parseDsmlToolCalls', () => {
  it('parses a single invoke with a string parameter (clean fullwidth-pipe spec form)', () => {
    const text = '<｜DSML｜tool_calls><｜DSML｜invoke name="exec_command">'
      + '<｜DSML｜parameter name="cmd" string="true">ls -la</｜DSML｜parameter>'
      + '</｜DSML｜invoke></｜DSML｜tool_calls>';

    const result = parseDsmlToolCalls(text);

    expect(result).not.toBeNull();
    expect(result!.calls).toEqual([{ name: 'exec_command', args: { cmd: 'ls -la' } }]);
    expect(result!.leadingText).toBe('');
  });

  it('parses multiple parallel invokes', () => {
    const text = '<｜DSML｜tool_calls>'
      + '<｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path" string="true">a.ts</｜DSML｜parameter></｜DSML｜invoke>'
      + '<｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path" string="true">b.ts</｜DSML｜parameter></｜DSML｜invoke>'
      + '</｜DSML｜tool_calls>';

    const result = parseDsmlToolCalls(text);

    expect(result!.calls).toEqual([
      { name: 'read_file', args: { path: 'a.ts' } },
      { name: 'read_file', args: { path: 'b.ts' } },
    ]);
  });

  it('parses a JSON-typed (string="false") parameter', () => {
    const text = '<｜DSML｜tool_calls><｜DSML｜invoke name="update_plan">'
      + '<｜DSML｜parameter name="steps" string="false">["a","b"]</｜DSML｜parameter>'
      + '</｜DSML｜invoke></｜DSML｜tool_calls>';

    const result = parseDsmlToolCalls(text);

    expect(result!.calls[0]!.args).toEqual({ steps: ['a', 'b'] });
  });

  it('falls back to the raw string when a string="false" parameter is not valid JSON', () => {
    const text = '<｜DSML｜tool_calls><｜DSML｜invoke name="x">'
      + '<｜DSML｜parameter name="y" string="false">not json</｜DSML｜parameter>'
      + '</｜DSML｜invoke></｜DSML｜tool_calls>';

    const result = parseDsmlToolCalls(text);

    expect(result!.calls[0]!.args).toEqual({ y: 'not json' });
  });

  it('preserves a literal pipe character inside a string parameter value (shell pipe)', () => {
    const text = '<｜DSML｜tool_calls><｜DSML｜invoke name="exec_command">'
      + '<｜DSML｜parameter name="cmd" string="true">cat file.ts | sed -n \'1,10p\'</｜DSML｜parameter>'
      + '</｜DSML｜invoke></｜DSML｜tool_calls>';

    const result = parseDsmlToolCalls(text);

    expect(result!.calls[0]!.args.cmd).toBe("cat file.ts | sed -n '1,10p'");
  });

  it('matches the degraded ASCII-pipe-with-whitespace variant observed live', () => {
    const text = '< |  | DSML |  | tool_calls>'
      + '< |  | DSML |  | invoke name="exec_command">'
      + '< |  | DSML |  | parameter name="cmd" string="true">cat a.ts | sed -n \'1,5p\'</ |  | DSML |  | parameter>'
      + '</ |  | DSML |  | invoke>'
      + '</ |  | DSML |  | tool_calls>';

    const result = parseDsmlToolCalls(text);

    expect(result).not.toBeNull();
    expect(result!.calls).toEqual([{ name: 'exec_command', args: { cmd: "cat a.ts | sed -n '1,5p'" } }]);
  });

  it('preserves leading prose before the DSML block', () => {
    const text = 'Let me check that file.\n<｜DSML｜tool_calls><｜DSML｜invoke name="exec_command">'
      + '<｜DSML｜parameter name="cmd" string="true">ls</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';

    const result = parseDsmlToolCalls(text);

    expect(result!.leadingText).toBe('Let me check that file.');
  });

  it('returns null for plain text with no DSML markers', () => {
    expect(parseDsmlToolCalls('Here is a normal, short summary of the changes.')).toBeNull();
  });

  it('returns null for a truncated block missing the closing tag', () => {
    const text = '<｜DSML｜tool_calls><｜DSML｜invoke name="exec_command">'
      + '<｜DSML｜parameter name="cmd" string="true">ls';

    expect(parseDsmlToolCalls(text)).toBeNull();
  });
});

describe('toolReasoningRegistry', () => {
  it('stores and retrieves reasoning by raw and suffixed tool call ID', () => {
    resetToolReasoningRegistryForTests();

    rememberToolReasoning('call_abc123', 'thinking step 1');
    expect(getToolReasoning('call_abc123')).toBe('thinking step 1');
    expect(getToolReasoning('call_abc123__ts__dGVzdA')).toBe('thinking step 1');

    rememberToolReasoning('call_def456__ts__c2lnbmF0dXJl', 'thinking step 2');
    expect(getToolReasoning('call_def456')).toBe('thinking step 2');
    expect(getToolReasoning('call_def456__ts__c2lnbmF0dXJl')).toBe('thinking step 2');

    expect(getToolReasoning('unknown')).toBeUndefined();
    expect(getToolReasoning('')).toBeUndefined();
  });

  it('evicts oldest entries when registry exceeds MAX_STORED_TOOL_REASONING', () => {
    resetToolReasoningRegistryForTests();

    for (let i = 0; i < 1005; i++) {
      rememberToolReasoning(`call_${i}`, `reasoning_${i}`);
    }

    expect(getToolReasoning('call_0')).toBeUndefined();
    expect(getToolReasoning('call_1004')).toBe('reasoning_1004');
  });

  it('clears all entries with resetToolReasoningRegistryForTests', () => {
    resetToolReasoningRegistryForTests();
    rememberToolReasoning('call_test', 'thinking');
    expect(getToolReasoning('call_test')).toBe('thinking');

    resetToolReasoningRegistryForTests();
    expect(getToolReasoning('call_test')).toBeUndefined();
  });
});
