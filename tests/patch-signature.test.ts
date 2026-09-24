import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signAndVerifyMachOCandidate } from '../src/patch-signature.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

function withPlatform(platform: string, run: (binary: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'clodex-signature-'));
  const oldPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const binary = join(dir, 'claude');
  try {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    vi.mocked(execFileSync).mockReset();
    run(binary);
  } finally {
    Object.defineProperty(process, 'platform', oldPlatform);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('candidate signature', () => {
  it('signs and verifies a Mach-O before returning', () => withPlatform('darwin', binary => {
    writeFileSync(binary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0]));
    signAndVerifyMachOCandidate(binary);
    expect(vi.mocked(execFileSync).mock.calls.map(([, args]) => args)).toEqual([
      ['-s', '-', '-f', binary],
      ['--verify', '--strict', binary],
    ]);
  }));

  it.each(['sign', 'verify'] as const)('fails closed when codesign %s exits non-zero', stage => {
    withPlatform('darwin', binary => {
      writeFileSync(binary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0]));
      vi.mocked(execFileSync).mockImplementation(((command: string, args: string[]) => {
        if (command === 'codesign' && (args[0] === '--verify') === (stage === 'verify')) {
          throw Object.assign(new Error('fake codesign exited 42'), { status: 42 });
        }
        return '';
      }) as unknown as typeof execFileSync);
      expect(() => signAndVerifyMachOCandidate(binary)).toThrow(/Mach-O signing or verification failed/);
      expect(vi.mocked(execFileSync).mock.calls).toHaveLength(stage === 'sign' ? 1 : 2);
    });
  });

  it.each([
    ['linux', Buffer.from([0xcf, 0xfa, 0xed, 0xfe])],
    ['darwin', Buffer.from('\u007fELF')],
    ['darwin', Buffer.from('MZ00')],
    ['darwin', Buffer.from('#!/bin/sh')],
  ])('does not sign a non-Mach-O candidate on %s', (platform, content) => {
    withPlatform(platform, binary => {
      writeFileSync(binary, content);
      signAndVerifyMachOCandidate(binary);
      expect(execFileSync).not.toHaveBeenCalled();
    });
  });
});
