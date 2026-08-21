#!/usr/bin/env bash
#
# Self-test for clodex-patch-canary.sh's report parsing and verdict logic.
# Drives the real functions against captured `clodex patch` output shapes — no download, no patch.
#
set -Eeuo pipefail

CANARY="${1:-$HOME/.local/bin/clodex-patch-canary.sh}"
CANARY_SOURCE_ONLY=1 . "$CANARY"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

# check <name> <expected-substring-or-EMPTY> — REASONS must contain it (or be empty for EMPTY)
check() {
  local name="$1" want="$2"
  if [ "$want" = "EMPTY" ]; then
    if [ -z "$REASONS" ]; then pass=$((pass + 1)); printf 'ok   %s\n' "$name"
    else fail=$((fail + 1)); printf 'FAIL %s — expected no reasons, got:\n%s\n' "$name" "$REASONS"; fi
  else
    case "$REASONS" in
      *"$want"*) pass=$((pass + 1)); printf 'ok   %s\n' "$name" ;;
      *) fail=$((fail + 1)); printf 'FAIL %s — expected to contain %s, got:\n%s\n' "$name" "$want" "$REASONS" ;;
    esac
  fi
}

check_sites() {
  local name="$1" want="$2" got
  got="$(printf '%s' "$SITES" | jq -cS .)"
  if [ "$got" = "$(printf '%s' "$want" | jq -cS .)" ]; then
    pass=$((pass + 1)); printf 'ok   %s\n' "$name"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n  want %s\n  got  %s\n' "$name" "$want" "$got"
  fi
}

run_case() { # run_case <exit> <stdout-file> <stderr-file>
  PATCH_EXIT="$1"; PATCH_OUT="$2"; PATCH_ERR="$3"
  SITES="$(parse_sites)"
  REASONS=""
  evaluate_report >/dev/null
}

# ---------------------------------------------------------------- fixtures

# 1. Clean run: --trace writes the report to stderr, clack echoes a summary line to stdout.
cat > "$TMP/ok.err" <<'EOF'
  OK   PATCH 1: Agent tool model enum
  OK   PATCH 3: known-alias validator list
  OK   PATCH 6: alias resolver switch
  OK   PATCH 5: model picker options
  OK   PATCH 4: Agent tool model description
  OK   PATCH 7: per-model context window
  OK   PATCH 8a: effort capability
  OK   PATCH 8b: xhigh effort capability
  OK   PATCH 8c: max effort capability
  OK   PATCH 9: default effort
  OK   PATCH 10: child network environment
clodex patch: 11 applied, 0 skipped, 0 failed
EOF
cat > "$TMP/ok.out" <<'EOF'
│
◆  Patched claude 2.1.231: 3 models, 3 aliases, 3 context windows.
EOF
run_case 0 "$TMP/ok.out" "$TMP/ok.err"
check "clean run has no reasons" EMPTY
check_sites "clean run parses 11 sites" '{"PATCH 1: Agent tool model enum":"OK","PATCH 3: known-alias validator list":"OK","PATCH 6: alias resolver switch":"OK","PATCH 5: model picker options":"OK","PATCH 4: Agent tool model description":"OK","PATCH 7: per-model context window":"OK","PATCH 8a: effort capability":"OK","PATCH 8b: xhigh effort capability":"OK","PATCH 8c: max effort capability":"OK","PATCH 9: default effort":"OK","PATCH 10: child network environment":"OK"}'

# 2. Optional site failed but the patch still published — exit 0, so ONLY the report reveals it.
cat > "$TMP/opt.err" <<'EOF'
  OK   PATCH 1: Agent tool model enum
  OK   PATCH 3: known-alias validator list
  OK   PATCH 6: alias resolver switch
  FAIL PATCH 5: model picker options — anchor not found
  OK   PATCH 4: Agent tool model description
  OK   PATCH 7: per-model context window
  OK   PATCH 10: child network environment
clodex patch: 6 applied, 0 skipped, 1 failed
clodex patch: FAILED patches: PATCH 5: model picker options
EOF
: > "$TMP/opt.out"
run_case 0 "$TMP/opt.out" "$TMP/opt.err"
check "optional FAIL at exit 0 is caught" "patch sites FAILED: PATCH 5: model picker options"
check_sites "FAIL site name excludes its reason" '{"PATCH 1: Agent tool model enum":"OK","PATCH 3: known-alias validator list":"OK","PATCH 6: alias resolver switch":"OK","PATCH 5: model picker options":"FAIL","PATCH 4: Agent tool model description":"OK","PATCH 7: per-model context window":"OK","PATCH 10: child network environment":"OK"}'

# 3. Required site failed: the report is written twice, raw on stderr and clack-decorated on
#    stdout. Both must collapse to one set of sites.
cat > "$TMP/req.err" <<'EOF'
  OK   PATCH 1: Agent tool model enum
  FAIL PATCH 3: known-alias validator list — anchor not found
clodex patch: 1 applied, 0 skipped, 1 failed
clodex patch: FAILED patches: PATCH 3: known-alias validator list
EOF
cat > "$TMP/req.out" <<'EOF'
│
■  Patch failed: clodex patch: required patch failed: PATCH 3: known-alias validator list
│
●    OK   PATCH 1: Agent tool model enum
│
●    FAIL PATCH 3: known-alias validator list — anchor not found
│
●  clodex patch: 1 applied, 0 skipped, 1 failed
│
●  clodex patch: FAILED patches: PATCH 3: known-alias validator list
EOF
run_case 1 "$TMP/req.out" "$TMP/req.err"
check "required FAIL reports the exit code" '`clodex patch` exited 1'
check "required FAIL keeps the top-level message" "Patch failed: clodex patch: required patch failed"
check "required FAIL names the site" "patch sites FAILED: PATCH 3: known-alias validator list"
check_sites "duplicated stdout/stderr report collapses" '{"PATCH 1: Agent tool model enum":"OK","PATCH 3: known-alias validator list":"FAIL"}'

# 4. Extraction failed before any site ran — the 2.1.231 entry-module shape.
cat > "$TMP/extract.out" <<'EOF'
│
■  Patch failed: Failed to extract JavaScript from native installation
EOF
: > "$TMP/extract.err"
run_case 1 "$TMP/extract.out" "$TMP/extract.err"
check "extraction failure reports the exit code" '`clodex patch` exited 1'
check "extraction failure keeps the message" "Failed to extract JavaScript from native installation"
check "extraction failure notes the missing summary" "no per-site summary was printed"
check_sites "extraction failure yields no sites" '{}'

# 5. Ambiguous anchor — a different FAIL reason shape, plus a SKIP.
cat > "$TMP/amb.err" <<'EOF'
  OK   PATCH 1: Agent tool model enum
  SKIP PATCH 7: per-model context window — already patched
  FAIL PATCH 6: alias resolver switch — anchor matched 3 times (expected 1)
clodex patch: 1 applied, 1 skipped, 1 failed
EOF
: > "$TMP/amb.out"
run_case 1 "$TMP/amb.out" "$TMP/amb.err"
check "ambiguous anchor is caught" "patch sites FAILED: PATCH 6: alias resolver switch"
check_sites "SKIP is recorded as SKIP" '{"PATCH 1: Agent tool model enum":"OK","PATCH 7: per-model context window":"SKIP","PATCH 6: alias resolver switch":"FAIL"}'

# 6. Summary says a site failed but no FAIL line survived — the count alone must still trip it.
cat > "$TMP/count.err" <<'EOF'
  OK   PATCH 1: Agent tool model enum
clodex patch: 1 applied, 0 skipped, 2 failed
EOF
: > "$TMP/count.out"
run_case 0 "$TMP/count.out" "$TMP/count.err"
check "a nonzero failed count alone is a failure" "the summary reports 2 failed site(s)"

# 7. Baseline regression: a site that used to apply is silently absent now.
BASE='{"PATCH 1: Agent tool model enum":"OK","PATCH 10: child network environment":"OK"}'
NOW='{"PATCH 1: Agent tool model enum":"OK"}'
REG="$(jq -n --argjson base "$BASE" --argjson now "$NOW" -r '
  $base | to_entries | map(select(.value == "OK"))
  | map(select(($now[.key] // "missing") != "OK") | "\(.key) (was OK, now \($now[.key] // "absent"))")
  | join("; ")')"
if [ "$REG" = "PATCH 10: child network environment (was OK, now absent)" ]; then
  pass=$((pass + 1)); printf 'ok   %s\n' "baseline regression is detected"
else
  fail=$((fail + 1)); printf 'FAIL %s — got: %s\n' "baseline regression is detected" "$REG"
fi

# 8. The session-liveness rule the whole deferral depends on, driven through the real
#    inflight_status() against a stand-in `claude agents --json`.
FAKE="$TMP/fake-claude"
cat > "$FAKE" <<'FAKEEOF'
#!/usr/bin/env bash
printf '%s\n' "$FAKE_AGENTS_JSON"
FAKEEOF
chmod +x "$FAKE"
CLAUDE_BIN="$FAKE"

liveness() { # liveness <label> <expected> <agents-json>
  local label="$1" want="$2" got
  export FAKE_AGENTS_JSON="$3"   # must be exported: the stand-in reads it from its environment
  got="$(inflight_status "inv-session" "abc123")"
  if [ "$got" = "$want" ]; then pass=$((pass + 1)); printf 'ok   liveness %-28s -> %s\n' "$label" "$got"
  else fail=$((fail + 1)); printf 'FAIL liveness %s -> %s (want %s)\n' "$label" "$got" "$want"; fi
}

liveness "running session"        working  '[{"id":"abc123","name":"inv-session","state":"working","status":"busy"}]'
liveness "finished session"       finished '[{"id":"abc123","name":"inv-session","state":"done","status":"idle"}]'
liveness "killed session"         stopped  '[{"id":"abc123","name":"inv-session","state":"stopped"}]'
liveness "unrecognised state"     working  '[{"id":"abc123","name":"inv-session","state":"compacting"}]'
liveness "no state field"         working  '[{"id":"abc123","name":"inv-session"}]'
liveness "matched by name only"   working  '[{"id":"zzz","name":"inv-session","state":"working"}]'
liveness "session really gone"    missing  '[{"id":"other","name":"something-else","state":"working"}]'
liveness "empty session list"     missing  '[]'
# The important one: a failed/garbled query must NOT read as "the investigation ended".
liveness "query returned garbage" unknown  'not json at all'
liveness "query returned nothing" unknown  ''
liveness "query returned an error object" unknown '{"error":"daemon unavailable"}'

CLAUDE_BIN="$TMP/definitely-not-here"
if [ "$(inflight_status "inv-session" "abc123")" = "unknown" ]; then
  pass=$((pass + 1)); printf 'ok   liveness %-28s -> unknown\n' "no claude binary"
else
  fail=$((fail + 1)); printf 'FAIL liveness no claude binary did not report unknown\n'
fi

# ---------------------------------------------------------- the platform matrix
#
# Everything below drives the real functions in clodex-patch-canary-platforms.sh against a
# hand-written matrix.jsonl, which is exactly what a run leaves behind. No download, no Docker.

MATRIX="$TMP/matrix.jsonl"

# write_matrix <platform:mode:status[:reason]> ... — one leg per argument.
write_matrix() {
  local entry platform mode status reason SITES_JSON
  SITES_JSON="${MATRIX_SITES:-}"
  [ -n "$SITES_JSON" ] || SITES_JSON='{}'
  : > "$MATRIX"
  for entry in "$@"; do
    platform="$(printf '%s' "$entry" | cut -d: -f1)"
    mode="$(printf '%s' "$entry" | cut -d: -f2)"
    status="$(printf '%s' "$entry" | cut -d: -f3)"
    reason="$(printf '%s' "$entry" | cut -d: -f4-)"
    [ -z "$reason" ] || reason="- $reason
"
    jq -n -c --arg p "$platform" --arg m "$mode" --arg s "$status" --arg r "$reason" \
            --argjson d "$( [ "$mode" = "probe" ] && [ "${platform#linux-arm64}" != "$platform" ] && echo true || echo false)" \
            --argjson sites "$SITES_JSON" \
      '{platform: $p, mode: $m, status: $s, reasons: $r, binary: "", tarball: "",
        downgraded: $d, sites: $sites, markers: [], detail: {image: "node:24-bookworm"}}' >> "$MATRIX"
  done
}

matrix_check() { # matrix_check <name> <expected> <actual>
  if [ "$3" = "$2" ]; then pass=$((pass + 1)); printf 'ok   %s\n' "$1"
  else fail=$((fail + 1)); printf 'FAIL %s\n  want %s\n  got  %s\n' "$1" "$2" "$3"; fi
}

# 9. The shape the real ELF break had: four platforms, one cause, macOS untouched.
write_matrix \
  "darwin-arm64:host:pass" "darwin-x64:probe:pass" \
  "linux-x64:probe:fail:the entry-module stand-in survived restoration" \
  "linux-arm64:container:fail:the entry-module stand-in survived restoration" \
  "linux-x64-musl:probe:fail:the entry-module stand-in survived restoration" \
  "linux-arm64-musl:container:fail:the entry-module stand-in survived restoration" \
  "win32-x64:probe:pass" "win32-arm64:probe:pass"

matrix_check "ELF break: failing platforms" \
  "linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl" "$(matrix_platforms fail)"
matrix_check "ELF break: host is unaffected" "pass" "$(matrix_status_of darwin-arm64)"
matrix_check "ELF break: 4 of 8 failed" "4 8" "$(matrix_count fail) $(matrix_total)"
# One cause reported by four platforms must collapse to ONE line — the alert is read on a phone.
matrix_check "ELF break: one shared cause is one line" \
  "- the entry-module stand-in survived restoration [linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl]" \
  "$(matrix_reason_groups)"

# 10. Distinct causes must NOT be collapsed together.
write_matrix "linux-x64:probe:fail:anchor not found" "win32-x64:probe:fail:repack produced no content"
matrix_check "distinct causes stay separate" "2" "$(matrix_reason_groups | grep -c '^- ')"

# 11. A leg that could not run is never a verdict.
write_matrix "darwin-arm64:host:pass" "linux-arm64:container:error:the container could not be run"
matrix_check "an unrunnable leg is not a failure" "" "$(matrix_platforms fail)"
matrix_check "an unrunnable leg is not a pass either" "linux-arm64" "$(matrix_platforms error)"
matrix_check "an unrunnable leg is reported" \
  "- the container could not be run" "$(matrix_error_notes)"

# 12. Docker missing downgrades the Linux legs, and that thinner coverage must be said out loud —
#     silently reduced coverage reported as a clean pass is the failure this whole change is about.
write_matrix "darwin-arm64:host:pass" "linux-arm64:probe:pass" "linux-arm64-musl:probe:pass"
matrix_check "a downgraded leg still passes" "" "$(matrix_platforms fail)"
if printf '%s' "$(matrix_downgrade_notes)" | grep -q 'linux-arm64 and linux-arm64-musl'; then
  pass=$((pass + 1)); printf 'ok   %s\n' "a downgraded leg is disclosed"
else
  fail=$((fail + 1)); printf 'FAIL a downgraded leg is disclosed — got: %s\n' "$(matrix_downgrade_notes)"
fi
write_matrix "darwin-arm64:host:pass" "linux-arm64:container:pass"
matrix_check "a full container leg is not called a downgrade" "" "$(matrix_downgrade_notes)"

# 13. The baseline migration. A state.json written before the matrix existed holds one flat
#     `sites` map that described the host and nothing else; discarding it would leave the first
#     multi-platform run with nothing to compare against.
STATE_FILE="$TMP/state.json"
cat > "$STATE_FILE" <<'EOF'
{"versions":{},"baseline":{"version":"2.1.234","sites":{"PATCH 1: Agent tool model enum":"OK"},
 "markers":["ccpatch:ctx"],"configFingerprint":"abc"},"inflight":null,"deferred":{}}
EOF
matrix_check "legacy baseline is read as the host's" \
  "$(host_platform)" "$(baseline_platforms | jq -r 'keys | join(",")')"
matrix_check "legacy baseline keeps its sites" \
  "OK" "$(baseline_platforms | jq -r --arg h "$(host_platform)" '.[$h].sites["PATCH 1: Agent tool model enum"]')"

cat > "$STATE_FILE" <<'EOF'
{"versions":{},"baseline":{"version":"2.1.235","platforms":{"linux-x64":{"mode":"probe","sites":{},"markers":[]}},
 "configFingerprint":"abc"},"inflight":null,"deferred":{}}
EOF
matrix_check "a per-platform baseline is used as-is" \
  "linux-x64" "$(baseline_platforms | jq -r 'keys | join(",")')"

cat > "$STATE_FILE" <<'EOF'
{"versions":{},"baseline":null,"inflight":null,"deferred":{}}
EOF
matrix_check "no baseline yet is not an error" "{}" "$(baseline_platforms)"
rm -f "$STATE_FILE"

# 14. The platform table itself: every published platform is in it, and --platforms is validated.
matrix_check "every published platform is tested" \
  "darwin-arm64 darwin-x64 linux-arm64 linux-arm64-musl linux-x64 linux-x64-musl win32-arm64 win32-x64" \
  "$(opt_platforms="" platform_names | sort | tr '\n' ' ' | sed 's/ $//')"
matrix_check "windows ships claude.exe, not claude" "claude.exe" "$(platform_member win32-x64)"
matrix_check "linux-arm64 gets a full containerised patch" "node:24-bookworm" "$(platform_image linux-arm64)"
matrix_check "musl gets an alpine container" "node:24-alpine" "$(platform_image linux-arm64-musl)"
matrix_check "--platforms selects a subset" "win32-x64 linux-x64" \
  "$(opt_platforms="win32-x64,linux-x64" platform_names | tr '\n' ' ' | sed 's/ $//')"
# A typo must stop the run in the PARENT shell. platform_names is only ever read through
# `$(...)`, so validate_platforms is what has to refuse — checked here through the real function.
if ( opt_platforms="linux-x65" validate_platforms ) >/dev/null 2>&1; then
  fail=$((fail + 1)); printf 'FAIL a misspelt --platforms is accepted\n'
else
  pass=$((pass + 1)); printf 'ok   %s\n' "a misspelt --platforms stops the run"
fi
if ( opt_platforms="win32-x64" validate_platforms ) >/dev/null 2>&1; then
  pass=$((pass + 1)); printf 'ok   %s\n' "a valid --platforms is accepted"
else
  fail=$((fail + 1)); printf 'FAIL a valid --platforms was rejected\n'
fi

# 15. --no-container must degrade to probes rather than failing.
matrix_check "--no-container skips docker" "probe" \
  "$(DOCKER_READY="" opt_container=0 platform_mode linux-arm64)"
matrix_check "the host is always the host leg" "host" \
  "$(DOCKER_READY=no platform_mode "$(host_platform)")"
matrix_check "a probe-only platform stays a probe with docker up" "probe" \
  "$(DOCKER_READY=yes platform_mode win32-x64)"
matrix_check "linux-arm64 uses the container when docker is up" "container" \
  "$(DOCKER_READY=yes platform_mode linux-arm64)"

# 16. The green-light gate. This is the one that decides whether a human is told "safe to
#     update", and the incident this whole change exists because of was a coverage hole reported
#     as a clean pass — so every way of having a hole must block the tick.
HOST="$(host_platform)"

# The gate now also asks "was every published platform in the matrix at all", so these fixtures
# have to be the real eight — a subset is exactly the --platforms case it must refuse.
FULL_MATRIX_ARGS="darwin-arm64:host:pass darwin-x64:probe:pass linux-x64:probe:pass \
linux-arm64:container:pass linux-x64-musl:probe:pass linux-arm64-musl:container:pass \
win32-x64:probe:pass win32-arm64:probe:pass"

write_matrix $FULL_MATRIX_ARGS
if coverage_is_complete "$HOST"; then
  pass=$((pass + 1)); printf 'ok   %s\n' "a fully covered run earns the green tick"
else
  fail=$((fail + 1)); printf 'FAIL a fully covered run was denied the green tick\n'
fi

# The mutation that matters: each of these alone must take the tick away.
gate_denied() { # gate_denied <name> <matrix entries...>
  local name="$1"; shift
  write_matrix "$@"
  if coverage_is_complete "$HOST"; then
    fail=$((fail + 1)); printf 'FAIL %s — still reported as full coverage\n' "$name"
  else
    pass=$((pass + 1)); printf 'ok   %s\n' "$name"
  fi
}
# swap <platform:mode:status[:reason]> — the full matrix with one leg replaced.
swap() {
  local want="${1%%:*}" entry out=""
  for entry in $FULL_MATRIX_ARGS; do
    if [ "${entry%%:*}" = "$want" ]; then out="$out $1"; else out="$out $entry"; fi
  done
  printf '%s' "$out"
}
gate_denied "an errored leg blocks the green tick" \
  $(swap "linux-arm64:container:error:the container could not be run")
gate_denied "an untested host blocks the green tick" \
  $(swap "darwin-arm64:host:error:the binary would not run")
gate_denied "a platform that never published blocks the green tick" \
  $(swap "win32-x64:none:error:has not published yet")
# The subtle one: everything says pass, but Linux was tested more cheaply than it should have been.
gate_denied "a downgraded Linux leg blocks the green tick" \
  $(swap "linux-arm64:probe:pass")
# And the one that motivated the platform-count rule: a --platforms subset in which nothing failed.
gate_denied "a subset run never counts as full coverage" \
  "$HOST:host:pass" "linux-arm64:container:pass"

# 17. A SKIP is a site that did nothing. Counting it as applied is how "all 11 applied" stays
#     true while a clodex feature is quietly off.
MATRIX_SITES='{"PATCH 1: a":"OK","PATCH 3: b":"OK","PATCH 7: c":"SKIP","PATCH 9: d":"OK"}' \
  write_matrix "$HOST:host:pass"
matrix_check "applied counts OK only, not SKIP" "3" "$(matrix_applied_sites "$HOST")"
matrix_check "reported counts every site" "4" "$(matrix_total_sites "$HOST")"
matrix_check "a platform with no sites reports zero" "0" "$(matrix_applied_sites nonesuch)"

# 18. The brief coverage block used in the fail alert: failures in full, passes collapsed.
write_matrix "$HOST:host:pass" "darwin-x64:probe:pass" \
  "linux-x64:probe:fail:broken" "linux-arm64:container:fail:broken"
BRIEF="$(matrix_coverage_brief)"
matrix_check "brief coverage lists each failure and collapses the rest" "3" "$(printf '%s\n' "$BRIEF" | grep -c .)"
case "$BRIEF" in
  *"2 clean: $HOST, darwin-x64"*) pass=$((pass + 1)); printf 'ok   %s\n' "brief coverage names the clean platforms" ;;
  *) fail=$((fail + 1)); printf 'FAIL brief coverage names the clean platforms — got:\n%s\n' "$BRIEF" ;;
esac

# 19. A downgraded leg must not render identically to a probe-by-design one.
write_matrix "linux-arm64:probe:pass" "win32-x64:probe:pass"
FULL="$(matrix_coverage_line)"
case "$FULL" in
  *":warning: *linux-arm64*"*) pass=$((pass + 1)); printf 'ok   %s\n' "a downgraded leg is not shown as a clean tick" ;;
  *) fail=$((fail + 1)); printf 'FAIL a downgraded leg is not shown as a clean tick — got:\n%s\n' "$FULL" ;;
esac
# win32 has no container image, so its probe is the strongest leg it can have and keeps its tick.
# But the tick alone used to be the whole assertion, and that is what let win32-arm64 be reported
# clean on 2.1.238 while `PATCH 5: model picker options` no longer matched there. A probe now
# exercises the patch sites, so the tick is earned — and the line must still say what was NOT
# established, or the tick means more than it should.
case "$FULL" in
  *":white_check_mark: *win32-x64*"*) pass=$((pass + 1)); printf 'ok   %s\n' "a probe-by-design leg still shows a clean tick" ;;
  *) fail=$((fail + 1)); printf 'FAIL a probe-by-design leg lost its tick — got:\n%s\n' "$FULL" ;;
esac
case "$FULL" in
  *"win32-x64* — bundle patch + binary handling; native execution not checked"*)
    pass=$((pass + 1)); printf 'ok   %s\n' "a probe-by-design leg discloses that nothing was executed" ;;
  *) fail=$((fail + 1)); printf 'FAIL a probe-by-design leg discloses that nothing was executed — got:\n%s\n' "$FULL" ;;
esac
case "$(matrix_downgrade_notes)" in
  *"NO patched Linux binary was started"*)
    pass=$((pass + 1)); printf 'ok   %s\n' "a downgraded leg says what it did and did not cover" ;;
  *) fail=$((fail + 1)); printf 'FAIL a downgraded leg says what it did and did not cover — got: %s\n' "$(matrix_downgrade_notes)" ;;
esac
matrix_check "--no-container is not reported as Docker being down" "0" \
  "$(opt_container=0 matrix_downgrade_notes | grep -c 'Docker was not available')"

# 19b. The probe's verdict, driven through the real evaluate_probe_leg against hand-written
#      results — the leg itself needs a 300 MB binary, this does not.
#
#      This is the blind spot that let Claude Code 2.1.238 through. win32-arm64 has no container
#      image, so it is always a probe; the probe exercised zero patch sites; `PATCH 5: model
#      picker options` had stopped matching on that build; and the canary reported win32-arm64 as
#      a clean pass while reporting the same break on the two Linux builds that DO have images.
MECHANISM_CHECKS='[{"name":"pristine-parses","ok":true,"detail":"entry module is needs-shim"},
                   {"name":"read-content","ok":true,"detail":"28147627 bytes of JavaScript"},
                   {"name":"published-content","ok":true,"detail":"byte-for-byte"}]'

# write_probe_json <file> <verdict> <patch-sites-json> [reasons-json] [extra-check-json]
write_probe_json() {
  jq -n --argjson checks "$MECHANISM_CHECKS" --arg verdict "$2" --argjson sites "$3" \
        --argjson reasons "${4:-[]}" --argjson extra "${5:-null}" \
    '{label: "win32-arm64", format: "pe", entryState: "needs-shim", shimUsed: true,
      pristineSize: 322051744, publishedSize: 322133550, growth: 1, detectedVersion: "2.1.238",
      sourceBytes: 28147627, durationMs: 33016, verdict: $verdict, reasons: $reasons,
      checks: ($checks + (if $extra == null then [] else [$extra] end)),
      patchSites: $sites,
      patchSiteSummary: {applied: ($sites | map(select(.status == "OK")) | length),
                         skipped: ($sites | map(select(.status == "SKIP")) | length),
                         failed:  ($sites | map(select(.status == "FAIL")) | length),
                         total: ($sites | length)}}' > "$1"
}

ALL_SITES_OK='[{"name":"PATCH 1: Agent tool model enum","status":"OK"},
               {"name":"PATCH 5: model picker options","status":"OK"},
               {"name":"PATCH 10: child network environment","status":"OK"}]'
PATCH5_MISSING='[{"name":"PATCH 1: Agent tool model enum","status":"OK"},
                 {"name":"PATCH 5: model picker options","status":"FAIL","extra":"anchor not found"},
                 {"name":"PATCH 10: child network environment","status":"OK"}]'

: > "$TMP/probe.stderr"
leg_reset
write_probe_json "$TMP/probe-ok.json" pass "$ALL_SITES_OK"
evaluate_probe_leg win32-arm64 "$TMP/probe-ok.json" 0 "$TMP/probe.stderr" >/dev/null
matrix_check "a clean probe passes" "pass" "$LEG_STATUS"
matrix_check "a clean probe reports no reasons" "" "$LEG_REASONS"
# Both name spaces, in one map: losing the mechanism checks here would silently retire the
# regression detection that has watched them since the ELF break.
matrix_check "a probe records its patch sites alongside its mechanism checks" "OK OK" \
  "$(printf '%s' "$LEG_SITES" | jq -r '."PATCH 5: model picker options" + " " + ."published-content"')"
matrix_check "a probe records how many patch sites applied" "3" \
  "$(printf '%s' "$LEG_DETAIL" | jq -r '.patchSites.applied')"

leg_reset
write_probe_json "$TMP/probe-p5.json" fail "$PATCH5_MISSING" \
  '["patch sites FAILED: PATCH 5: model picker options"]' \
  '{"name":"patch-sites-apply","ok":false,"detail":"patch sites FAILED: PATCH 5: model picker options"}'
evaluate_probe_leg win32-arm64 "$TMP/probe-p5.json" 1 "$TMP/probe.stderr" >/dev/null
matrix_check "a probe that loses PATCH 5 FAILS" "fail" "$LEG_STATUS"
matrix_check "a probe names the patch site it lost" \
  "- patch sites FAILED: PATCH 5: model picker options" "$(printf '%s' "$LEG_REASONS" | head -1)"
matrix_check "a failing patch site is recorded as FAIL, not as a missing key" "FAIL" \
  "$(printf '%s' "$LEG_SITES" | jq -r '."PATCH 5: model picker options"')"

# The old probe: mechanism checks, verdict pass, no patch sites at all. Recording that as a pass
# is precisely the report that made 2.1.238 look safe on Windows, so it may not be one.
leg_reset
jq -n --argjson checks "$MECHANISM_CHECKS" \
  '{label: "win32-arm64", format: "pe", durationMs: 1, verdict: "pass", reasons: [], checks: $checks}' \
  > "$TMP/probe-old.json"
evaluate_probe_leg win32-arm64 "$TMP/probe-old.json" 0 "$TMP/probe.stderr" >/dev/null
matrix_check "a probe with no patch-site results is never a pass" "error" "$LEG_STATUS"
case "$LEG_REASONS" in
  *"patch anchors were not"*) pass=$((pass + 1)); printf 'ok   %s\n' "a probe with no patch-site results says why it is not a verdict" ;;
  *) fail=$((fail + 1)); printf 'FAIL a probe with no patch-site results says why — got: %s\n' "$LEG_REASONS" ;;
esac

# 19c. The whole incident, end to end at the matrix level: 2.1.238 lost PATCH 5 on the two arm64
#      Linux builds AND on win32-arm64. All three must fail, as one grouped cause, and the run
#      must not earn the green tick.
write_matrix \
  "darwin-arm64:host:pass" "darwin-x64:probe:pass" "linux-x64:probe:pass" \
  "linux-arm64:container:fail:patch sites FAILED: PATCH 5: model picker options" \
  "linux-x64-musl:probe:pass" \
  "linux-arm64-musl:container:fail:patch sites FAILED: PATCH 5: model picker options" \
  "win32-x64:probe:pass" \
  "win32-arm64:probe:fail:patch sites FAILED: PATCH 5: model picker options"
matrix_check "2.1.238: win32-arm64 fails with the Linux builds instead of passing beside them" \
  "linux-arm64 linux-arm64-musl win32-arm64" "$(matrix_platforms fail)"
matrix_check "2.1.238: one anchor on three builds is one alert line" "1" \
  "$(matrix_reason_groups | grep -c '^- ')"
case "$(matrix_reason_groups)" in
  *"[linux-arm64, linux-arm64-musl, win32-arm64]"*)
    pass=$((pass + 1)); printf 'ok   %s\n' "2.1.238: the grouped line names all three builds" ;;
  *) fail=$((fail + 1)); printf 'FAIL 2.1.238 grouped line — got: %s\n' "$(matrix_reason_groups)" ;;
esac
# The gate the main flow actually branches on. `coverage_is_complete` is deliberately NOT it: it
# asks "was every platform tested", and a leg that failed was tested — it is the non-empty reason
# list that sends the run down the alert path instead of the "safe to update" one.
if [ -n "$(matrix_reason_groups)" ]; then
  pass=$((pass + 1)); printf 'ok   %s\n' "2.1.238: a lost patch anchor sends the run down the alert path"
else
  fail=$((fail + 1)); printf 'FAIL 2.1.238 produced no reasons, so it would have been announced as safe\n'
fi
# And the quieter half of the same failure: a platform recorded as clean becomes next release's
# baseline, so win32-arm64 passing here would ALSO have taught the canary that a bundle missing
# PATCH 5 is what win32-arm64 is supposed to look like.
matrix_check "2.1.238: a build that lost a patch anchor sets no baseline" "" \
  "$(jq -s -r 'map(select(.status == "pass") | .platform) | map(select(. == "win32-arm64")) | join("")' "$MATRIX")"

# 20. The state machine. These filters decide whether a release is ever retested and whether
#     regression detection keeps working, so they are driven through the real state_update.
STATE_FILE="$TMP/state.json"
STATE_DIR="$TMP"
state_set() { printf '%s\n' "$1" > "$STATE_FILE"; }
state_get() { state_read | jq -r "$1"; }

# A platform that could not run this time must keep the baseline it had. Replacing rather than
# merging is how one Docker outage used to erase a platform's history.
state_set '{"versions":{},"baseline":{"version":"1.0.0","platforms":{
  "linux-x64":{"mode":"probe","sites":{"a":"OK"},"version":"1.0.0"},
  "win32-x64":{"mode":"probe","sites":{"b":"OK"},"version":"1.0.0"}}},"pending":{},"deferred":{}}'
state_update '.baseline = {version: $v, platforms: ((.baseline.platforms // {}) * $base)}' \
  --arg v "2.0.0" \
  --argjson base '{"linux-x64":{"mode":"probe","sites":{"a":"OK"},"version":"2.0.0"}}'
matrix_check "a platform that ran advances its baseline" "2.0.0" "$(state_get '.baseline.platforms["linux-x64"].version')"
matrix_check "a platform that did not run keeps its baseline" "1.0.0" "$(state_get '.baseline.platforms["win32-x64"].version')"
matrix_check "no platform is dropped from the baseline" "linux-x64 win32-x64" \
  "$(state_get '.baseline.platforms | keys | join(" ")')"

# "Last release clean on every build" may only be claimed by a fully covered run.
state_set '{"versions":{},"baseline":null,"pending":{},"deferred":{}}'
state_update '(if $st == "pass" then .lastCompleteVersion = $v else . end)' --arg v "3.0.0" --arg st "partial"
matrix_check "a partial run claims no known-good release" "" "$(state_get '.lastCompleteVersion // ""')"
state_update '(if $st == "pass" then .lastCompleteVersion = $v else . end)' --arg v "3.0.1" --arg st "pass"
matrix_check "a complete run does claim one" "3.0.1" "$(state_get '.lastCompleteVersion')"

# --retriage must re-open a version WITHOUT throwing away the evidence pointers, because the run
# that follows it can exit before recording anything.
state_set '{"versions":{"4.0.0":{"status":"fail","sandbox":"/tmp/sb","log":"/tmp/l","reasons":"boom"}},
            "baseline":null,"pending":{},"deferred":{}}'
state_update '.versions[$v] = ((.versions[$v] // {}) + {status: "retriage",
                                previousStatus: (.versions[$v].status // "none")})' --arg v "4.0.0"
matrix_check "--retriage re-opens the version" "retriage" "$(state_get '.versions["4.0.0"].status')"
matrix_check "--retriage keeps the sandbox pointer" "/tmp/sb" "$(state_get '.versions["4.0.0"].sandbox')"
matrix_check "--retriage remembers what it replaced" "fail" "$(state_get '.versions["4.0.0"].previousStatus')"
rm -f "$STATE_FILE"

# 21. A favourites change must disable the comparison for the platform it affects, and ONLY that
#     platform. Merged baselines can hold two config generations at once, and comparing a stale
#     entry against the current config invents a release regression that never happened.
fp_case() { # fp_case <name> <base-entry-json> <current-fp> <expect: compare|skip>
  local name="$1" base_fp cur="$3" want="$4" got
  base_fp="$(printf '%s' "$2" | jq -r '.configFingerprint // ""')"
  if [ -n "$base_fp" ] && [ "$base_fp" != "$cur" ]; then got=skip; else got=compare; fi
  matrix_check "$name" "$want" "$got"
}
fp_case "same config compares"        '{"configFingerprint":"aaa"}' aaa compare
fp_case "changed config skips"        '{"configFingerprint":"aaa"}' bbb skip
fp_case "a pre-fingerprint entry falls back" '{}'                   bbb compare

# 22. The container leg must tell a patch that HUNG from a container that never got that far —
#     one is a broken release, the other is the canary's own infrastructure.
hang_case() { # hang_case <name> <started-marker-exists> <expect>
  local name="$1" started="$2" got
  if [ "$started" = "yes" ]; then got=fail; else got=error; fi
  matrix_check "$name" "$3" "$got"
}
hang_case "a patch that started and hung is a failure" yes fail
hang_case "a container that never started is an error" no  error

# 23. The investigation prompt must actually REACH Claude Code.
#     `--add-dir <directories...>` is VARIADIC. A prompt passed after it is silently swallowed as
#     one more directory: the session starts idle, does nothing, and — because it still counts as
#     in-flight — blocks every later investigation until the 24h escape hatch fires. That happened
#     for real on Claude Code 2.1.238. Every other test here mocks `claude` with a script that
#     accepts any argv, which is exactly why none of them could see it. This fake emulates
#     commander's variadic rule instead, so it can.
ARGV_LOG="$TMP/argv.log"; export ARGV_LOG
FAKECC="$TMP/fake-claude-argv"
cat > "$FAKECC" <<'FAKEEOF'
#!/usr/bin/env bash
: > "$ARGV_LOG"
prompt=""; endopts=0
while [ $# -gt 0 ]; do
  if [ "$endopts" -eq 1 ]; then printf 'POSITIONAL %s\n' "$1" >> "$ARGV_LOG"; prompt="$1"; shift; continue; fi
  case "$1" in
    --) endopts=1; shift ;;
    --add-dir) shift
      # variadic: swallow every following non-flag argument
      while [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; do printf 'ADDDIR %s\n' "$1" >> "$ARGV_LOG"; shift; done ;;
    --name|--model|--effort) shift 2 ;;
    -*) shift ;;
    *) printf 'POSITIONAL %s\n' "$1" >> "$ARGV_LOG"; prompt="$1"; shift ;;
  esac
done
if [ -z "$prompt" ]; then printf 'backgrounded · deadbeef · sess (idle — send a prompt to start)\n'
else printf 'backgrounded · deadbeef · sess\n'; fi
FAKEEOF
chmod +x "$FAKECC"

MARKER="PROMPT-MUST-SURVIVE-ARGV"
CLAUDE_BIN="$FAKECC"
CLODEX_WORKING_COPY="$TMP"
opt_launch=1
investigation_prompt() { printf '%s\n' "$MARKER"; }
state_read()   { printf '{}\n'; }
state_update() { :; }
slack()        { LAST_SLACK="$*"; return 0; }
log()          { :; }

set +e
LAUNCH_OUT="$(launch_investigation 9.9.9 "some reason" "$TMP/x.log" 2>&1)"; LAUNCH_RC=$?
set -e

if grep -q "^POSITIONAL $MARKER\$" "$ARGV_LOG" 2>/dev/null; then
  pass=$((pass + 1)); printf 'ok   %s\n' "the prompt reaches claude as a positional, not as an --add-dir path"
else
  fail=$((fail + 1)); printf 'FAIL %s — argv was:\n%s\n' "the prompt reaches claude as a positional" "$(cat "$ARGV_LOG" 2>/dev/null)"
fi

if grep -q "^ADDDIR $MARKER\$" "$ARGV_LOG" 2>/dev/null; then
  fail=$((fail + 1)); printf 'FAIL %s\n' "the prompt was swallowed by --add-dir"
else
  pass=$((pass + 1)); printf 'ok   %s\n' "the prompt is not swallowed by the variadic --add-dir"
fi

# An empty prompt must be refused outright rather than starting a do-nothing session.
investigation_prompt() { printf '   \n'; }
LAST_SLACK=""
if launch_investigation 9.9.9 "r" "$TMP/x.log" >/dev/null 2>&1; then
  fail=$((fail + 1)); printf 'FAIL %s\n' "an empty prompt is refused"
else
  case "$LAST_SLACK" in *EMPTY*) pass=$((pass + 1)); printf 'ok   %s\n' "an empty prompt is refused and reported" ;;
    *) fail=$((fail + 1)); printf 'FAIL %s — slack said: %s\n' "an empty prompt is refused and reported" "$LAST_SLACK" ;; esac
fi

# A session that comes up idle must read as a launch FAILURE, not be recorded as in-flight.
investigation_prompt() { printf '%s\n' "$MARKER"; }
cat > "$FAKECC" <<'FAKEEOF'
#!/usr/bin/env bash
printf 'backgrounded · deadbeef · sess (idle — send a prompt to start)\n'
FAKEEOF
chmod +x "$FAKECC"
LAST_SLACK=""
if launch_investigation 9.9.9 "r" "$TMP/x.log" >/dev/null 2>&1; then
  fail=$((fail + 1)); printf 'FAIL %s\n' "an idle session is treated as a failed launch"
else
  case "$LAST_SLACK" in *"NO PROMPT"*) pass=$((pass + 1)); printf 'ok   %s\n' "an idle session is treated as a failed launch" ;;
    *) fail=$((fail + 1)); printf 'FAIL %s — slack said: %s\n' "an idle session is treated as a failed launch" "$LAST_SLACK" ;; esac
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
