#!/usr/bin/env bash
#
# clodex-patch-canary-platforms.sh — the per-platform half of the canary.
#
# Sourced by clodex-patch-canary.sh (and, through it, by the self-test). It defines the platform
# matrix and the three ways a platform can be tested; the main script owns state, locking, Slack
# and the investigation.
#
# WHY THIS EXISTS
# `clodex patch` does two separable things, and they fail for different reasons:
#
#   the patch sites  match anchors in the extracted JavaScript. This was assumed to be
#                    near-identical on every platform (26,599,210 bytes on darwin vs 26,596,328 on
#                    linux for 2.1.233), so that one platform covered them all. 2.1.238 disproved
#                    it: `PATCH 5: model picker options` matched on darwin-arm64, darwin-x64,
#                    linux-x64, linux-x64-musl and win32-x64 and NOT on linux-arm64,
#                    linux-arm64-musl or win32-arm64. Every build's anchors are now checked
#                    against that build's own bundle.
#   the container    the entry-module shim, tweakcc's read, the repack, the restore and the
#                    Mach-O re-sign all depend on the executable format — and that is the half
#                    that broke. Every ELF build of Claude Code from 2.1.229 on was unpatchable
#                    across two clodex releases while macOS stayed green, because the canary only
#                    ever tested the host. An outside contributor reported it, not us.
#
# So every published platform is now tested, by the strongest means available for it:
#
#   host       the real `clodex patch` on this Mac — the authoritative "is it safe for me to
#              update" answer, and the only leg that patches AND then starts the binary here.
#   container  the real `clodex patch` inside a native-architecture Linux container. `clodex
#              patch` resolves the version by EXECUTING the binary, so a foreign binary cannot go
#              through the real command on the host — a container is the only way to run the whole
#              thing against ELF.
#   probe      scripts/probe-patch-mechanism.mjs from the clodex checkout under test: it applies
#              every clodex patch site to the bundle it extracts from THAT build, repacks what
#              those transforms produced, and runs the same shim/read/repack/restore cycle the
#              patcher runs. It never executes the binary, so it works from macOS against every
#              format, and it is the only coverage win32 and linux-x64 can have cheaply.
#              What it cannot show: that the patched binary starts, and that an anchor bound to
#              the function it was meant to bind to rather than a lookalike that also parses.
#
# A leg that cannot RUN (no Docker, a platform package that has not published yet, a container
# that could not install its dependencies) is an `error`, never a `fail`. Only evidence that the
# patch mechanism is broken may say Claude Code is unsafe — otherwise a Docker Desktop that
# happens to be quit would page you about a release that is perfectly fine.

# name | member inside the tarball | container image for a full-patch leg (empty: probe only)
#
# linux-x64 under emulation was deliberately left out: x64 and arm64 ELF behave identically here
# (both failed and both were fixed by the same change) and qemu is not worth the hourly cost. The
# probe still covers linux-x64's bytes; only the "does the patched binary run" half is arm64-only.
CANARY_PLATFORM_TABLE="\
darwin-arm64|claude|
darwin-x64|claude|
linux-x64|claude|
linux-arm64|claude|node:24-bookworm
linux-x64-musl|claude|
linux-arm64-musl|claude|node:24-alpine
win32-x64|claude.exe|
win32-arm64|claude.exe|"

# Ceiling on one container leg, image pull included. A wedged container would otherwise hold the
# canary's lock until CANARY_LOCK_STALE_MIN and stop every later run from testing anything.
CANARY_CONTAINER_TIMEOUT="${CANARY_CONTAINER_TIMEOUT:-1200}"
# Platform packages publish a few minutes apart. Until a release is this old, a platform that is
# missing means "not yet", and the whole run is abandoned unrecorded so the next hour retries.
# After it, the missing platform is reported and the rest of the matrix is still triaged.
CANARY_PLATFORM_LAG_MIN="${CANARY_PLATFORM_LAG_MIN:-120}"

# Every published platform, or just the ones --platforms named. An unknown name yields nothing and
# a non-zero status; the message belongs to validate_platforms, which runs in the parent shell.
platform_names() {
  local wanted="" name known
  if [ -z "${opt_platforms:-}" ]; then
    printf '%s\n' "$CANARY_PLATFORM_TABLE" | awk -F'|' 'NF{print $1}'
    return 0
  fi
  for name in $(printf '%s' "$opt_platforms" | tr ',' ' '); do
    known="$(printf '%s\n' "$CANARY_PLATFORM_TABLE" | awk -F'|' -v w="$name" '$1 == w {print $1}')"
    [ -n "$known" ] || return 1
    wanted="$wanted$known
"
  done
  printf '%s' "$wanted"
}

# Called from the main flow, NOT from a `$(...)`: `platform_names` is always read through a command
# substitution, where a `die` would print into the captured value and exit only the subshell — so a
# misspelt --platforms would leave the loop with nothing to iterate and the run would report a clean
# pass having tested nothing at all.
validate_platforms() {
  platform_names >/dev/null 2>&1 ||
    die "unknown platform in --platforms '$opt_platforms' — known: $(printf '%s\n' "$CANARY_PLATFORM_TABLE" | awk -F'|' 'NF{printf "%s ", $1}')"
  [ -n "$(platform_names)" ] || die "--platforms '$opt_platforms' selected no platforms"
}

platform_field() { # platform_field <name> <field-number>
  printf '%s\n' "$CANARY_PLATFORM_TABLE" |
    awk -F'|' -v want="$1" -v col="$2" '$1 == want {print $col}'
}

platform_member() { platform_field "$1" 2; }
platform_image()  { platform_field "$1" 3; }

host_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux)  os=linux ;;
    *) die "unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64)  arch=x64 ;;
    *) die "unsupported arch: $(uname -m)" ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

platform_pkg() { printf '%s-%s' "$CANARY_PKG" "$1"; }

# The source a container leg builds from. node_modules is excluded because the host's is macOS-only
# and dist because the container rebuilds it; everything else goes, including uncommitted work, so
# that the same command reproduces a leg against a fix that has not been committed yet.
archive_repo() { # archive_repo <repo> <out.tar>
  tar -cf "$2" -C "$1" --exclude=node_modules --exclude=.git --exclude=dist . \
    || die "cannot archive $1"
}

# Asked once per run: `docker info` talks to the daemon, and on a Mac with Docker Desktop quit it
# blocks for a while before failing.
#
# Deliberately silent. Its caller `platform_mode` is read through `$(...)`, so anything written to
# stdout here would be captured as part of the mode and every platform would resolve to a mode no
# `case` arm matches. run_platform_matrix warms it in the parent shell and logs the answer there.
DOCKER_READY=""
docker_ready() {
  if [ -z "$DOCKER_READY" ]; then
    if [ "${opt_container:-1}" -ne 1 ]; then
      DOCKER_READY=no
    elif command -v docker >/dev/null 2>&1 &&
         with_timeout 60 docker info >/dev/null 2>&1; then
      DOCKER_READY=yes
    else
      DOCKER_READY=no
    fi
  fi
  [ "$DOCKER_READY" = "yes" ]
}

# The strongest leg this run can actually run for a platform.
platform_mode() { # platform_mode <name>
  if [ "$1" = "$(host_platform)" ]; then printf 'host'; return 0; fi
  if [ -n "$(platform_image "$1")" ] && docker_ready; then printf 'container'; return 0; fi
  printf 'probe'
}

# ------------------------------------------------------------------ downloading

# Fetch one platform's binary into $WORK/<platform>/claude[.exe].
#   0  ready; PLATFORM_TARBALL_URL is set
#   3  the registry has no such version for this platform yet
#   anything else is fatal (die)
fetch_platform_binary() { # fetch_platform_binary <platform> <version>
  local platform="$1" version="$2" pkg dir member doc url integrity tarball actual
  pkg="$(platform_pkg "$platform")"
  dir="$WORK/$platform"
  member="$(platform_member "$platform")"
  mkdir -p "$dir"

  TRANSIENT_STEP="downloading the Claude Code $version release for $platform from the npm registry"
  doc="$(registry_doc "$pkg")" || die "cannot read registry doc for $pkg"
  # Without this, a garbled document makes every field below empty and the platform is filed as
  # "has not published yet" — which retries quietly forever instead of reporting a real fault.
  printf '%s' "$doc" | jq -e 'type == "object" and has("versions")' >/dev/null 2>&1 \
    || die "registry returned no usable document for $pkg"
  url="$(printf '%s' "$doc" | jq -r --arg v "$version" '.versions[$v].dist.tarball // empty')"
  integrity="$(printf '%s' "$doc" | jq -r --arg v "$version" '.versions[$v].dist.integrity // empty')"
  if [ -z "$url" ]; then
    TRANSIENT_STEP=""
    return 3
  fi

  tarball="$dir/claude.tgz"
  log "downloading $pkg@$version"
  curl -fsSL --retry 3 --retry-delay 5 --retry-all-errors --retry-connrefused --max-time 900 \
    -o "$tarball" "$url" || die "download failed for $pkg@$version"
  TRANSIENT_STEP=""

  # The binary is never executed for most platforms, so the registry's own hash is the only thing
  # standing between a truncated download and a "this release is broken" alert.
  if [ -n "$integrity" ] && [ "${integrity#sha512-}" != "$integrity" ]; then
    actual="sha512-$(openssl dgst -sha512 -binary "$tarball" | openssl base64 -A)"
    [ "$actual" = "$integrity" ] || die "$pkg@$version integrity mismatch (want $integrity, got $actual)"
  else
    log "WARN: registry published no sha512 integrity for $pkg@$version"
  fi

  tar xzf "$tarball" -C "$dir" --strip-components=1 "package/$member" \
    || die "$pkg@$version tarball has no package/$member"
  chmod +x "$dir/$member"
  rm -f "$tarball"

  # Refuse to go on unless what we are about to write to is inside the sandbox.
  case "$(cd "$dir" && pwd -P)/$member" in
    "$WORK"/*) : ;;
    *) die "$platform binary resolved outside the work dir — refusing to patch" ;;
  esac

  PLATFORM_TARBALL_URL="$url"
  PLATFORM_BINARY="$dir/$member"
  return 0
}

# --------------------------------------------------------------------- the legs
#
# Every leg leaves the same four globals behind, so one evaluator serves all three:
#   LEG_STATUS   pass | fail | error
#   LEG_REASONS  why it failed, one "- " line each (empty on pass)
#   LEG_SITES    per-site OK/SKIP/FAIL map as JSON ({} when the leg does not run patch sites)
#   LEG_MARKERS  ccpatch: markers found in the published binary, as JSON ([] likewise)
# plus LEG_DETAIL, a JSON object of whatever else is worth recording for that leg.

leg_reset() { LEG_STATUS=""; LEG_REASONS=""; LEG_SITES='{}'; LEG_MARKERS='[]'; LEG_DETAIL='{}'; }

# Shared by the host and container legs: turn a captured patch report into a verdict. Reads
# PATCH_OUT/PATCH_ERR/PATCH_EXIT, which both legs set.
evaluate_patch_leg() { # evaluate_patch_leg <platform> <binary>
  local platform="$1" binary="$2"
  SITES="$(parse_sites)"
  LEG_SITES="$SITES"
  REASONS=""
  evaluate_report
  # Reading OK from the report is not evidence the patched binary is usable, so the markers are
  # checked on the bytes that would ship. "Does it run" is the leg's own business: the host runs
  # it here, the container ran it before it handed the report back.
  if [ "$PATCH_EXIT" -eq 0 ] && [ -z "$FAILED_SITES" ]; then
    LEG_MARKERS="$(markers_in_binary "$binary")"
    log "$platform markers: $(printf '%s' "$LEG_MARKERS" | jq -r 'join(", ")')"
    printf '%s' "$LEG_MARKERS" | jq -e 'index("ccpatch:child-network-env")' >/dev/null 2>&1 ||
      add_reason "the published binary carries no ccpatch:child-network-env marker (PATCH 10 is required)"
  fi
  LEG_REASONS="$REASONS"
  [ -n "$REASONS" ] && LEG_STATUS=fail || LEG_STATUS=pass
  return 0
}

# ---- host: the real command, on this machine ---------------------------------------------------

run_leg_host() { # run_leg_host <platform> <version>
  local platform="$1" version="$2" binary="$PLATFORM_BINARY" probed probe_rc
  leg_reset

  # This is the one binary the canary can run before patching, which is the only way to be sure the
  # download is the release it claims to be.
  set +e
  probed="$(HOME="$WORK/home" DISABLE_AUTOUPDATER=1 "$binary" --version 2>&1)"
  probe_rc=$?
  set -e
  probed="${probed%%$'\n'*}"
  log "$platform binary reports: $probed (exit $probe_rc)"
  if [ "$probe_rc" -ne 0 ] || [ "${probed%% *}" != "$version" ]; then
    LEG_STATUS=error
    LEG_REASONS="- the downloaded $platform binary reports '$probed' (exit $probe_rc), not $version
"
    return 0
  fi

  PATCH_OUT="$WORK/$platform/patch.stdout"
  PATCH_ERR="$WORK/$platform/patch.stderr"
  set +e
  ( cd "$REPO_DIR" && \
    with_timeout "$CANARY_PATCH_TIMEOUT" \
    env -u CLODEX_TRACE -u FORCE_COLOR -u CLICOLOR_FORCE \
      HOME="$WORK/home" \
      CLODEX_HOME="$WORK/clodex-home" \
      TWEAKCC_CONFIG_DIR="$WORK/tweakcc" \
      TWEAKCC_CC_INSTALLATION_PATH="$binary" \
      DISABLE_AUTOUPDATER=1 \
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
      "$NODE_BIN_DIR/node" "$REPO_DIR/dist/cli.js" patch --trace \
  ) > "$PATCH_OUT" 2> "$PATCH_ERR"
  PATCH_EXIT=$?
  set -e
  if [ "$PATCH_EXIT" -eq 124 ] || [ "$PATCH_EXIT" -eq 137 ]; then
    log "$platform: clodex patch was killed after ${CANARY_PATCH_TIMEOUT}s (exit $PATCH_EXIT)"
  else
    log "$platform: clodex patch exited $PATCH_EXIT"
  fi

  evaluate_patch_leg "$platform" "$binary"

  # Only the host can answer this one directly.
  if [ "$LEG_STATUS" = "pass" ]; then
    set +e
    probed="$(HOME="$WORK/home" DISABLE_AUTOUPDATER=1 "$binary" --version 2>&1)"
    probe_rc=$?
    set -e
    probed="${probed%%$'\n'*}"
    log "$platform patched binary reports: $probed (exit $probe_rc)"
    REASONS="$LEG_REASONS"
    [ "$probe_rc" -eq 0 ] ||
      add_reason "the patched binary exited $probe_rc when asked for its version: '$probed'"
    [ "${probed%% *}" = "$version" ] ||
      add_reason "the patched binary reports '$probed' instead of $version (repack or signature broken)"
    LEG_REASONS="$REASONS"
    [ -n "$REASONS" ] && LEG_STATUS=fail
    LEG_DETAIL="$(jq -n --arg v "$probed" '{patchedVersion: $v}')"
  fi
  return 0
}

# ---- container: the real command, against a foreign ELF binary ---------------------------------

# Written once per run and shared by both container legs.
write_container_runner() {
  CONTAINER_RUNNER="$WORK/container-run.sh"
  # POSIX sh, not bash: node:24-alpine has no bash. Exit 90 means "this leg could not be run" —
  # an install or build problem inside the container is the canary's own infrastructure failing,
  # and must never be reported as Claude Code breaking clodex.
  cat > "$CONTAINER_RUNNER" <<'RUNNER'
set -eu
OUT=/w/out
mkdir -p /work && cd /work && tar xf /w/repo.tar

if ! corepack enable >/dev/null 2>&1; then
  npm install -g pnpm@"$(node -p 'require("/work/package.json").packageManager.split("@")[1]')" \
    > "$OUT/install.log" 2>&1 || { echo "CANARY-INFRA: no pnpm available"; exit 90; }
fi
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if ! pnpm install --frozen-lockfile >> "$OUT/install.log" 2>&1; then
  echo "CANARY-INFRA: pnpm install failed"; tail -30 "$OUT/install.log"; exit 90
fi
if ! pnpm build > "$OUT/build.log" 2>&1; then
  echo "CANARY-INFRA: pnpm build failed"; tail -30 "$OUT/build.log"; exit 90
fi

# Proof the download is the release it claims to be, and that this container can run it at all —
# a binary that will not start here would make every later result meaningless.
if ! HOME=/w/home DISABLE_AUTOUPDATER=1 /w/install/claude --version > "$OUT/pristine-version.txt" 2>&1; then
  echo "CANARY-INFRA: the pristine binary did not run in this container"
  cat "$OUT/pristine-version.txt"; exit 91
fi

# Written before the patch starts, so an outer timeout can tell "never got as far as patching"
# (infrastructure — an error) from "patch started and hung" (a release problem — a failure).
echo started > "$OUT/patch.started"
rc=0
env -u CLODEX_TRACE -u FORCE_COLOR -u CLICOLOR_FORCE \
  HOME=/w/home CLODEX_HOME=/w/clodex-home TWEAKCC_CONFIG_DIR=/w/tweakcc \
  TWEAKCC_CC_INSTALLATION_PATH=/w/install/claude DISABLE_AUTOUPDATER=1 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  node /work/dist/cli.js patch --trace > "$OUT/patch.stdout" 2> "$OUT/patch.stderr" || rc=$?
echo "$rc" > "$OUT/patch.exit"

vrc=0
HOME=/w/home DISABLE_AUTOUPDATER=1 /w/install/claude --version > "$OUT/patched-version.txt" 2>&1 || vrc=$?
echo "$vrc" > "$OUT/patched-version.exit"
echo "CANARY-DONE patch=$rc patched-version=$vrc"
RUNNER
}

run_leg_container() { # run_leg_container <platform> <version>
  local platform="$1" version="$2" image dir out rc arch probed vrc
  leg_reset
  image="$(platform_image "$platform")"
  dir="$WORK/$platform"
  out="$dir/out"
  mkdir -p "$out" "$dir/install" "$dir/home" "$dir/tweakcc" "$dir/clodex-home"
  # One bind mount is the container's whole world: it gets the binary, a copy of the seeded clodex
  # home, the repo tarball and the runner. Nothing on the host outside it is visible.
  mv "$PLATFORM_BINARY" "$dir/install/claude"
  PLATFORM_BINARY="$dir/install/claude"
  cp "$WORK/clodex-home/"* "$dir/clodex-home/" 2>/dev/null || true
  cp "$WORK/repo.tar" "$dir/repo.tar"
  cp "$CONTAINER_RUNNER" "$dir/container-run.sh"

  case "$platform" in
    *-x64|*-x64-musl) arch=linux/amd64 ;;
    *) arch=linux/arm64 ;;
  esac

  log "$platform: full clodex patch in $image ($arch)"
  set +e
  with_timeout "$CANARY_CONTAINER_TIMEOUT" \
    docker run --rm --platform "$arch" -v "$dir":/w \
      "$image" sh /w/container-run.sh > "$dir/docker.log" 2>&1
  rc=$?
  # Exit 90 is the runner saying it could not install or build clodex — nearly always a blip
  # reaching the npm registry from inside the container, and observed happening for real. One
  # retry costs ~40s and is the difference between covering Linux this run and waiting hours for
  # the partial-coverage retry.
  if [ "$rc" -eq 90 ]; then
    log "$platform: container could not install its dependencies — retrying once"
    with_timeout "$CANARY_CONTAINER_TIMEOUT" \
      docker run --rm --platform "$arch" -v "$dir":/w \
        "$image" sh /w/container-run.sh > "$dir/docker.log" 2>&1
    rc=$?
  fi
  set -e
  rm -f "$dir/repo.tar"

  if [ "$rc" -ne 0 ] && [ ! -s "$out/patch.exit" ]; then
    if [ -f "$out/patch.started" ]; then
      # `clodex patch` began and never returned. That IS a verdict about the release — a patch that
      # hangs is as broken as one that fails — and must not be filed as infrastructure.
      LEG_STATUS=fail
      LEG_REASONS="- \`clodex patch\` started on $platform and never finished (killed after ${CANARY_CONTAINER_TIMEOUT}s)
"
    else
      # Never a verdict: no `clodex patch` ran, so nothing was learned about this release.
      LEG_STATUS=error
      LEG_REASONS="- the $platform container could not be run (docker exit $rc): $(tail -3 "$dir/docker.log" 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g')
"
    fi
    return 0
  fi

  PATCH_OUT="$out/patch.stdout"
  PATCH_ERR="$out/patch.stderr"
  PATCH_EXIT="$(cat "$out/patch.exit" 2>/dev/null || echo 1)"
  log "$platform: clodex patch exited $PATCH_EXIT (in container)"
  evaluate_patch_leg "$platform" "$PLATFORM_BINARY"

  if [ "$LEG_STATUS" = "pass" ]; then
    probed="$(head -1 "$out/patched-version.txt" 2>/dev/null || echo '')"
    vrc="$(cat "$out/patched-version.exit" 2>/dev/null || echo 1)"
    REASONS="$LEG_REASONS"
    [ "$vrc" -eq 0 ] ||
      add_reason "the patched $platform binary exited $vrc when asked for its version: '$probed'"
    [ "${probed%% *}" = "$version" ] ||
      add_reason "the patched $platform binary reports '$probed' instead of $version (repack or signature broken)"
    LEG_REASONS="$REASONS"
    [ -n "$REASONS" ] && LEG_STATUS=fail
    LEG_DETAIL="$(jq -n --arg v "$probed" --arg i "$image" --arg a "$arch" \
      '{patchedVersion: $v, image: $i, dockerPlatform: $a}')"
  fi
  return 0
}

# ---- probe: the bundle patch and the binary handling, without execution ------------------------

# The most informative line of a failed probe's stderr. `tail -3` of a Node crash is the tail of
# its stack trace — "}", blank, "Node.js v24.14.1" — which is exactly the useless thing a Slack
# alert must not be made of.
probe_error_summary() { # probe_error_summary <stderr-file>
  local summary
  summary="$( { grep -a -m2 -E '^[A-Za-z]*(Error|Exception)|Cannot find|ENOENT|EACCES|code: ' "$1" \
                 2>/dev/null || true; } | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-300)"
  [ -n "$summary" ] || summary="$( { head -3 "$1" 2>/dev/null || true; } | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-300)"
  printf '%s' "${summary:-no output}"
}

run_leg_probe() { # run_leg_probe <platform> <version>
  local platform="$1" version="$2" json rc
  leg_reset
  json="$WORK/$platform/probe.json"
  if [ ! -f "$REPO_DIR/scripts/probe-patch-mechanism.mjs" ]; then
    LEG_STATUS=error
    LEG_REASONS="- the clodex build under test ($MAIN_SHA on $CANARY_BRANCH) has no scripts/probe-patch-mechanism.mjs, so $platform could not be checked at all
"
    return 0
  fi
  # Fenced like the other two legs. The probe redirects TWEAKCC_CONFIG_DIR itself only when it is
  # UNSET, so an operator with it exported in their shell would otherwise have the probe write
  # into their real ~/.tweakcc — the one thing every leg here promises never to touch.
  mkdir -p "$WORK/$platform/tweakcc"
  set +e
  ( cd "$REPO_DIR" && with_timeout "$CANARY_PATCH_TIMEOUT" \
      env -u CLODEX_TRACE -u FORCE_COLOR -u CLICOLOR_FORCE \
        HOME="$WORK/home" \
        CLODEX_HOME="$WORK/clodex-home" \
        TWEAKCC_CONFIG_DIR="$WORK/$platform/tweakcc" \
        "$NODE_BIN_DIR/node" "$REPO_DIR/scripts/probe-patch-mechanism.mjs" "$PLATFORM_BINARY" \
          --label "$platform" --expect-version "$version" --json \
          --scratch "$WORK/$platform/probe-scratch" ) \
    > "$json" 2> "$WORK/$platform/probe.stderr"
  rc=$?
  set -e
  rm -rf "$WORK/$platform/probe-scratch"

  evaluate_probe_leg "$platform" "$json" "$rc" "$WORK/$platform/probe.stderr"
  return 0
}

# Turn a captured probe.json into a verdict. Split out from the leg above — like evaluate_report —
# so the self-test can drive it against hand-written results without downloading a 300 MB binary.
evaluate_probe_leg() { # evaluate_probe_leg <platform> <probe.json> <exit-code> <stderr-file>
  local platform="$1" json="$2" rc="$3" stderr="$4" failed_sites

  # Both halves matter: `jq -e .` alone accepts any valid JSON, and the `.checks[]` extraction
  # below then dies with "Cannot iterate over null" — under errexit that kills the whole canary
  # before any verdict is recorded, so one schema change would leave releases untriaged.
  if ! jq -e 'type == "object" and (.checks | type) == "array" and has("verdict")' \
       "$json" >/dev/null 2>&1; then
    # No JSON at all means the probe itself did not run (a missing script on an older origin/main,
    # a Node too old for the .ts import). That is the canary's problem, not the release's.
    LEG_STATUS=error
    LEG_REASONS="- the $platform probe produced no usable result (exit $rc): $(probe_error_summary "$stderr")
"
    return 0
  fi

  # A probe that reports no patch sites is the OLD probe — the one that checked executable-format
  # handling only and reported a clean pass on win32-arm64 while `PATCH 5: model picker options`
  # had stopped matching there. Its verdict says nothing about the anchors, so it may not be
  # recorded as if it did. An `error`, not a `fail`: the clodex build under test is behind, the
  # release is not implicated — and an error is already enough to withhold the green tick.
  if ! jq -e '(.patchSites | type) == "array" and (.patchSites | length) > 0' \
       "$json" >/dev/null 2>&1; then
    LEG_STATUS=error
    LEG_REASONS="- the $platform probe reported no patch-site results, so only this build's executable format was checked and its patch anchors were not — the clodex build under test (${MAIN_SHA:-unknown} on $CANARY_BRANCH) predates per-build patch-site checking
"
    return 0
  fi

  LEG_DETAIL="$(jq -c '{format, entryState, shimUsed, pristineSize, publishedSize, growth,
                        detectedVersion, sourceBytes, durationMs, patchSites: (.patchSiteSummary // null)}' "$json")"
  # Both sets of names, in one map, because both are checks that must keep holding: the mechanism
  # checks are what the baseline comparison has always watched, and the patch sites are what this
  # leg could not see at all before. The two name spaces do not overlap.
  # `// []` even though the guard above already refused a result without patchSites: reached with
  # a null here, `.patchSites[]` dies with "Cannot iterate over null" and errexit takes the whole
  # canary down before ANY platform's verdict is recorded — one schema change, every release left
  # untriaged. The guard decides the verdict; this keeps a regression in the guard survivable.
  LEG_SITES="$(jq -c '([.checks[] | {key: .name, value: (if .ok then "OK" else "FAIL" end)}] | from_entries)
                      + ([(.patchSites // [])[] | {key: .name, value: .status}] | from_entries)' "$json")"
  if [ "$(jq -r '.verdict' "$json")" = "pass" ]; then
    LEG_STATUS=pass
  else
    LEG_STATUS=fail
    LEG_REASONS="$(jq -r '(.reasons // []) | map("- " + .) | join("\n")' "$json")
"
  fi
  failed_sites="$(jq -r '[(.patchSites // [])[] | select(.status == "FAIL") | .name] | join("; ")' "$json")"
  log "$platform probe: $(jq -r '.verdict' "$json") ($(jq -r '(.durationMs/1000|floor)' "$json")s, $(jq -r '.format' "$json"), $(jq -r '.patchSiteSummary.applied // 0') patch sites applied${failed_sites:+, FAILED: $failed_sites})"
  return 0
}

# --------------------------------------------------------------- the whole matrix

# Run every platform and leave one JSON object per line in $WORK/matrix.jsonl.
#
# A platform whose package has not published yet returns 3 from fetch_platform_binary. Until the
# release is CANARY_PLATFORM_LAG_MIN old that means "come back later" for the WHOLE run, because
# recording a verdict now would mean that platform is never tested for this version at all.
run_platform_matrix() { # run_platform_matrix <version> <first-seen-epoch>
  local version="$1" first_seen="$2" platform mode rc age_min binary downgraded
  MATRIX="$WORK/matrix.jsonl"
  : > "$MATRIX"
  # Warm the Docker answer HERE, in the parent shell, so the memo is shared by every
  # `$(platform_mode ...)` subshell below and the daemon is asked exactly once.
  docker_ready || true
  log "docker available: $DOCKER_READY"
  write_container_runner
  # The working tree, not `git archive HEAD`: the repro script reuses this exact command against
  # an investigator's worktree, where the fix under test is usually still uncommitted.
  archive_repo "$REPO_DIR" "$WORK/repo.tar"

  age_min=$(( ( $(now_epoch) - first_seen ) / 60 ))

  for platform in $(platform_names); do
    mode="$(platform_mode "$platform")"
    PLATFORM_BINARY=""
    PLATFORM_TARBALL_URL=""

    set +e
    fetch_platform_binary "$platform" "$version"
    rc=$?
    set -e
    if [ "$rc" -eq 3 ]; then
      if [ "$age_min" -lt "$CANARY_PLATFORM_LAG_MIN" ] &&
         [ "$(jq -s -r 'map(select(.status == "fail")) | length' "$MATRIX")" -eq 0 ]; then
        log "$(platform_pkg "$platform") has no $version yet (${age_min}m after first sighting) — abandoning this run, the next one retries"
        PLATFORMS_PENDING=1
        return 0
      fi
      # Abandoning is only safe while nothing has been proved. Once a platform has actually failed,
      # discarding the run discards that evidence — and if a newer release becomes `latest` before
      # the retry, this version is superseded and its breakage is never recorded at all. So report
      # what was found and mark the unpublished platform as untested.
      log "WARN: $(platform_pkg "$platform") still has no $version ${age_min}m after first sighting — reporting it and going on"
      leg_reset
      LEG_STATUS=error
      LEG_REASONS="- $(platform_pkg "$platform") has still not published $version ${age_min} minutes after the other platforms did, so it was not tested
"
      mode=none
    else
      case "$mode" in
        host)      run_leg_host      "$platform" "$version" ;;
        container) run_leg_container "$platform" "$version" ;;
        *)         run_leg_probe     "$platform" "$version" ;;
      esac
    fi

    # A platform that should have had a full containerised patch but got the probe instead was
    # tested less thoroughly than the matrix claims, and that has to be visible: silently thinner
    # coverage reported as a pass is the exact shape of the failure this whole change is about.
    downgraded=false
    if [ "$mode" = "probe" ] && [ -n "$(platform_image "$platform")" ]; then downgraded=true; fi

    binary="${PLATFORM_BINARY:-}"
    jq -n -c --arg p "$platform" --arg m "$mode" --arg s "$LEG_STATUS" --arg r "$LEG_REASONS" \
            --arg b "$binary" --arg u "${PLATFORM_TARBALL_URL:-}" --argjson d "$downgraded" \
            --argjson sites "$LEG_SITES" --argjson markers "$LEG_MARKERS" \
            --argjson detail "$LEG_DETAIL" \
      '{platform: $p, mode: $m, status: $s, reasons: $r, binary: $b, tarball: $u,
        downgraded: $d, sites: $sites, markers: $markers, detail: $detail}' >> "$MATRIX"
    log "$platform [$mode]: $LEG_STATUS"

    # Each of these is ~300 MB and there are eight. A leg that came out clean has nothing left to
    # investigate, so its binary goes immediately; a failing one is kept as evidence.
    if [ "$LEG_STATUS" = "pass" ]; then
      [ -z "$binary" ] || [ ! -f "$binary" ] || rm -f "$binary"
      # The pristine backup `clodex patch` snapshots is another ~281 MB, and it is only evidence
      # for a leg that failed. Leaving it behind for passing legs is what made a preserved sandbox
      # cost gigabytes rather than the "binary plus backup" the comment in the main script promises.
      rm -f "$WORK/$platform/tweakcc/"*.orig "$WORK/$platform/tweakcc/native-binary.backup" 2>/dev/null || true
      if [ "$mode" = "host" ]; then
        rm -f "$WORK/tweakcc/"*.orig "$WORK/tweakcc/native-binary.backup" 2>/dev/null || true
      fi
    fi
  done
  return 0
}

# ------------------------------------------------------------ reading the matrix

matrix_platforms() { # matrix_platforms <status> — space-separated names
  jq -r -s --arg s "$1" 'map(select(.status == $s) | .platform) | join(" ")' "$MATRIX"
}

matrix_count() { jq -r -s --arg s "$1" 'map(select(.status == $s)) | length' "$MATRIX"; }
matrix_total() { jq -r -s 'length' "$MATRIX"; }

matrix_status_of() { # matrix_status_of <platform>
  jq -r -s --arg p "$1" 'map(select(.platform == $p) | .status) | last // "none"' "$MATRIX"
}

# Every distinct failure reason, with the platforms that reported it. Four ELF platforms failing
# for one reason is one line, not four — the Slack alert has to be readable on a phone.
matrix_reason_groups() {
  jq -r -s '
    map(select(.status == "fail"))
    | map({platform, reasons: (.reasons | split("\n") | map(select(length > 0)))})
    | map(.reasons[] as $r | {platform, r: $r})
    | group_by(.r)
    | map("\(.[0].r) [\(map(.platform) | join(", "))]")
    | join("\n")' "$MATRIX"
}

# The same, for legs that could not be run at all.
matrix_error_notes() {
  jq -r -s '
    map(select(.status == "error"))
    | map(.reasons | split("\n") | map(select(length > 0))[])
    | join("\n")' "$MATRIX"
}

# Platforms that should have had a full containerised patch and got the cheaper probe instead.
matrix_downgrade_notes() {
  local why="Docker was not available"
  [ "${opt_container:-1}" -eq 1 ] || why="--no-container was passed"
  jq -r -s --arg why "$why" '
    map(select(.downgraded == true) | .platform) as $d
    | if ($d | length) == 0 then ""
      else "- \($why), so \($d | join(" and ")) got the bundle-patch + binary-handling probe instead of a full `clodex patch` in a container. The patch sites were checked against those builds bundles, but NO patched Linux binary was started this run."
      end' "$MATRIX"
}

# One line per platform: what was tested and how. This is what tells you at a glance that the
# Linux legs really ran and were not silently downgraded to a probe.
matrix_coverage_line() {
  jq -r -s '
    def sym: if .status == "pass" and .downgraded then ":warning:"
             elif .status == "pass" then ":white_check_mark:"
             elif .status == "fail" then ":x:" else ":grey_question:" end;
    def how: if .status != "pass" and .status != "fail" then "NOT TESTED"
             elif .mode == "host" then "full patch, this Mac"
             elif .mode == "container" then "full patch in \(.detail.image // "a container")"
             elif .mode == "probe" and .downgraded then
               "bundle patch + binary handling — no container, so the patched binary was never started here"
             elif .mode == "probe" then
               "bundle patch + binary handling; native execution not checked"
             else "not tested" end;
    map("\(sym) *\(.platform)* — \(how)") | join("\n")' "$MATRIX"
}

# Only the non-passing rows, plus a tail naming the clean ones. The full eight-line list pushes
# the failure reasons below the fold on a phone.
matrix_coverage_brief() {
  jq -r -s '
    def sym: if .status == "fail" then ":x:" else ":grey_question:" end;
    def how: if .mode == "host" then "full patch, this Mac"
             elif .mode == "container" then "full patch in \(.detail.image // "a container")"
             elif .mode == "probe" then "bundle patch + binary handling"
             else "not tested" end;
    (map(select(.status != "pass")) | map("\(sym) *\(.platform)* — \(how)")) as $bad
    | (map(select(.status == "pass") | .platform)) as $good
    | ($bad + (if ($good | length) > 0
               then [":white_check_mark: \($good | length) clean: \($good | join(", "))"] else [] end))
    | join("\n")' "$MATRIX"
}

# Is this run entitled to the green tick? "Nothing proved it broken" is not the same as "it is
# safe", and the incident this canary exists because of was a coverage hole reported as a clean
# pass. Any leg that could not run, any Linux leg downgraded to a probe, or a host leg that did not
# itself pass, all mean the same thing: say so instead of blessing the release.
#   0  full coverage
#   1  something was not established
coverage_is_complete() { # coverage_is_complete <host-platform>
  # Not "did the platforms in the matrix pass" but "was every published platform in it". A
  # --platforms subset run passes every other test in here while having tested almost nothing.
  [ "$(matrix_total)" -eq "$(printf '%s\n' "$CANARY_PLATFORM_TABLE" | awk -F'|' 'NF' | wc -l | tr -d ' ')" ] || return 1
  [ "$(matrix_status_of "$1")" = "pass" ] || return 1
  [ "$(matrix_count error)" -eq 0 ] || return 1
  [ -z "$(jq -s -r 'map(select(.downgraded == true) | .platform) | join(", ")' "$MATRIX")" ] || return 1
  return 0
}

matrix_mode_of() { # matrix_mode_of <platform>
  jq -r -s --arg p "$1" 'map(select(.platform == $p) | .mode) | last // "none"' "$MATRIX"
}

# How many patch sites actually applied, as opposed to how many were reported on: a SKIP is a site
# that did nothing, and counting it as applied is how "all 11 applied" stays true while a feature
# is quietly off.
matrix_applied_sites() { # matrix_applied_sites <platform>
  jq -r -s --arg p "$1" \
    'map(select(.platform == $p) | .sites) | last // {}
     | [to_entries[] | select(.value == "OK")] | length' "$MATRIX"
}
matrix_total_sites() { # matrix_total_sites <platform>
  jq -r -s --arg p "$1" 'map(select(.platform == $p) | .sites | length) | last // 0' "$MATRIX"
}
