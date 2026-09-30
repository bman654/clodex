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

/** Why a Responses-Lite model cannot use the bundled request version. */
type CodexClientRequirement =
  /** The catalog's published minimum exceeds the request version. */
  | { kind: 'minimum'; version: string }
  /** The catalog omitted the model at this version, which the request version does not exceed. */
  | { kind: 'withheld'; version: string };

function atLeast(version: string, floor: string): boolean {
  const order = compareCodexClientVersions(version, floor);
  return order === 0 || order === 1;
}

/** Check only Responses-Lite models: other requests do not send the pinned version.
 * The recorded versions themselves are the persisted markers; no stale "blocked" flag to
 * clear. A withheld marker applies only while the pin is at or below it, so a release
 * with a newer pin offers the model again without a refresh. When both apply, report
 * the stronger bound.
 */
function codexClientRequirement(
  model: Pick<CachedModel, 'minimalClientVersion' | 'withheldAtClientVersion' | 'useResponsesLite'>,
): CodexClientRequirement | undefined {
  if (!model.useResponsesLite) return undefined;
  const minimum = readCodexClientVersion(model.minimalClientVersion);
  const withheldAt = readCodexClientVersion(model.withheldAtClientVersion);
  const blockingMinimum = minimum !== undefined
    && compareCodexClientVersions(minimum, CODEX_RESPONSES_LITE_VERSION) === 1 ? minimum : undefined;
  const blockingWithheld = withheldAt !== undefined && atLeast(withheldAt, CODEX_RESPONSES_LITE_VERSION)
    ? withheldAt : undefined;
  if (blockingMinimum !== undefined
    && (blockingWithheld === undefined || compareCodexClientVersions(blockingMinimum, blockingWithheld) === 1)) {
    return { kind: 'minimum', version: blockingMinimum };
  }
  return blockingWithheld === undefined ? undefined : { kind: 'withheld', version: blockingWithheld };
}

export function requiresNewerCodexClient(
  model: Pick<CachedModel, 'minimalClientVersion' | 'withheldAtClientVersion' | 'useResponsesLite'>,
): boolean {
  return codexClientRequirement(model) !== undefined;
}

export function codexClientVersionWarning(models: CachedModel[]): string | undefined {
  const unavailable = models.flatMap(model => {
    const requirement = codexClientRequirement(model);
    return requirement ? [{ id: model.id, requirement }] : [];
  });
  if (unavailable.length === 0) return undefined;
  const details = unavailable.map(({ id, requirement }) => `${printableServerText(id)} (requires ${
    requirement.kind === 'minimum' ? requirement.version : `a version newer than ${requirement.version}`
  })`).join(', ');
  const reason = unavailable.every(({ requirement }) => requirement.kind === 'minimum')
    ? 'their catalog minimum exceeds this version'
    : 'the ChatGPT catalog does not offer them to this version';
  return `Hidden ChatGPT-plan models: ${details}. clodex sends Codex client version `
    + `${CODEX_RESPONSES_LITE_VERSION} for Responses-Lite; ${reason}. `
    + 'Update clodex to a release supporting their required version to use them.';
}
