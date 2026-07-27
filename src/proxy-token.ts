import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { getProxyTokenPath } from './paths.js';
import {
  ensureSecureAppHome,
  syncParentDirectory,
} from './registry/io.js';

const FILE_MODE = 0o600;
const TOKEN_PATTERN = /^sk-ant-clodex-[a-f0-9]{64}$/;

function readProxyToken(path: string): string {
  const token = readFileSync(path, 'utf8').trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(`Invalid Clodex proxy token file: ${path}`);
  }
  try {
    chmodSync(path, FILE_MODE);
  } catch {
    // Best effort on platforms that restrict chmod.
  }
  return token;
}

/**
 * Return a stable, per-user bearer token for Claude Code's loopback proxy.
 *
 * The token must remain stable so Claude Code can remember its custom-key
 * approval. Creation uses an atomic hard-link race so concurrent launches all
 * converge on the same secret without ever exposing a partially written file.
 */
export function getOrCreateProxyToken(path = getProxyTokenPath()): string {
  try {
    return readProxyToken(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }

  ensureSecureAppHome();
  const candidate = `sk-ant-clodex-${randomBytes(32).toString('hex')}`;
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporaryPath, 'wx', FILE_MODE);
  try {
    const payload = Buffer.from(`${candidate}\n`);
    let offset = 0;
    while (offset < payload.length) {
      const written = writeSync(fd, payload, offset, payload.length - offset);
      if (written <= 0) throw new Error(`Could not write Clodex proxy token: ${path}`);
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    try {
      linkSync(temporaryPath, path);
      syncParentDirectory(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
    }
  } finally {
    unlinkSync(temporaryPath);
  }

  return readProxyToken(path);
}
