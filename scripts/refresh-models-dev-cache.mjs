#!/usr/bin/env node
// Regenerate src/data/models-dev-cache.json from models.dev (maintainer script).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_URL = 'https://models.dev/api.json';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'models-dev-cache.json');

const response = await fetch(API_URL, { headers: { Accept: 'application/json' } });
if (!response.ok) {
  console.error(`fetch failed: HTTP ${response.status}`);
  process.exit(1);
}

const data = await response.json();
if (!data || typeof data !== 'object') {
  console.error('invalid JSON payload');
  process.exit(1);
}

const providerCount = Object.keys(data).filter(k => !k.startsWith('_')).length;
const out = {
  _relay_meta: {
    schema_version: '1',
    fetched_at: new Date().toISOString(),
    source: API_URL,
    provider_count: providerCount,
  },
  ...data,
};

writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.log(`Wrote ${OUT} (${providerCount} providers)`);
