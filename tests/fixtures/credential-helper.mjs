#!/usr/bin/env node

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const [operation, service, account] = process.argv.slice(2);
const storePath = process.env.CLODEX_TEST_CREDENTIAL_HELPER_STORE;
const mode = process.env.CLODEX_TEST_CREDENTIAL_HELPER_MODE;

if (!operation || !service || !account || !storePath) process.exit(1);
if (mode === 'fail' || mode === `fail-${operation}`) process.exit(1);
if (mode === 'hang-ignore-term') {
  writeFileSync(`${storePath}.helper-pid`, String(process.pid), { encoding: 'utf8', mode: 0o600 });
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

let store = {};
try {
  store = JSON.parse(readFileSync(storePath, 'utf8'));
} catch {
  store = {};
}

const key = `${service}\u0000${account}`;

if (operation === 'get') {
  if (mode === 'delay-stale-read') {
    const firstGetPath = `${storePath}.stale-first-get`;
    let firstGet = false;
    try {
      const fd = openSync(firstGetPath, 'wx');
      closeSync(fd);
      firstGet = true;
    } catch {
      firstGet = false;
    }
    if (firstGet) {
      const releasePath = `${storePath}.release-stale-get`;
      const deadline = Date.now() + 5_000;
      while (!existsSync(releasePath) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (!existsSync(releasePath)) process.exit(1);
    }
  }
  if (mode === 'interleave-readback') {
    const firstGetPath = `${storePath}.first-get`;
    const secondSetPath = `${storePath}.second-set`;
    let firstGet = false;
    try {
      const fd = openSync(firstGetPath, 'wx');
      closeSync(fd);
      firstGet = true;
    } catch {
      firstGet = false;
    }
    if (!firstGet) {
      const deadline = Date.now() + 5_000;
      while (!existsSync(secondSetPath) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (!existsSync(secondSetPath)) process.exit(1);
      store = JSON.parse(readFileSync(storePath, 'utf8'));
    }
  }
  if (!(key in store)) process.exit(2);
  process.stdout.write(mode === 'mismatch' ? 'different-value' : store[key]);
  process.exit(0);
}

if (operation === 'set') {
  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) value += chunk;
  let activeSetPath;
  if (mode === 'detect-overlap') {
    activeSetPath = `${storePath}.active-set`;
    try {
      const fd = openSync(activeSetPath, 'wx');
      closeSync(fd);
      writeFileSync(`${storePath}.set-started`, '', { encoding: 'utf8', mode: 0o600 });
      const releasePath = `${storePath}.release-set`;
      const deadline = Date.now() + 5_000;
      while (!existsSync(releasePath) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (!existsSync(releasePath)) process.exit(1);
    } catch {
      writeFileSync(`${storePath}.overlapping-set`, '', { encoding: 'utf8', mode: 0o600 });
      activeSetPath = undefined;
    }
  }
  store[key] = value;
  writeFileSync(storePath, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 });
  if (activeSetPath) unlinkSync(activeSetPath);
  process.exit(0);
}

if (operation === 'delete') {
  if (!(key in store)) process.exit(2);
  delete store[key];
  writeFileSync(storePath, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 });
  process.exit(0);
}

process.exit(1);
