// tests/launch.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBinaryOnPath } from '../src/binary-lookup.js';
import { buildClaudeArgs, findClaudeBinary } from '../src/launch.js';
import { setAppPathOverride } from '../src/config.js';

describe('buildClaudeArgs', () => {
  it('omits --model in native-auth HTTP proxy mode', () => {
    expect(buildClaudeArgs(undefined, ['-c'])).toEqual(['-c']);
  });

  it('builds model args when no extra args are provided', () => {
    expect(buildClaudeArgs('claude-sonnet-4-6', [])).toEqual(['--model', 'claude-sonnet-4-6']);
  });

  it('preserves -c', () => {
    expect(buildClaudeArgs('claude-sonnet-4-6', ['-c'])).toEqual(['--model', 'claude-sonnet-4-6', '-c']);
  });

  it('preserves resume session id', () => {
    expect(buildClaudeArgs('claude-sonnet-4-6', ['--resume', 'abc-123'])).toEqual([
      '--model',
      'claude-sonnet-4-6',
      '--resume',
      'abc-123',
    ]);
  });

  it('preserves prompt text', () => {
    expect(buildClaudeArgs('claude-sonnet-4-6', ['--print', 'hello'])).toEqual([
      '--model',
      'claude-sonnet-4-6',
      '--print',
      'hello',
    ]);
  });
});

describe('findBinaryOnPath', () => {
  it('trusts a PATH hit by default', () => {
    const result = findBinaryOnPath('claude', ['/fallback/claude'], {
      runWhich: () => '/path/claude\n',
      exists: () => false,
      isWindows: false,
    });

    expect(result).toBe('/path/claude');
  });

  it('revalidates a PATH hit when requested', () => {
    const result = findBinaryOnPath('antigravity', ['/fallback/antigravity'], {
      runWhich: () => '/missing/antigravity\n',
      exists: path => path === '/fallback/antigravity',
      verifyWhichResult: true,
      isWindows: false,
    });

    expect(result).toBe('/fallback/antigravity');
  });

  it('prefers .cmd wrappers on Windows', () => {
    const result = findBinaryOnPath('gemini', [], {
      runWhich: () => 'C:\\bin\\gemini\nC:\\bin\\gemini.cmd\n',
      exists: () => true,
      isWindows: true,
    });

    expect(result).toBe('C:\\bin\\gemini.cmd');
  });

  it('never shell-interprets the binary name in the default which lookup', () => {
    // Regression: commit d887984 hardened detection to argv-based execFileSync;
    // the shared-helper refactor reintroduced shell-string execSync. A name with
    // shell metacharacters must not execute anything.
    const marker = join(mkdtempSync(join(tmpdir(), 'clodex-inj-')), 'pwned');
    try {
      const result = findBinaryOnPath(`no-such-binary; touch ${marker}`, []);
      expect(result).toBeNull();
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(join(marker, '..'), { recursive: true, force: true });
    }
  });
});

describe('findClaudeBinary app path override', () => {
  let tempHome: string;
  let previousRelayHome: string | undefined;
  let previousClaudePath: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'clodex-launch-test-'));
    previousRelayHome = process.env['CLODEX_HOME'];
    previousClaudePath = process.env['CLODEX_CLAUDE_PATH'];
    process.env['CLODEX_HOME'] = join(tempHome, 'relay-home');
    delete process.env['CLODEX_CLAUDE_PATH'];
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (previousRelayHome === undefined) delete process.env['CLODEX_HOME'];
    else process.env['CLODEX_HOME'] = previousRelayHome;
    if (previousClaudePath === undefined) delete process.env['CLODEX_CLAUDE_PATH'];
    else process.env['CLODEX_CLAUDE_PATH'] = previousClaudePath;
  });

  it('prefers CLODEX_CLAUDE_PATH over a saved app path override', () => {
    const savedClaude = join(tempHome, 'saved-claude');
    const environmentClaude = join(tempHome, 'environment-claude');
    writeFileSync(savedClaude, '#!/bin/sh\n');
    writeFileSync(environmentClaude, '#!/bin/sh\n');
    setAppPathOverride('claude', savedClaude);
    process.env['CLODEX_CLAUDE_PATH'] = environmentClaude;

    expect(findClaudeBinary()).toBe(environmentClaude);
  });

  it('does not fall back when CLODEX_CLAUDE_PATH points to a missing binary', () => {
    const savedClaude = join(tempHome, 'saved-claude');
    writeFileSync(savedClaude, '#!/bin/sh\n');
    setAppPathOverride('claude', savedClaude);
    process.env['CLODEX_CLAUDE_PATH'] = join(tempHome, 'missing-claude');

    expect(findClaudeBinary()).toBeNull();
  });

  it('prefers a saved app path override over auto-detection', () => {
    const customClaude = join(tempHome, 'custom-claude');
    writeFileSync(customClaude, '#!/bin/sh\n');
    setAppPathOverride('claude', customClaude);

    expect(findClaudeBinary()).toBe(customClaude);
  });
});
