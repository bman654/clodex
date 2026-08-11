// Review-only mutation harness for PR #78.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { applyClodexPatches } from '../src/patch-transforms.js';
import { NETWORK_ENV_CONTRACT_VAR } from '../src/network-env.js';

const bundlePath = join(
  process.env['REVIEW_BUNDLE_DIR'] ?? '',
  'claude-2.1.226-013a1cf17df5ff1d.js',
);
const pristine = readFileSync(bundlePath, 'utf8');
const merge = 'let u={...process.env,...tTs,...e,...n}';

function extractPatchedBuilder(source: string): string {
  const marker = source.indexOf('/*ccpatch:child-network-env*/');
  expect(marker).toBeGreaterThan(-1);
  const start = source.slice(0, marker).lastIndexOf('function ');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced builder');
}

it('fails closed when only the returned merge spread migrates to the live accessor', () => {
  expect(pristine.split(merge)).toHaveLength(2);
  const drifted = pristine.replace(merge, 'let u={...te,...tTs,...e,...n}');
  expect(drifted).not.toBe(pristine);

  const result = applyClodexPatches(drifted, {
    'clodex:openai:gpt-5.6-sol': { alias: 'sol', display: 'GPT-5.6 Sol' },
  });
  expect(result.results.find(item => item.name.startsWith('PATCH 10'))?.status).toBe('OK');

  const builder = extractPatchedBuilder(result.content);
  const env: Record<string, string> = {
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://127.0.0.1:49653',
    NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem',
    [NETWORK_ENV_CONTRACT_VAR]: JSON.stringify({
      version: 1,
      original: { HTTPS_PROXY: 'http://corp-proxy:3128', NODE_EXTRA_CA_CERTS: null },
      injected: {
        HTTPS_PROXY: 'http://127.0.0.1:49653',
        NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem',
      },
    }),
  };
  const factory = new Function(
    'bht', 'tTs', 'yr', 'mxu', 'jP_', 'rTs', 'slo', 'Yin', 'GP_', 'te', 'process',
    `return (${builder})`,
  );
  const childEnv = factory(
    () => ({}),
    { FORCE_MERGE: '1' },
    (value: unknown) => value === true || value === '1' || value === 'true',
    (value: unknown) => value,
    () => false,
    () => false,
    () => [],
    [],
    ['ANTHROPIC_API_KEY'],
    env,
    { env },
  )() as Record<string, string>;

  expect(childEnv).toEqual({
    PATH: '/usr/bin',
    FORCE_MERGE: '1',
    HTTPS_PROXY: 'http://corp-proxy:3128',
  });
});
