import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { signAndVerifyMachOCandidate } from '../src/patch-signature.js';

// Exercise a real child process, not a mock of child_process: tweakcc treats codesign's
// failure as a warning, but the patcher must refuse the candidate on either failed command.
describe('Mach-O signing with a failing codesign process', () => {
  it.skipIf(process.platform === 'win32').each([
    ['sign', '#!/bin/sh\nexit 42\n'],
    ['verify', '#!/bin/sh\ncase "$1" in --verify) exit 42;; esac\nexit 0\n'],
  ])('rejects the candidate when %s exits non-zero', (_stage, script) => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-codesign-process-'));
    const binary = join(dir, 'claude');
    const codesign = join(dir, 'codesign');
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const originalPath = process.env.PATH;
    try {
      writeFileSync(binary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
      writeFileSync(codesign, script);
      chmodSync(codesign, 0o755);
      process.env.PATH = dir + delimiter + (originalPath ?? '');
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      expect(() => signAndVerifyMachOCandidate(binary)).toThrow(/Mach-O signing or verification failed/);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
