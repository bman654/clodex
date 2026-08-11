// tests/parent-notice.test.ts — the channel itself. What it does while the real
// terminal is muted is covered end-to-end in tests/parent-notice-launch.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitParentNotice, installParentNoticeSink } from '../src/parent-notice.js';

const releases: Array<() => void> = [];

function sink(lines: string[]): void {
  releases.push(installParentNoticeSink(line => lines.push(line)));
}

afterEach(() => {
  while (releases.length) releases.pop()!();
  vi.restoreAllMocks();
});

describe('emitParentNotice', () => {
  it('writes to process.stderr when no sink is installed', () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });

    emitParentNotice('clodex: warning: something');

    expect(written).toEqual(['clodex: warning: something\n']);
  });

  it('sends the notice to the sink instead of the muted stderr', () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });
    const lines: string[] = [];
    sink(lines);

    emitParentNotice('clodex: warning: routed');

    expect(lines).toEqual(['clodex: warning: routed\n']);
    expect(written).toEqual([]);
  });

  it('emits exactly one newline-terminated line however the message is spelled', () => {
    const lines: string[] = [];
    sink(lines);

    emitParentNotice('already terminated\n');
    emitParentNotice('two\nlines');

    // A notice shares the terminal with Claude Code's UI: one line, one newline.
    expect(lines).toEqual(['already terminated\n', 'two lines\n']);
  });

  it('strips control characters so a notice can never repaint the child UI', () => {
    const lines: string[] = [];
    sink(lines);

    emitParentNotice('clodex: \u001b[2Jwarning: \u0007cleared');

    expect(lines[0]).toBe('clodex:  [2Jwarning:  cleared\n');
  });

  it('truncates an unbounded message', () => {
    const lines: string[] = [];
    sink(lines);

    emitParentNotice('x'.repeat(9000));

    expect(lines[0]!.length).toBeLessThan(2100);
    expect(lines[0]).toMatch(/\.\.\.\n$/);
  });

  it('never lets a failing sink break the caller', () => {
    releases.push(installParentNoticeSink(() => { throw new Error('sink exploded'); }));

    expect(() => emitParentNotice('clodex: warning: safe')).not.toThrow();
  });

  it('restores the previous destination when the sink is released', () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });
    const lines: string[] = [];
    const release = installParentNoticeSink(line => lines.push(line));
    release();
    release(); // idempotent: launchClaude can restore from either child handler.

    emitParentNotice('clodex: warning: after release');

    expect(lines).toEqual([]);
    expect(written).toEqual(['clodex: warning: after release\n']);
  });
});
