import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProxyTokenPath } from '../src/paths.js';
import { getOrCreateProxyToken } from '../src/proxy-token.js';

let tempHome: string;
let previousClodexHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clodex-proxy-token-'));
  previousClodexHome = process.env['CLODEX_HOME'];
  process.env['CLODEX_HOME'] = join(tempHome, 'app-home');
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  if (previousClodexHome === undefined) delete process.env['CLODEX_HOME'];
  else process.env['CLODEX_HOME'] = previousClodexHome;
});

describe('stable proxy token', () => {
  it('persists one random token with owner-only permissions', () => {
    const first = getOrCreateProxyToken();
    const second = getOrCreateProxyToken();
    const path = getProxyTokenPath();

    expect(first).toBe(second);
    expect(first).toMatch(/^sk-ant-clodex-[a-f0-9]{64}$/);
    expect(readFileSync(path, 'utf8').trim()).toBe(first);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('uses independent tokens for independent Clodex homes', () => {
    const first = getOrCreateProxyToken();
    process.env['CLODEX_HOME'] = join(tempHome, 'other-app-home');
    const second = getOrCreateProxyToken();

    expect(second).not.toBe(first);
  });

  it('rejects malformed persisted credentials instead of silently replacing them', () => {
    const path = getProxyTokenPath();
    mkdirSync(process.env['CLODEX_HOME']!, { recursive: true });
    writeFileSync(path, 'not-a-valid-token\n', { mode: 0o600 });

    expect(() => getOrCreateProxyToken()).toThrow('Invalid Clodex proxy token file');
  });
});
