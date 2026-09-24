// Codex catalog compatibility is checked at discovery/projection, never per request.
import { CODEX_RESPONSES_LITE_VERSION } from './constants.js';
import type { CachedModel } from './registry/types.js';
import { printableServerText } from './registry/server-text.js';

// SemVer 2.0: numeric core, optional prerelease and build metadata. Numeric
// prerelease identifiers cannot have leading zeroes; build metadata is ignored.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$(?![\s\S])/;

export function readCodexClientVersion(value: unknown): string | undefined {
  return typeof value === 'string' && VERSION.test(value) ? value : undefined;
}

/** Semantic precedence, or undefined when either version is unknown/malformed. */
export function compareCodexClientVersions(a: string, b: string): number | undefined {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right) return undefined;
  for (let i = 1; i <= 3; i++) {
    const x = BigInt(left[i]!);
    const y = BigInt(right[i]!);
    if (x !== y) return x < y ? -1 : 1;
  }
  const preA = left[4];
  const preB = right[4];
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  const partsA = preA.split('.');
  const partsB = preB.split('.');
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i];
    const y = partsB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Check only Responses-Lite models: other requests do not send the pinned version.
 * The minimum itself is the persisted marker; no stale "blocked" flag to clear.
 */
export function requiresNewerCodexClient(
  model: Pick<CachedModel, 'minimalClientVersion' | 'useResponsesLite'>,
): boolean {
  if (!model.useResponsesLite) return false;
  const minimum = readCodexClientVersion(model.minimalClientVersion);
  return minimum !== undefined
    && compareCodexClientVersions(minimum, CODEX_RESPONSES_LITE_VERSION) === 1;
}

export function codexClientVersionWarning(models: CachedModel[]): string | undefined {
  const unavailable = models.filter(requiresNewerCodexClient);
  if (unavailable.length === 0) return undefined;
  const details = unavailable.map(model =>
    `${printableServerText(model.id)} (requires ${model.minimalClientVersion})`).join(', ');
  return `Hidden ChatGPT-plan models: ${details}. clodex sends Codex client version `
    + `${CODEX_RESPONSES_LITE_VERSION} for Responses-Lite; their catalog minimum exceeds this version. `
    + 'Update clodex to a release supporting their required version to use them.';
}
