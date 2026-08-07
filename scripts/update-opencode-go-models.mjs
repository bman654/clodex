#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REPOSITORY = 'monotykamary/pi-opencode-go-provider';
const DEFAULT_REF = 'main';
const MODELS_PATH = resolve('src/data/opencode-go-models.json');
const CONSTANTS_PATH = resolve('src/data/opencode-go-models.ts');
const SUPPORTED_APIS = new Set(['anthropic-messages', 'openai-completions']);
const NPM_FOR_API = {
  'anthropic-messages': '@ai-sdk/anthropic',
  'openai-completions': '@ai-sdk/openai-compatible',
};

function requestHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'clodex-opencode-go-catalog-updater',
  };
  if (process.env.GITHUB_TOKEN?.trim()) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN.trim()}`;
  }
  return headers;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  return response.json();
}

async function resolveSourceRef(ref) {
  const result = await fetchJson(
    `https://api.github.com/repos/${REPOSITORY}/commits/${encodeURIComponent(ref)}`,
    requestHeaders(),
  );
  if (typeof result.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(result.sha)) {
    throw new Error(`GitHub did not return a commit SHA for ${ref}`);
  }
  return result.sha;
}

function applyPatch(model, patch = {}) {
  const merged = { ...model, ...patch };
  if (model.cost || patch.cost) {
    merged.cost = { ...(model.cost ?? {}), ...(patch.cost ?? {}) };
  }
  if (model.compat || patch.compat) {
    merged.compat = { ...(model.compat ?? {}), ...(patch.compat ?? {}) };
  }
  return merged;
}


function buildSourceModels(baseModels, customModels, patches) {
  const byId = new Map();
  for (const model of baseModels) {
    if (!model || typeof model.id !== 'string') continue;
    byId.set(model.id, applyPatch(model, patches[model.id]));
  }
  for (const model of customModels) {
    if (!model || typeof model.id !== 'string') continue;
    byId.set(model.id, applyPatch(model, patches[model.id]));
  }
  return [...byId.values()];
}

function toClodexModel(model) {
  const compatibility = {
    ...(model.compat ?? {}),
    ...(model.thinkingLevelMap ? { reasoningEffortMap: model.thinkingLevelMap } : {}),
  };
  const cost = {
    input: model.cost?.input ?? 0,
    output: model.cost?.output ?? 0,
    ...(model.cost?.cacheRead ? { cache_read: model.cost.cacheRead } : {}),
    ...(model.cost?.cacheWrite ? { cache_write: model.cost.cacheWrite } : {}),
  };

  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    cost,
    modelFormat: model.api === 'anthropic-messages' ? 'anthropic' : 'openai',
    npm: NPM_FOR_API[model.api],
    apiUrl: model.baseUrl,
    reasoning: model.reasoning === true,
    modalities: (model.input ?? ['text']).filter(value => value === 'text' || value === 'image'),
    ...(Object.keys(compatibility).length > 0 ? { compatibility } : {}),
    upstreamModelId: model.id,
    family: model.id.split('-')[0] ?? model.id,
  };
}

async function updateSourceConstant(sha) {
  const source = await readFile(CONSTANTS_PATH, 'utf8');
  const pattern = /export const OPENCODE_GO_SOURCE_REF = '[0-9a-f]{40}';/;
  if (!pattern.test(source)) {
    throw new Error('Could not find OPENCODE_GO_SOURCE_REF in opencode-go-models.ts');
  }
  await writeFile(
    CONSTANTS_PATH,
    source.replace(pattern, `export const OPENCODE_GO_SOURCE_REF = '${sha}';`),
  );
}

async function main() {
  const requestedRef = process.env.OPENCODE_GO_SOURCE_REF?.trim() || DEFAULT_REF;
  const sha = await resolveSourceRef(requestedRef);
  const rawBase = `https://raw.githubusercontent.com/${REPOSITORY}/${sha}`;
  const [baseModels, patches, customModels] = await Promise.all([
    fetchJson(`${rawBase}/models.json`),
    fetchJson(`${rawBase}/patch.json`),
    fetchJson(`${rawBase}/custom-models.json`),
  ]);
  if (
    !Array.isArray(baseModels)
    || !Array.isArray(customModels)
    || !patches
    || typeof patches !== 'object'
  ) {
    throw new Error('Unexpected upstream catalog shape');
  }

  const supported = [];
  const excluded = [];
  for (const model of buildSourceModels(baseModels, customModels, patches)) {
    if (!SUPPORTED_APIS.has(model.api)) {
      excluded.push(`${model.id} (${model.api ?? 'unknown'})`);
      continue;
    }
    supported.push(toClodexModel(model));
  }

  if (supported.length === 0) {
    throw new Error('Upstream catalog produced no supported models');
  }
  const ids = new Set();
  for (const model of supported) {
    if (ids.has(model.id)) throw new Error(`Duplicate model id: ${model.id}`);
    ids.add(model.id);
  }

  await writeFile(MODELS_PATH, `${JSON.stringify(supported, null, 2)}\n`);
  await updateSourceConstant(sha);

  console.log(`Updated ${supported.length} OpenCode Go models from ${sha}.`);
  if (excluded.length > 0) {
    console.log(`Excluded unsupported transports: ${excluded.join(', ')}`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
