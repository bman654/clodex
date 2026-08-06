import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { ApplyPatchesOutcome } from './patch-transforms.js';
import { getLocalPatchesPath } from './paths.js';

export const LOCAL_PATCH_API_VERSION = 1;
const LOCAL_PATCH_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_LOCAL_PATCH_BYTES = 1024 * 1024;
const RESERVED_MARKER_PREFIX = '/*ccpatch:';
const LOCAL_MARKER_PREFIX = '/*clodex-local:';
const MAX_ERROR_LENGTH = 300;
let localModuleEvaluationSequence = 0;

function describeLocalError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const redacted = raw.replace(
    /data:text\/javascript;base64,[^\s"'`]+/g,
    '<local-patches.mjs>',
  );
  const singleLine = redacted.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (singleLine.length <= MAX_ERROR_LENGTH) return singleLine || 'unknown error';
  return `${singleLine.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}

function describeLocalId(id: string): string {
  const encoded = JSON.stringify(id);
  return encoded.length <= 96 ? encoded : `${encoded.slice(0, 95)}…`;
}

function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function reservedMarkerInventory(source: string): string {
  const count = countOccurrences(source, RESERVED_MARKER_PREFIX);
  const markers = source.match(/\/\*ccpatch:[\s\S]*?\*\//g)?.sort() ?? [];
  return JSON.stringify([count, markers]);
}

function localMarkerInventory(source: string): string {
  const count = countOccurrences(source, LOCAL_MARKER_PREFIX);
  const markers = source.match(/\/\*clodex-local:[\s\S]*?\*\//g)?.sort() ?? [];
  return JSON.stringify([count, markers]);
}

export interface LocalPatchDefinition {
  id: string;
  apply: (source: string, context: { marker: string }) => string;
}

export type LocalPatchSource =
  | { enabled: false; path: string }
  | {
      enabled: true;
      path: string;
      configIdentity: string;
      source: string;
      error?: never;
    }
  | {
      enabled: true;
      path: string;
      configIdentity: string;
      source?: never;
      error: string;
    };

export function inspectLocalPatchSource(enabled: boolean): LocalPatchSource {
  const path = getLocalPatchesPath();
  if (!enabled) return { enabled: false, path };
  try {
    const stats = statSync(path);
    if (!stats.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EINVAL' });
    if (stats.size > MAX_LOCAL_PATCH_BYTES) {
      throw Object.assign(new Error('module exceeds 1 MiB'), { code: 'EFBIG' });
    }
    const bytes = readFileSync(path);
    if (bytes.length > MAX_LOCAL_PATCH_BYTES) {
      throw Object.assign(new Error('module exceeds 1 MiB'), { code: 'EFBIG' });
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    const source = bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(bytes)) {
      return {
        enabled: true,
        path,
        configIdentity: `v${LOCAL_PATCH_API_VERSION}:invalid-utf8:${digest}`,
        error: `could not read ${path}: module must be UTF-8`,
      };
    }
    return {
      enabled: true,
      path,
      configIdentity: `v${LOCAL_PATCH_API_VERSION}:${digest}`,
      source,
    };
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : 'UNKNOWN';
    const reason = code === 'EFBIG'
      ? 'module exceeds 1 MiB'
      : code === 'EINVAL'
        ? 'not a regular file'
        : code;
    return {
      enabled: true,
      path,
      configIdentity: `v${LOCAL_PATCH_API_VERSION}:unavailable:${code}`,
      error: `could not read ${path}: ${reason}`,
    };
  }
}

function failedLocalTransaction(
  source: string,
  patches: readonly LocalPatchDefinition[],
  results: ApplyPatchesOutcome['results'],
  failedIndex: number,
  extra: string,
): ApplyPatchesOutcome {
  const failedName = `LOCAL ${patches[failedIndex]!.id}`;
  const rolledBack = results.map(result => (
    result.status === 'OK'
      ? {
          status: 'SKIP' as const,
          name: result.name,
          extra: `rolled back after ${failedName} failed`,
        }
      : result
  ));
  rolledBack.push({ status: 'FAIL', name: failedName, extra });
  for (const remaining of patches.slice(failedIndex + 1)) {
    rolledBack.push({
      status: 'SKIP',
      name: `LOCAL ${remaining.id}`,
      extra: `not run after ${failedName} failed`,
    });
  }
  return { content: source, results: rolledBack };
}

function snapshotLocalPatchDefinitions(value: unknown): readonly LocalPatchDefinition[] | string {
  if (!Array.isArray(value)) return 'default export must be an array';
  const rawDefinitions = [...value] as unknown[];
  const snapshot: LocalPatchDefinition[] = [];
  const ids = new Set<string>();
  for (const [index, definition] of rawDefinitions.entries()) {
    if (definition === null || typeof definition !== 'object') {
      return `entry at index ${index} must be an object`;
    }
    const candidate = definition as Partial<LocalPatchDefinition>;
    const id = candidate.id;
    const apply = candidate.apply;
    if (typeof id !== 'string') return `entry at index ${index} must have a string id`;
    if (typeof apply !== 'function') {
      return `entry ${describeLocalId(id)} must have an apply function`;
    }
    if (!LOCAL_PATCH_ID_PATTERN.test(id)) {
      return `invalid id at index ${index}: ${describeLocalId(id)}`;
    }
    if (ids.has(id)) return `duplicate id at index ${index}: ${describeLocalId(id)}`;
    ids.add(id);
    snapshot.push(Object.freeze({ id, apply }));
  }
  return Object.freeze(snapshot);
}

function applyLocalPatchSnapshot(
  source: string,
  patches: readonly LocalPatchDefinition[],
): ApplyPatchesOutcome {
  let content = source;
  const results: ApplyPatchesOutcome['results'] = [];

  for (const [index, patch] of patches.entries()) {
    const marker = `/*clodex-local:${patch.id}*/`;
    const existingMarkerCount = countOccurrences(content, marker);
    if (existingMarkerCount > 1) {
      return failedLocalTransaction(
        source,
        patches,
        results,
        index,
        'existing marker appears more than once',
      );
    }
    if (existingMarkerCount === 1) {
      results.push({
        status: 'SKIP',
        name: `LOCAL ${patch.id}`,
        extra: 'already patched',
      });
      continue;
    }

    let next: unknown;
    const reservedMarkers = reservedMarkerInventory(content);
    const localMarkers = localMarkerInventory(content);
    try {
      next = patch.apply(content, { marker });
    } catch (error) {
      return failedLocalTransaction(
        source,
        patches,
        results,
        index,
        describeLocalError(error),
      );
    }
    if (typeof next !== 'string') {
      return failedLocalTransaction(
        source,
        patches,
        results,
        index,
        `transform returned ${typeof next} instead of a string`,
      );
    }
    if (reservedMarkerInventory(next) !== reservedMarkers) {
      return failedLocalTransaction(
        source,
        patches,
        results,
        index,
        'transform changed reserved /*ccpatch: markers',
      );
    }
    const markerCount = countOccurrences(next, marker);
    if (markerCount !== 1) {
      return failedLocalTransaction(
        source,
        patches,
        results,
        index,
        markerCount === 0
          ? `transform did not emit ${marker}`
          : `transform must emit exactly one ${marker} marker`,
      );
    }
    if (localMarkerInventory(next.replace(marker, '')) !== localMarkers) {
      return failedLocalTransaction(
        source,
        patches,
        results,
        index,
        'transform changed another local patch marker',
      );
    }

    content = next;
    results.push({ status: 'OK', name: `LOCAL ${patch.id}` });
  }

  return { content, results };
}

export function applyLocalPatchSet(
  source: string,
  patches: unknown,
): ApplyPatchesOutcome {
  const snapshot = snapshotLocalPatchDefinitions(patches);
  if (typeof snapshot === 'string') return localPatchSetFailure(source, snapshot);
  return applyLocalPatchSnapshot(source, snapshot);
}

function localPatchSetFailure(source: string, extra: string): ApplyPatchesOutcome {
  return {
    content: source,
    results: [{ status: 'FAIL', name: 'LOCAL PATCH SET', extra }],
  };
}

export async function applyLocalPatches(
  source: string,
  localSource: LocalPatchSource,
): Promise<ApplyPatchesOutcome> {
  if (!localSource.enabled) return { content: source, results: [] };
  if (typeof localSource.error === 'string') {
    return localPatchSetFailure(source, localSource.error);
  }

  try {
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(localSource.source).toString('base64')}`
      + `#clodex-local-eval-${++localModuleEvaluationSequence}`;
    const loaded = await import(/* @vite-ignore */ moduleUrl) as { default?: unknown };
    const definitions = snapshotLocalPatchDefinitions(loaded.default);
    if (typeof definitions === 'string') {
      return localPatchSetFailure(source, definitions);
    }
    if (definitions.length === 0) {
      return {
        content: source,
        results: [{
          status: 'SKIP',
          name: 'LOCAL PATCH SET',
          extra: 'no patches exported',
        }],
      };
    }
    return applyLocalPatchSnapshot(source, definitions);
  } catch (error) {
    return localPatchSetFailure(
      source,
      describeLocalError(error),
    );
  }
}
