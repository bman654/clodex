// The patch-site half of scripts/probe-patch-mechanism.mjs.
//
// WHY THIS EXISTS
// The probe used to check the CONTAINER only — shim, read, repack, restore — on the theory that
// the extracted JavaScript is near-identical on every platform, so one platform's `clodex patch`
// covers the anchors for all of them. Claude Code 2.1.238 disproved that: `PATCH 5: model picker
// options` matched on darwin-arm64, darwin-x64, linux-x64, linux-x64-musl and win32-x64, and did
// NOT match on linux-arm64, linux-arm64-musl or win32-arm64. The two Linux builds have containers
// and reported `fail`; win32-arm64 has no image, so it was a probe — and a probe exercised zero
// patch sites, so it reported a clean `pass` on a build clodex could not correctly patch.
//
// So the probe now applies the REAL transforms to the REAL bundle it just extracted. That needs
// no host of the target platform and no execution: the anchors are matched against a string.
//
// It is kept in its own module so `tests/probe-patch-sites.test.ts` can pin the expectations below
// against the actual transform set. Without that pin, adding or renaming a PATCH site would make
// every probe leg fail at 03:00 as if Claude Code had broken; with it, `pnpm test` reddens first.

import { applyClodexPatches, PatchApplyError } from '../src/patch-transforms.ts';

/**
 * One synthetic model that turns on every conditional patch site.
 *
 * Deliberately NOT the operator's real favorites: the probe must ask the same question of every
 * release regardless of whose machine it runs on, and half these sites are skipped entirely by a
 * config that omits `alias`, `context`, `display` or `effort`. `effort` lists all five native
 * levels because PATCH 8b and 8c are gated on `xhigh` and `max` being declared.
 *
 * The alias is long and unlovely on purpose — it has to be a name no Claude Code build already
 * contains, or PATCH 1/3/5 would report SKIP ("already patched") against a pristine bundle.
 */
export const PROBE_PATCH_CONFIG = Object.freeze({
  'clodex:probe:mechanism-canary': {
    alias: 'clodexprobecanary',
    context: 272000,
    display: 'clodex probe (synthetic model, not a real one)',
    effort: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'high' },
  },
});

/**
 * Every site PROBE_PATCH_CONFIG is expected to exercise, in the order applyClodexPatches runs them.
 *
 * A name that stops appearing is as serious as one that fails: a site nobody attempts is a site
 * nobody is watching. `tests/probe-patch-sites.test.ts` keeps this honest, and bumping
 * PATCH_TRANSFORMS_VERSION is the moment to revisit it.
 */
export const EXPECTED_PATCH_SITES = Object.freeze([
  'PATCH 1: Agent tool model enum',
  'PATCH 3: known-alias validator list',
  'PATCH 6: alias resolver switch',
  'PATCH 5: model picker options',
  'PATCH 4: Agent tool model description',
  'PATCH 7: per-model context window',
  'PATCH 8a: effort capability',
  'PATCH 8b: xhigh effort capability',
  'PATCH 8c: max effort capability',
  'PATCH 9: default effort',
  'PATCH 10: child network environment',
]);

const joinNames = (names) => names.join('; ');

/**
 * Apply every clodex patch site to one build's extracted bundle.
 *
 * @param {string} source the JavaScript tweakcc read out of the binary
 * @returns {{
 *   patchedSource: string | null,   the patched bundle, or null if the patch aborted
 *   sites: {name: string, status: string, extra?: string}[],
 *   failures: string[],             one ready-to-read reason per finding, empty when clean
 *   summary: {applied: number, skipped: number, failed: number, total: number},
 * }}
 */
export function checkPatchSites(source) {
  const sites = [];
  const failures = [];
  let patchedSource = null;
  let aborted = '';

  try {
    const outcome = applyClodexPatches(source, PROBE_PATCH_CONFIG);
    patchedSource = outcome.content;
    sites.push(...outcome.results);
  } catch (err) {
    aborted = err instanceof Error ? err.message : String(err);
    // A required site that fails throws, and the sites decided before it are on the error. They
    // are the most useful thing in the alert, so they are kept rather than discarded.
    if (err instanceof PatchApplyError) sites.push(...err.results);
    failures.push(`clodex patch aborted on this build's bundle: ${aborted}`);
  }

  const byStatus = (status) => sites.filter((s) => s.status === status).map((s) => s.name);
  const failed = sites.filter((s) => s.status === 'FAIL');
  const skipped = byStatus('SKIP');

  // Phrased exactly as the host and container legs phrase it, so one anchor that broke on four
  // builds collapses to a single line in the Slack alert instead of one line per leg.
  if (failed.length > 0) {
    failures.push(`patch sites FAILED: ${joinNames(failed.map((s) => s.name))}`);
  }

  // A SKIP means "already patched" or "nothing configured". Against a pristine release bundle
  // with the config above, neither is possible — so a SKIP is an anchor that matched something it
  // should not have, or a config that quietly stopped activating that site.
  if (skipped.length > 0) {
    failures.push(
      `patch sites did nothing on this build's bundle (reported SKIP against pristine bytes): ${joinNames(skipped)}`,
    );
  }

  const seen = new Set();
  const duplicates = [];
  for (const site of sites) {
    if (seen.has(site.name)) duplicates.push(site.name);
    seen.add(site.name);
  }
  if (duplicates.length > 0) {
    failures.push(`the same patch site was reported twice: ${joinNames([...new Set(duplicates)])}`);
  }

  const unexpected = [...seen].filter((name) => !EXPECTED_PATCH_SITES.includes(name));
  if (unexpected.length > 0) {
    failures.push(
      `the probe does not know these patch sites, so nothing vouches for them — clodex's transform set changed, the release did not: ${joinNames(unexpected)}`,
    );
  }

  // Only meaningful when the run got all the way through. After an abort the remaining sites are
  // missing BECAUSE of the abort, and listing them would bury the one line that says why.
  if (!aborted) {
    const missing = EXPECTED_PATCH_SITES.filter((name) => !seen.has(name));
    if (missing.length > 0) {
      failures.push(
        `these patch sites were never attempted, so this build is unchecked for them — clodex's transform set or the probe's synthetic config changed, the release did not: ${joinNames(missing)}`,
      );
    }
  }

  return {
    patchedSource,
    sites,
    failures,
    summary: {
      applied: byStatus('OK').length,
      skipped: skipped.length,
      failed: failed.length,
      total: sites.length,
    },
  };
}
