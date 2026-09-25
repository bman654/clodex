// A repack or any post-repack blob write invalidates a Mach-O signature. tweakcc treats signing
// failures as warnings, so the patcher must sign and verify its private candidate before publish.
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';

/** Only native Mach-O binaries on macOS require a signature; npm, ELF and PE do not. */
export function signAndVerifyMachOCandidate(path: string, installPath: string = path): void {
  if (process.platform !== 'darwin') return;
  const fd = openSync(path, 'r');
  let machO = false;
  try {
    const magic = Buffer.alloc(4);
    if (readSync(fd, magic, 0, 4, 0) === 4) {
      machO = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe,
        0xcafebabe, 0xcafebabf, 0xbebafeca].includes(magic.readUInt32BE(0));
    }
  } finally {
    closeSync(fd);
  }
  if (!machO) return;

  try {
    execFileSync('codesign', ['-s', '-', '-f', path], { stdio: 'pipe' });
    execFileSync('codesign', ['--verify', '--strict', path], { stdio: 'pipe' });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string } | null)?.stderr;
    const detail = String(stderr ?? '').trim()
      .split(`${path}: `).join('')
      .split(/\r?\n/).filter(line => line !== 'replacing existing signature').join('\n').trim()
      || (error instanceof Error ? error.message.trimEnd() : String(error).trimEnd());
    throw new Error(
      `Mach-O signing or verification failed for ${installPath}: ${detail}. `
      + 'Claude Code was left unchanged.',
    );
  }
}
