// The patch-site half of the release canary's probe (scripts/probe-patch-sites.mjs).
//
// The canary runs that probe against a real Claude Code build for every platform that has no
// container image — win32-x64, win32-arm64, linux-x64, linux-x64-musl, darwin-x64. It used to
// check executable-format handling only, so it reported win32-arm64 as a clean pass on Claude
// Code 2.1.238 while `PATCH 5: model picker options` no longer matched that build's bundle at
// all. It now applies the real transforms, which means two new ways for it to be wrong:
//
//   - it stops noticing a broken anchor, and the blind spot is back;
//   - it starts failing on a clodex change rather than a Claude Code change, and pages a human at
//     03:00 for every platform at once.
//
// Both are caught here instead of in production. Bump PATCH_TRANSFORMS_VERSION and this file
// reddens until the probe's expectations are brought along with the transform set.

import { describe, it, expect } from 'vitest';
import {
  checkPatchSites,
  EXPECTED_PATCH_SITES,
  PROBE_PATCH_CONFIG,
} from '../scripts/probe-patch-sites.mjs';
import { applyClodexPatches } from '../src/patch-transforms.js';
import { CLAUDE_FIXTURE } from './fixtures/claude-bundle.js';

describe('the canary probe against a healthy bundle', () => {
  it('exercises every patch site the transform set has, and no other', () => {
    const { sites, failures } = checkPatchSites(CLAUDE_FIXTURE);

    // Exact list, in order. A site the probe does not know about is a site nothing vouches for on
    // five of the eight published builds, and a name drifting is as invisible as a name removed.
    expect(sites.map((s) => s.name)).toEqual([...EXPECTED_PATCH_SITES]);
    expect(failures).toEqual([]);
  });

  it('leaves nothing SKIPped, because a skip means a site did no work', () => {
    const { sites, summary } = checkPatchSites(CLAUDE_FIXTURE);

    expect(sites.every((s) => s.status === 'OK')).toBe(true);
    expect(summary).toEqual({
      applied: EXPECTED_PATCH_SITES.length,
      skipped: 0,
      failed: 0,
      total: EXPECTED_PATCH_SITES.length,
    });
  });

  it('returns the patched bundle, which is what the probe publishes into the binary', () => {
    const { patchedSource } = checkPatchSites(CLAUDE_FIXTURE);

    // Publishing pristine bytes would leave the thing users actually receive — clodex's emitted
    // patch surviving a PE/ELF/Mach-O round trip — unproven by the probe's byte-for-byte readback.
    expect(patchedSource).not.toBeNull();
    expect(patchedSource!.length).toBeGreaterThan(CLAUDE_FIXTURE.length);
    expect(patchedSource).toContain('clodexprobecanary');
  });

  it('agrees with applyClodexPatches called directly, so it adds no interpretation of its own', () => {
    const direct = applyClodexPatches(CLAUDE_FIXTURE, PROBE_PATCH_CONFIG);

    expect(checkPatchSites(CLAUDE_FIXTURE).patchedSource).toBe(direct.content);
  });
});

describe('the canary probe against a bundle whose anchors drifted', () => {
  // A drift the PATCH 5 anchor does NOT tolerate, which is what the probe has to catch.
  //
  // This deliberately does not reproduce the Claude Code 2.1.238 break any more. That break was an
  // identifier rename (`r` to `n` in the picker helper) and the anchor now wildcards identifiers and
  // ties repeats with back-references specifically so a rename cannot break it — reproducing it here
  // would assert the opposite of the behaviour we ship. Braces around the loop body are used instead:
  // a plausible minifier variation that the anchor genuinely misses, so PATCH 5 reports `anchor not
  // found` while the whole-bundle model-selection count still resolves to exactly one.
  const PICKER_ANCHOR = 'function opts(e,t,r){let n=cur(),o=(n==="opus"||n==="sonnet")&&n!==r?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}';
  const PICKER_DRIFTED = 'function opts(e,t,r){let n=cur(),o=(n==="opus"||n==="sonnet")&&n!==r?[n,r]:[r];for(let i of o){Dlh(e,i,t);}return e}';

  it('fails when the model-picker anchor no longer matches', () => {
    expect(CLAUDE_FIXTURE, 'fixture drifted from the shape this test mutates')
      .toContain(PICKER_ANCHOR);
    const drifted = CLAUDE_FIXTURE.replace(PICKER_ANCHOR, PICKER_DRIFTED);

    const { sites, failures } = checkPatchSites(drifted);

    expect(sites.find((s) => s.name === 'PATCH 5: model picker options')?.status).toBe('FAIL');
    // Worded exactly as the host and container legs word it, so one anchor broken on three builds
    // collapses to a single line in the alert rather than one line per build.
    expect(failures).toContain('patch sites FAILED: PATCH 5: model picker options');
  });

  it('still returns a patched bundle when an OPTIONAL site fails, so the repack is measured too', () => {
    const drifted = CLAUDE_FIXTURE.replace(PICKER_ANCHOR, PICKER_DRIFTED);

    // PATCH 5 is not `required`, so applyClodexPatches publishes anyway. The probe must report the
    // miss AND go on to exercise the executable-format half against the bytes it produced.
    expect(checkPatchSites(drifted).patchedSource).not.toBeNull();
  });

  it('reports the abort, and no patched bundle, when a REQUIRED site fails', () => {
    const drifted = CLAUDE_FIXTURE.replace(
      '.enum(["sonnet","opus","haiku","fable"])',
      '.enum(["sonnet","opus","haiku","fable"]) /* moved */',
    );

    const { patchedSource, failures } = checkPatchSites(drifted);

    // applyClodexPatches throws on a required miss, so there are no patched bytes to repack. The
    // probe must still say so rather than quietly repacking pristine ones and calling that a pass.
    expect(patchedSource).toBeNull();
    expect(failures[0]).toContain("clodex patch aborted on this build's bundle");
    // The sites after the abort are unattempted BECAUSE of it. Listing them as findings of their
    // own would bury the single line that says why.
    expect(failures.join('\n')).not.toContain('were never attempted');
  });

  it('refuses a bundle that already carries a clodex patch, and names all three symptoms', () => {
    // Release bytes are pristine, so this cannot come from Claude Code — it is the probe pointed
    // at something it should not be, or a config that stopped activating a site. It exercises the
    // three name-level rules at once: a SKIP, the `(refresh)` variants the probe does not expect,
    // and the plain names that then go unattempted.
    const alreadyPatched = applyClodexPatches(CLAUDE_FIXTURE, PROBE_PATCH_CONFIG).content;

    const { failures, summary } = checkPatchSites(alreadyPatched);

    expect(summary.skipped).toBe(EXPECTED_PATCH_SITES.length);
    // Ordered: the cause first, its consequences after. An operator reads line one.
    expect(failures[0]).toContain('reported SKIP against pristine bytes');
    expect(failures[1]).toContain('the probe does not know these patch sites');
    expect(failures[2]).toContain('were never attempted');
    // And the wording sends the reader at clodex, not at a night of diffing Claude Code bundles.
    expect(failures[2]).toContain("clodex's transform set");
  });
});
