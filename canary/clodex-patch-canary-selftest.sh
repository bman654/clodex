#!/usr/bin/env bash
#
# Self-test for clodex-patch-canary.sh's report parsing and verdict logic.
# Drives the real functions against captured `clodex patch` output shapes — no download, no patch.
#
set -Eeuo pipefail

# The canary next to this file, so a checkout tests its own copy rather than the installed one.
# BASH_SOURCE does not follow the ~/.local/bin symlink, so the installed self-test still tests the
# installed canary.
CANARY="${1:-$(dirname "${BASH_SOURCE[0]}")/clodex-patch-canary.sh}"
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

# 8. The thread-liveness rule the whole deferral depends on, driven through the real
#    inflight_status() against a stand-in `t3cli list --format json`.
FAKE="$TMP/fake-t3cli"
cat > "$FAKE" <<'FAKEEOF'
#!/usr/bin/env bash
printf '%s\n' "$FAKE_THREADS_JSON"
FAKEEOF
chmod +x "$FAKE"
T3CLI_BIN="$FAKE"

liveness() { # liveness <label> <expected> <threads-json>
  local label="$1" want="$2" got
  export FAKE_THREADS_JSON="$3"   # must be exported: the stand-in reads it from its environment
  got="$(inflight_status "abc123")"
  if [ "$got" = "$want" ]; then pass=$((pass + 1)); printf 'ok   liveness %-32s -> %s\n' "$label" "$got"
  else fail=$((fail + 1)); printf 'FAIL liveness %s -> %s (want %s)\n' "$label" "$got" "$want"; fi
}

liveness "running thread"           working  '[{"id":"abc123","status":"running"}]'
liveness "queued thread"            working  '[{"id":"abc123","status":"queued"}]'
liveness "thread waiting on answer" working  '[{"id":"abc123","status":"waiting"}]'
liveness "idle thread"              finished '[{"id":"abc123","status":"idle"}]'
liveness "completed run"            finished '[{"id":"abc123","status":"completed"}]'
liveness "interrupted run"          stopped  '[{"id":"abc123","status":"interrupted"}]'
liveness "cancelled run"            stopped  '[{"id":"abc123","status":"cancelled"}]'
liveness "failed run"               failed   '[{"id":"abc123","status":"failed","lastError":"boom"}]'
liveness "usage-limited run"        working  '[{"id":"abc123","status":"failed","usageLimitResetAt":"2026-10-31T00:00:00Z"}]'
liveness "unrecognised status"      working  '[{"id":"abc123","status":"compacting"}]'
liveness "no status field"          working  '[{"id":"abc123"}]'
liveness "deleted thread"           missing  '[{"id":"abc123","status":"idle","deletedAt":"2026-10-30T00:00:00Z"}]'
liveness "thread really gone"       missing  '[{"id":"other","status":"running"}]'
liveness "empty thread list"        missing  '[]'
# The important one: a failed/garbled query must NOT read as "the investigation ended".
liveness "query returned garbage"   unknown  'not json at all'
liveness "query returned nothing"   unknown  ''
liveness "query returned an error object" unknown '{"error":"T3 Code is not running"}'

if [ "$(inflight_status "")" = "unknown" ]; then
  pass=$((pass + 1)); printf 'ok   liveness %-32s -> unknown\n' "no thread id recorded"
else
  fail=$((fail + 1)); printf 'FAIL liveness no thread id recorded did not report unknown\n'
fi
T3CLI_BIN="$TMP/definitely-not-here"
if [ "$(inflight_status "abc123")" = "unknown" ]; then
  pass=$((pass + 1)); printf 'ok   liveness %-32s -> unknown\n' "no t3cli binary"
else
  fail=$((fail + 1)); printf 'FAIL liveness no t3cli binary did not report unknown\n'
fi

# 8b. A failed release is re-tested once a canary fix PR merges that its failing test did not
#     include. The merge does not wake the investigation thread, so this lookup is the only thing
#     that notices. Driven through the real merged_canary_fix_pr() with curl stood in for GitHub
#     and a real clone deciding ancestry: an old fix the tested commit contains, the tested commit,
#     and a fix that merged after it (as if while the matrix was still running).
FIX_REPO="$TMP/fix-repo"
git -C "$TMP" init -q fix-repo
git -C "$FIX_REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m old-fix
OLD_FIX_SHA="$(git -C "$FIX_REPO" rev-parse HEAD)"
git -C "$FIX_REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m tested
TESTED_SHA="$(git -C "$FIX_REPO" rev-parse HEAD)"
git -C "$FIX_REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m new-fix
NEW_FIX_SHA="$(git -C "$FIX_REPO" rev-parse HEAD)"
UNFETCHED_SHA=0123456789abcdef0123456789abcdef01234567
CURL_LOG="$TMP/curl.log"
fix_case() { # fix_case <label> <expected-url-or-EMPTY> <state-json> <api-response|FAIL> [repo-url]
  local got want="$2" state_fixture="$3" api="$4"
  rm -f "$CURL_LOG"
  got="$( state_read() { printf '%s\n' "$state_fixture"; }
          curl() { printf '%s\n' "$@" > "$CURL_LOG"; [ "$api" != FAIL ] || return 22; printf '%s\n' "$api"; }
          REPO_DIR="$FIX_REPO" CANARY_REPO_URL="${5:-https://github.com/bman654/clodex.git}" \
            CANARY_BRANCH=main merged_canary_fix_pr 9.9.9 )"
  [ "$want" != EMPTY ] || want=""
  if [ "$got" = "$want" ]; then pass=$((pass + 1)); printf 'ok   %s\n' "$1"
  else fail=$((fail + 1)); printf 'FAIL %s -> "%s" (want "%s")\n' "$1" "$got" "$want"; fi
}
FAILED_ON="$(jq -n -c --arg sha "$TESTED_SHA" '{versions: {"9.9.9": {status: "fail", clodexSha: $sha}}}')"
pr() { # pr <number> <head-ref> <merged_at|null> <merge-sha>
  jq -n -c --arg n "$1" --arg ref "$2" --arg m "$3" --arg sha "$4" \
    '{html_url: "https://github.com/bman654/clodex/pull/\($n)", head: {ref: $ref}, merge_commit_sha: $sha,
      merged_at: (if $m == "null" then null else $m end)}'
}
URL() { printf 'https://github.com/bman654/clodex/pull/%s' "$1"; }
fix_case "a fix merged after the tested commit is found" "$(URL 3)" "$FAILED_ON" \
  "[$(pr 2 fix/patch-cc-9.9.8 2026-10-29T09:00:00Z "$OLD_FIX_SHA"),$(pr 3 fix/patch-cc-9.9.9 2026-10-30T11:00:00Z "$NEW_FIX_SHA")]"
if grep -qx 'state=closed' "$CURL_LOG" && grep -qx 'base=main' "$CURL_LOG" &&
   grep -qx 'https://api.github.com/repos/bman654/clodex/pulls' "$CURL_LOG"; then
  pass=$((pass + 1)); printf 'ok   %s\n' "the lookup asks for closed PRs into main"
else
  fail=$((fail + 1)); printf 'FAIL %s — curl got:\n%s\n' "the lookup asks for closed PRs into main" "$(cat "$CURL_LOG" 2>/dev/null)"
fi
fix_case "an ssh remote resolves to the same repository" "$(URL 3)" "$FAILED_ON" \
  "[$(pr 3 fix/patch-cc-9.9.9 2026-10-30T11:00:00Z "$NEW_FIX_SHA")]" "git@github.com:bman654/clodex.git"
fix_case "a fix the clone has never fetched is new" "$(URL 4)" "$FAILED_ON" \
  "[$(pr 4 fix/patch-cc-9.9.8 2026-10-30T12:00:00Z "$UNFETCHED_SHA")]"
fix_case "a fix the tested commit already contains is not new" EMPTY "$FAILED_ON" \
  "[$(pr 2 fix/patch-cc-9.9.9 2026-10-31T09:00:00Z "$OLD_FIX_SHA")]"
fix_case "the tested commit itself is not a new fix" EMPTY "$FAILED_ON" \
  "[$(pr 5 fix/patch-cc-9.9.9 2026-10-31T09:00:00Z "$TESTED_SHA")]"
fix_case "a merged PR from a non-canary branch is not a fix" EMPTY "$FAILED_ON" \
  "[$(pr 6 feature/other 2026-10-30T13:00:00Z "$NEW_FIX_SHA")]"
fix_case "a canary PR closed without merging is not a fix" EMPTY "$FAILED_ON" \
  "[$(pr 1 fix/patch-cc-9.9.9 null "$NEW_FIX_SHA")]"
fix_case "no closed PRs is not a fix"         EMPTY "$FAILED_ON" '[]'
fix_case "an unreachable GitHub is not a fix" EMPTY "$FAILED_ON" FAIL
fix_case "a GitHub error object is not a fix" EMPTY "$FAILED_ON" '{"message":"API rate limit exceeded"}'
fix_case "a passed release is not looked up"  EMPTY \
  "$(jq -n -c --arg sha "$TESTED_SHA" '{versions: {"9.9.9": {status: "pass", clodexSha: $sha}}}')" \
  "[$(pr 3 fix/patch-cc-9.9.9 2026-10-30T11:00:00Z "$NEW_FIX_SHA")]"
[ ! -e "$CURL_LOG" ] && r=0 || r=1
if [ "$r" -eq 0 ]; then pass=$((pass + 1)); printf 'ok   %s\n' "a passed release costs no GitHub request"
else fail=$((fail + 1)); printf 'FAIL %s\n' "a passed release costs no GitHub request"; fi
fix_case "a failure with no tested commit is not looked up" EMPTY '{"versions":{"9.9.9":{"status":"fail"}}}' \
  "[$(pr 3 fix/patch-cc-9.9.9 2026-10-30T11:00:00Z "$NEW_FIX_SHA")]"

# ... and re-opening goes through the real state file, exactly as --retriage would.
reopen_case() { # reopen_case <label> <prev> <merged-pr-or-empty> <version-record-json> <inflight-json> <want-prev> <want-status>
  local got_prev got_status
  read -r got_prev got_status < <(
    STATE_DIR="$TMP/reopen"; STATE_FILE="$STATE_DIR/state.json"; mkdir -p "$STATE_DIR"
    jq -n -c --argjson rec "$4" --argjson inf "$5" '{versions: {"9.9.9": $rec}, inflight: $inf}' > "$STATE_FILE"
    merged_canary_fix_pr() { printf '%s' "$FIX_STUB"; }
    log() { :; }
    PREV="$2" FIX_STUB="$3"
    reopen_failed_release 9.9.9
    printf '%s %s\n' "$PREV" "$(jq -r '.versions["9.9.9"].status' "$STATE_FILE")")
  if [ "$got_prev" = "$6" ] && [ "$got_status" = "$7" ]; then pass=$((pass + 1)); printf 'ok   %s\n' "$1"
  else fail=$((fail + 1)); printf 'FAIL %s -> PREV=%s status=%s (want %s %s)\n' "$1" "$got_prev" "$got_status" "$6" "$7"; fi
}
FAILREC='{"status":"fail"}'
HELDREC='{"status":"fail","investigation":"suppressed","investigationHeldBy":"9.9.8"}'
reopen_case "a merged fix re-opens the failed release for testing" fail https://x/pull/2 "$FAILREC" null retriage retriage
reopen_case "an unmerged fix leaves the failed release closed"      fail ""               "$FAILREC" null fail     fail
reopen_case "only a failed release is re-opened"                    pass https://x/pull/2 "$FAILREC" null pass     fail
reopen_case "a release held back by another investigation re-opens once it is over" \
  fail "" "$HELDREC" null retriage retriage
reopen_case "a release held back by another investigation waits while it still runs" \
  fail "" "$HELDREC" '{"version":"9.9.8","threadId":"t-1"}' fail fail
reopen_case "a release held back by its own investigation does not get a second one" \
  fail "" '{"status":"fail","investigation":"suppressed","investigationHeldBy":"9.9.9"}' null fail fail

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

# 9. Four platforms fail from one shared entry-name error while macOS stays unaffected.
write_matrix \
  "darwin-arm64:host:pass" "darwin-x64:probe:pass" \
  "linux-x64:probe:fail:the entry module was not recognized by tweakcc" \
  "linux-arm64:container:fail:the entry module was not recognized by tweakcc" \
  "linux-x64-musl:probe:fail:the entry module was not recognized by tweakcc" \
  "linux-arm64-musl:container:fail:the entry module was not recognized by tweakcc" \
  "win32-x64:probe:pass" "win32-arm64:probe:pass"

matrix_check "Linux entry drift: failing platforms" \
  "linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl" "$(matrix_platforms fail)"
matrix_check "Linux entry drift: host is unaffected" "pass" "$(matrix_status_of darwin-arm64)"
matrix_check "Linux entry drift: 4 of 8 failed" "4 8" "$(matrix_count fail) $(matrix_total)"
# One cause reported by four platforms must collapse to ONE line — the alert is read on a phone.
matrix_check "Linux entry drift: one shared cause is one line" \
  "- the entry module was not recognized by tweakcc [linux-x64, linux-arm64, linux-x64-musl, linux-arm64-musl]" \
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
MATRIX_SITES='{"compact-prompt-markers":"OK","published-content":"OK","PATCH 1: a":"OK","PATCH 3: b":"OK","PATCH 7: c":"SKIP","PATCH 9: d":"OK"}' \
  write_matrix "$HOST:host:pass"
matrix_check "applied counts OK patch sites only, not SKIP or probe checks" "3" \
  "$(matrix_applied_sites "$HOST")"
matrix_check "reported counts patch sites only, not probe checks" "4" "$(matrix_total_sites "$HOST")"
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
MECHANISM_CHECKS='[{"name":"pristine-parses","ok":true,"detail":"1837 Bun modules"},
                   {"name":"entry-recognized","ok":true,"detail":"tweakcc recognizes a module in this build"},
                   {"name":"read-content","ok":true,"detail":"28147627 bytes of JavaScript"},
                   {"name":"compact-prompt-markers","ok":true,"detail":"both strict compaction prompt markers are present"},
                   {"name":"published-content","ok":true,"detail":"byte-for-byte"}]'

# write_probe_json <file> <verdict> <patch-sites-json> [reasons-json] [extra-check-json]
write_probe_json() {
  jq -n --argjson checks "$MECHANISM_CHECKS" --arg verdict "$2" --argjson sites "$3" \
        --argjson reasons "${4:-[]}" --argjson extra "${5:-null}" \
    '{label: "win32-arm64", format: "pe", entryModuleName: "/$bunfs/root/cli",
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

# A host/container patch can pass without observing prompt drift, so an older probe that omits the
# exact-marker result cannot be accepted as the prerequisite for either execution leg.
jq 'del(.checks[] | select(.name == "compact-prompt-markers"))' \
  "$TMP/probe-ok.json" > "$TMP/probe-no-compact-markers.json"
leg_reset
evaluate_probe_leg win32-arm64 "$TMP/probe-no-compact-markers.json" 0 "$TMP/probe.stderr" >/dev/null
matrix_check "a probe with no compaction-marker result is never a pass" "error" "$LEG_STATUS"
case "$LEG_REASONS" in
  *"prompt drift was not checked"*)
    pass=$((pass + 1)); printf 'ok   %s\n' "a probe with no compaction-marker result names the coverage gap" ;;
  *)
    fail=$((fail + 1)); printf 'FAIL a probe with no compaction-marker result says why — got: %s\n' "$LEG_REASONS" ;;
esac

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

# 19c. Every mode runs the probe. Host/container then add execution evidence without replacing the
# probe's marker verdict. Stubs drive the real dispatcher and merger; no binary or Docker is needed.
exercise_leg_dispatch() { # exercise_leg_dispatch <mode> [probe-status] [execution-status]
  local mode="$1" STUB_PROBE_STATUS="${2:-pass}" STUB_EXECUTION_STATUS="${3:-pass}"
  (
    CALLS=""
    run_leg_probe() {
      CALLS="${CALLS:+$CALLS,}probe"
      leg_reset
      LEG_STATUS="$STUB_PROBE_STATUS"
      case "$STUB_PROBE_STATUS" in
        pass) LEG_REASONS="" ;;
        fail) LEG_REASONS="- compact prompt marker(s) missing: end" ;;
        error) LEG_REASONS="- the probe produced no usable result" ;;
      esac
      LEG_SITES='{"compact-prompt-markers":"FAIL","published-content":"OK","PATCH 10: child network environment":"FAIL"}'
      [ "$STUB_PROBE_STATUS" != "pass" ] || LEG_SITES='{"compact-prompt-markers":"OK","published-content":"OK","PATCH 10: child network environment":"OK"}'
      LEG_MARKERS='["ccpatch:probe"]'
      LEG_DETAIL='{"format":"elf","sourceBytes":28147627}'
    }
    run_leg_host() {
      CALLS="${CALLS:+$CALLS,}host"
      leg_reset
      LEG_STATUS="$STUB_EXECUTION_STATUS"
      LEG_REASONS="$( [ "$STUB_EXECUTION_STATUS" = "pass" ] || printf '%s\n' '- host patch failed' )"
      LEG_SITES='{"PATCH 10: child network environment":"OK"}'
      LEG_MARKERS='["ccpatch:child-network-env"]'
      LEG_DETAIL='{"patchedVersion":"2.1.261"}'
    }
    run_leg_container() {
      CALLS="${CALLS:+$CALLS,}container"
      leg_reset
      LEG_STATUS="$STUB_EXECUTION_STATUS"
      LEG_REASONS="$( [ "$STUB_EXECUTION_STATUS" = "pass" ] || printf '%s\n' '- container patch failed' )"
      LEG_SITES='{"PATCH 10: child network environment":"OK"}'
      LEG_MARKERS='["ccpatch:child-network-env"]'
      LEG_DETAIL='{"image":"node:24-bookworm"}'
    }

    run_platform_leg test-platform 2.1.261 "$mode"
    jq -n -c --arg calls "$CALLS" --arg status "$LEG_STATUS" --arg reasons "$LEG_REASONS" \
      --argjson sites "$LEG_SITES" --argjson markers "$LEG_MARKERS" --argjson detail "$LEG_DETAIL" \
      '{calls: $calls, status: $status, reasons: $reasons, sites: $sites,
        markers: $markers, detail: $detail}'
  )
}

DISPATCH="$(exercise_leg_dispatch host)"
matrix_check "a host build is probed before it is patched" "probe,host" \
  "$(printf '%s' "$DISPATCH" | jq -r '.calls')"
matrix_check "a host result retains the compaction-marker check" "OK" \
  "$(printf '%s' "$DISPATCH" | jq -r '.sites["compact-prompt-markers"]')"
matrix_check "a host result keeps probe and execution patch-site verdicts distinct" "OK OK" \
  "$(printf '%s' "$DISPATCH" | jq -r '.sites["probe:PATCH 10: child network environment"] + " " + .sites["PATCH 10: child network environment"]')"
matrix_check "a host result retains probe details beside execution details" "elf 2.1.261" \
  "$(printf '%s' "$DISPATCH" | jq -r '.detail.probe.format + " " + .detail.patchedVersion')"

DISPATCH="$(exercise_leg_dispatch container)"
matrix_check "a container build is probed before it is patched" "probe,container" \
  "$(printf '%s' "$DISPATCH" | jq -r '.calls')"
matrix_check "a container result retains the compaction-marker check" "OK" \
  "$(printf '%s' "$DISPATCH" | jq -r '.sites["compact-prompt-markers"]')"

DISPATCH="$(exercise_leg_dispatch probe)"
matrix_check "a probe-only build runs exactly one probe" "probe" \
  "$(printf '%s' "$DISPATCH" | jq -r '.calls')"

DISPATCH="$(exercise_leg_dispatch host fail pass)"
matrix_check "a marker failure survives a successful host patch" "fail" \
  "$(printf '%s' "$DISPATCH" | jq -r '.status')"
matrix_check "a failed probe site is not overwritten by a successful host site" "FAIL OK" \
  "$(printf '%s' "$DISPATCH" | jq -r '.sites["probe:PATCH 10: child network environment"] + " " + .sites["PATCH 10: child network environment"]')"
case "$(printf '%s' "$DISPATCH" | jq -r '.reasons')" in
  *"compact prompt marker(s) missing: end"*)
    pass=$((pass + 1)); printf 'ok   %s\n' "a marker failure keeps its missing-marker reason" ;;
  *)
    fail=$((fail + 1)); printf 'FAIL a marker failure lost its reason — got: %s\n' "$DISPATCH" ;;
esac

DISPATCH="$(exercise_leg_dispatch host error pass)"
matrix_check "a probe error survives a successful host patch" "error" \
  "$(printf '%s' "$DISPATCH" | jq -r '.status')"
case "$(printf '%s' "$DISPATCH" | jq -r '.reasons')" in
  *"CANARY INFRASTRUCTURE: the probe produced no usable result"*)
    pass=$((pass + 1)); printf 'ok   %s\n' "a merged probe error identifies itself as infrastructure" ;;
  *)
    fail=$((fail + 1)); printf 'FAIL a merged probe error was not tagged — got: %s\n' "$DISPATCH" ;;
esac

DISPATCH="$(exercise_leg_dispatch host error fail)"
matrix_check "an execution failure outranks a probe error" "fail" \
  "$(printf '%s' "$DISPATCH" | jq -r '.status')"
printf '%s\n' "$DISPATCH" | jq -c \
  '. + {platform:"test-platform",mode:"host",downgraded:false,binary:"",tarball:""}' > "$MATRIX"
matrix_check "a probe error is excluded from grouped release evidence" \
  "- host patch failed [test-platform]" "$(matrix_reason_groups)"
matrix_check "a probe error retained in a failed row reaches infrastructure notes" \
  "- the probe produced no usable result" "$(matrix_error_notes)"

# Marker drift breaks OpenAI compaction, not binary patching. Human alerts must preserve that
# distinction, including when an infrastructure failure from the execution tier shares the row.
MARKER_REASON="Compaction-prompt drift is not a patch failure: no patch site is broken"
MATRIX_SITES='{"compact-prompt-markers":"FAIL","published-content":"OK"}' \
  write_matrix "darwin-arm64:host:fail:$MARKER_REASON" "win32-x64:probe:fail:$MARKER_REASON"
EXTRA_REASONS=""
if only_compact_prompt_drift_failed; then
  pass=$((pass + 1)); printf 'ok   %s\n' "marker-only failures get their own human alert category"
else
  fail=$((fail + 1)); printf 'FAIL %s\n' "marker-only failures get their own human alert category"
fi
EXTRA_REASONS="- on win32-x64, PATCH 5 changed from OK to SKIP
"
if only_compact_prompt_drift_failed; then
  fail=$((fail + 1)); printf 'FAIL %s\n' "a baseline regression vetoes the marker-only human alert"
else
  pass=$((pass + 1)); printf 'ok   %s\n' "a baseline regression vetoes the marker-only human alert"
fi
EXTRA_REASONS=""
case "$(matrix_coverage_brief)" in
  *"compaction prompt marker check failed"*"native execution not checked"*)
    pass=$((pass + 1)); printf 'ok   %s\n' "a failed probe row names the prompt marker check" ;;
  *)
    fail=$((fail + 1)); printf 'FAIL marker failure coverage label — got: %s\n' "$(matrix_coverage_brief)" ;;
esac
matrix_check "marker drift headline does not call it a patch break" \
  ":warning: *Claude Code 2.1.999 changed its compaction prompt* on 2 of 8 builds" \
  "$(compact_prompt_drift_headline 2.1.999 2 8)"
case "$(compact_prompt_drift_impact)" in
  *"does not mean \`clodex patch\` is broken"*"no patch site failed"*'Prompt is too long'*"updated prompt markers"*)
    pass=$((pass + 1)); printf 'ok   %s\n' "marker drift impact explains the real user risk without prescribing rollback" ;;
  *)
    fail=$((fail + 1)); printf 'FAIL marker drift impact — got: %s\n' "$(compact_prompt_drift_impact)" ;;
esac

MATRIX_SITES='{"compact-prompt-markers":"FAIL","PATCH 1: Agent tool model enum":"FAIL"}' \
  write_matrix "darwin-arm64:host:fail:$MARKER_REASON"
if matrix_failures_are_compact_prompt_drift_only; then
  fail=$((fail + 1)); printf 'FAIL %s\n' "a patch-site failure cannot use the marker-only alert"
else
  pass=$((pass + 1)); printf 'ok   %s\n' "a patch-site failure cannot use the marker-only alert"
fi

jq -n -c --arg r "- $MARKER_REASON
- CANARY INFRASTRUCTURE: host execution unavailable
" \
  '{platform:"darwin-arm64",mode:"host",status:"fail",reasons:$r,binary:"",tarball:"",
    downgraded:false,sites:{"compact-prompt-markers":"FAIL"},markers:[],detail:{}}' > "$MATRIX"
if matrix_failures_are_compact_prompt_drift_only; then
  pass=$((pass + 1)); printf 'ok   %s\n' "infrastructure evidence does not recategorize marker drift as a patch break"
else
  fail=$((fail + 1)); printf 'FAIL %s\n' "infrastructure evidence does not recategorize marker drift as a patch break"
fi

# Render the real agent-facing prompt with stdin closed. The jq file argument must stay in the
# substitution: when it was split onto the next shell line, jq read stdin and rendered an empty
# verification loop under launchd (or hung forever on an interactive --retriage).
MATRIX_SITES='{"compact-prompt-markers":"FAIL","published-content":"OK"}' \
  write_matrix "darwin-arm64:host:fail:$MARKER_REASON" "win32-x64:probe:fail:$MARKER_REASON"
VERSION=2.1.999
MAIN_SHA=1234567890abcdef
MAIN_SUBJECT="test canary"
BASE_VERSION=2.1.998
WORK="$TMP/triage-work"
REPO_DIR="$TMP/triage-repo"
TRIAGE_PROMPT="$(investigation_prompt "$VERSION" "- $MARKER_REASON" "$TMP/run.log" \
                   "$TMP/clodex-canary-$VERSION" "fix/patch-cc-$VERSION" </dev/null 2>/dev/null)"
prompt_has() { # prompt_has <label> <substring>
  case "$TRIAGE_PROMPT" in
    *"$2"*) pass=$((pass + 1)); printf 'ok   %s\n' "$1" ;;
    *) fail=$((fail + 1)); printf 'FAIL %s — prompt lacks: %s\n' "$1" "$2" ;;
  esac
}
prompt_has "the prompt names the worktree the thread was started in" \
  "already runs in a git worktree made for it: $TMP/clodex-canary-$VERSION, on branch
  fix/patch-cc-$VERSION, at the exact origin/main commit the canary tested ($MAIN_SHA)"
prompt_has "the verification loop runs against that worktree" \
  "do $WORK/repro.sh \$p $TMP/clodex-canary-$VERSION; done"
prompt_has "the prompt keeps the branch prefix the merge is looked up by" \
  "the fix/patch-cc- prefix, and once one merges it re-tests the newest Claude Code"
prompt_has "the PR's Slack message comes before the turn-ending watch" \
  "open a PR against main with \`gh pr create\`, and send the Slack message with its"
prompt_has "watching the PR is the last action of the turn" \
  "Then, as your last action, \`watch_pull_request\` and end"
prompt_has "the prompt leaves the re-test to the canary" "Do not
   run the canary yourself;"
prompt_has "the prompt forbids archiving the thread" "Never archive or settle this thread"
case "$TRIAGE_PROMPT" in
  *"for p in darwin-arm64 win32-x64;"*)
    pass=$((pass + 1)); printf 'ok   %s\n' "the generated verification loop includes every downloaded matrix row" ;;
  *)
    fail=$((fail + 1)); printf 'FAIL generated verification loop — got:\n%s\n' "$TRIAGE_PROMPT" ;;
esac
case "$TRIAGE_PROMPT" in
  *'A `compact-prompt-markers` failure is NOT a patch failure'*"bundle-reader"*)
    pass=$((pass + 1)); printf 'ok   %s\n' "generated triage distinguishes marker drift from a patch failure" ;;
  *)
    fail=$((fail + 1)); printf 'FAIL generated marker triage branch is missing\n' ;;
esac

# A container executes and mutates its install after the universal probe. Its generated MODE=probe
# reproduction must therefore prefer clodex's pristine backup, not re-probe the patched survivor.
REPRO_OUTPUT="$(
  (
    WORK="$TMP/repro-marker"
    VERSION=2.1.261
    REPO_DIR="$WORK/repo"
    MATRIX="$WORK/matrix.jsonl"
    mkdir -p "$WORK/clodex-home" "$WORK/linux-arm64/install" \
      "$WORK/linux-arm64/tweakcc" "$REPO_DIR/scripts" "$REPO_DIR/node_modules/tweakcc"
    printf '{}\n' > "$WORK/clodex-home/config.json"
    printf 'patched\n' > "$WORK/linux-arm64/install/claude"
    printf 'pristine\n' > "$WORK/linux-arm64/tweakcc/native-binary.backup"
    jq -n -c \
      '{platform:"linux-arm64",mode:"container",status:"fail",reasons:"marker missing",
        binary:"",tarball:"",downgraded:false,sites:{"compact-prompt-markers":"FAIL"},
        markers:[],detail:{image:"node:24-bookworm",dockerPlatform:"linux/arm64"}}' > "$MATRIX"
    cat > "$REPO_DIR/scripts/probe-patch-mechanism.mjs" <<'PROBE'
import { readFileSync } from 'node:fs';
import path from 'node:path';
const binary = process.argv[2];
const sandbox = path.dirname(path.dirname(binary));
const expected = {
  HOME: path.join(sandbox, 'home'),
  CLODEX_HOME: path.join(sandbox, 'clodex-home'),
  TWEAKCC_CONFIG_DIR: path.join(sandbox, 'tweakcc'),
  TWEAKCC_CC_INSTALLATION_PATH: binary,
};
const isolated = Object.entries(expected).every(([key, value]) => process.env[key] === value)
  && ['CLODEX_TRACE', 'FORCE_COLOR', 'CLICOLOR_FORCE'].every(key => !(key in process.env));
console.log(`probe-input=${readFileSync(binary, 'utf8').trim()}`);
console.log(`probe-environment=${isolated ? 'isolated' : 'leaked'}`);
PROBE
    write_repro_script >/dev/null
    CLODEX_TRACE=dirty FORCE_COLOR=1 CLICOLOR_FORCE=1 \
      MODE=probe "$WORK/repro.sh" linux-arm64 "$REPO_DIR"
  )
)"
case "$REPRO_OUTPUT" in
  *"probe-input=pristine"*)
    pass=$((pass + 1)); printf 'ok   %s\n' "a container probe reproduction starts from its pristine backup" ;;
  *)
    fail=$((fail + 1)); printf 'FAIL container probe reproduction used the wrong bytes — got: %s\n' "$REPRO_OUTPUT" ;;
esac
case "$REPRO_OUTPUT" in
  *"probe-environment=isolated"*)
    pass=$((pass + 1)); printf 'ok   %s\n' "a probe reproduction fences home, config and inherited diagnostics" ;;
  *)
    fail=$((fail + 1)); printf 'FAIL probe reproduction leaked its environment — got: %s\n' "$REPRO_OUTPUT" ;;
esac

# 19d. The whole incident, end to end at the matrix level: 2.1.238 lost PATCH 5 on the two arm64
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

# Every one of these goes through $CANARY_VERDICT_FILTER, the expression the script itself writes
# verdicts with. Transcribing the clause under test into the case instead is how the real filter got
# changed with all of these still green.
record_verdict() { # record_verdict <version> <status> <baseline-platforms-json>
  state_update "$CANARY_VERDICT_FILTER" \
    --arg v "$1" --arg st "$2" --argjson base "$3" \
    --arg t "" --argjson te 0 --arg sha "" --arg l "" --arg fp "" --arg n "" --argjson pstatus '{}'
}

# A platform that could not run this time must keep the baseline it had. Replacing rather than
# merging is how one Docker outage used to erase a platform's history.
state_set '{"versions":{},"baseline":{"version":"1.0.0","platforms":{
  "linux-x64":{"mode":"probe","sites":{"a":"OK"},"version":"1.0.0"},
  "win32-x64":{"mode":"probe","sites":{"b":"OK"},"version":"1.0.0"}}},"pending":{},"deferred":{}}'
record_verdict "2.0.0" "pass" '{"linux-x64":{"mode":"probe","sites":{"a":"OK"},"version":"2.0.0"}}'
matrix_check "a platform that ran advances its baseline" "2.0.0" "$(state_get '.baseline.platforms["linux-x64"].version')"
matrix_check "a platform that did not run keeps its baseline" "1.0.0" "$(state_get '.baseline.platforms["win32-x64"].version')"
matrix_check "no platform is dropped from the baseline" "linux-x64 win32-x64" \
  "$(state_get '.baseline.platforms | keys | join(" ")')"

# "Last release clean on every build" may only be claimed by a fully covered run.
state_set '{"versions":{},"baseline":null,"pending":{},"deferred":{}}'
record_verdict "3.0.0" "partial" '{}'
matrix_check "a partial run claims no known-good release" "" "$(state_get '.lastCompleteVersion // ""')"
record_verdict "3.0.1" "pass" '{}'
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

# 21b. A baseline entry recorded before the leg-mode field existed cannot be compared at all. The
#      two modes' check names are disjoint sets — patch sites for host/container, probe check names
#      for a probe — so an entry whose mode is unknown cannot be placed in either. Comparing one
#      anyway reports every name in the other set as dropped: it invented 16 lost probe checks on a
#      container leg that had never run as a probe, on two consecutive runs. A missing
#      configFingerprint only leaves the config unknown and can fall back to comparing; a missing
#      mode makes the comparison itself meaningless, so it re-takes the baseline instead.
mode_case() { # mode_case <name> <base-entry-json> <current-mode> <expect: compare|skip>
  local name="$1" base_mode cur="$3" want="$4" got
  base_mode="$(printf '%s' "$2" | jq -r '.mode // ""')"
  if [ -z "$base_mode" ]; then got=skip
  elif [ "$base_mode" != "$cur" ]; then got=skip
  else got=compare; fi
  matrix_check "$name" "$want" "$got"
}
mode_case "same mode compares"        '{"mode":"container"}' container compare
mode_case "changed mode skips"        '{"mode":"probe"}'     container skip
mode_case "a pre-mode entry is re-taken, not compared" '{}'  container skip

# 22. The container leg must tell a patch that HUNG from a container that never got that far —
#     one is a broken release, the other is the canary's own infrastructure.
hang_case() { # hang_case <name> <started-marker-exists> <expect>
  local name="$1" started="$2" got
  if [ "$started" = "yes" ]; then got=fail; else got=error; fi
  matrix_check "$name" "$3" "$got"
}
hang_case "a patch that started and hung is a failure" yes fail
hang_case "a container that never started is an error" no  error

# 23. The investigation must actually START, with its prompt, in the worktree made for it. Under
#     `claude --bg` the variadic --add-dir once swallowed the prompt: the session sat idle and blocked
#     every later investigation for 24h. A T3 thread with no prompt would instead read as finished,
#     leaving the release failing with nobody on it. The prompt now goes in on stdin, and this
#     stand-in records exactly what reached it.
ARGV_LOG="$TMP/argv.log"; STDIN_LOG="$TMP/stdin.log"; export ARGV_LOG STDIN_LOG
FAKET3="$TMP/fake-t3cli-start"
LOST_THREADS="$TMP/lost-threads.json"; export LOST_THREADS
cat > "$FAKET3" <<'FAKEEOF'
#!/usr/bin/env bash
if [ "$1" = list ]; then
  if [ "${FAKE_T3_MODE:-ok}" = fail ]; then exit 1; fi
  cat "$LOST_THREADS" 2>/dev/null || printf '[]\n'; exit 0
fi
: > "$ARGV_LOG"
for a in "$@"; do printf '%s\n' "$a" >> "$ARGV_LOG"; done
cat > "$STDIN_LOG"
title=""; while [ $# -gt 0 ]; do [ "$1" = --title ] && title="$2"; shift; done
case "${FAKE_T3_MODE:-ok}" in
  ok)   printf '{"messageId":"m-1","project":{"id":"p-1"},"threadId":"t-123"}\n' ;;
  noid) printf '{}\n' ;;
  fail) printf 'cannot reach T3 Code\n' >&2; exit 1 ;;
  refused) printf 'start refused\n' >&2; exit 1 ;;
  # T3 Code created the thread, then the reply was lost.
  lost) jq -n -c --arg t "$title" '[{id: "t-lost", title: $t, status: "running"}]' > "$LOST_THREADS"
        printf 'connection lost\n' >&2; exit 1 ;;
esac
FAKEEOF
chmod +x "$FAKET3"

# A working copy, and a canary clone one commit ahead of it: the commit under test is not in the
# working copy until the launch fetches it, as on a real run.
LAUNCH_ROOT="$TMP/launch"; mkdir -p "$LAUNCH_ROOT"
git -C "$LAUNCH_ROOT" init -q clodex
git -C "$LAUNCH_ROOT/clodex" -c user.name=t -c user.email=t@t commit -q --allow-empty -m base
git clone -q "$LAUNCH_ROOT/clodex" "$LAUNCH_ROOT/canary-clone"
git -C "$LAUNCH_ROOT/canary-clone" -c user.name=t -c user.email=t@t commit -q --allow-empty -m tested

MARKER="PROMPT-MUST-SURVIVE"
T3CLI_BIN="$FAKET3"
CLODEX_WORKING_COPY="$LAUNCH_ROOT/clodex"
REPO_DIR="$LAUNCH_ROOT/canary-clone"
MAIN_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
STATE_LOG="$TMP/state-update.log"
opt_launch=1
investigation_prompt() { printf '%s\n' "$MARKER"; }
state_read()   { printf '{}\n'; }
state_update() { printf '%s\n' "$*" >> "$STATE_LOG"; }
slack()        { LAST_SLACK="$*"; return 0; }
log()          { :; }

# Each condition is folded into r with `&& r=0 || r=1`, never tested through `$?` after a bare
# `[ ]`: under set -e a failing bare test would end the self-test instead of reporting the failure.
launch_check() { # launch_check <label> <0-if-it-held>
  if [ "$2" -eq 0 ]; then pass=$((pass + 1)); printf 'ok   %s\n' "$1"
  else fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; fi
}
argv_pair() { grep -A1 -x -- "$1" "$ARGV_LOG" 2>/dev/null | sed -n 2p; }

WT="$LAUNCH_ROOT/clodex-canary-9.9.9"
# What a human last fetched in the working copy is theirs; creating the worktree must not move it.
git -C "$CLODEX_WORKING_COPY" fetch -q "$REPO_DIR" HEAD:refs/heads/human-topic 2>/dev/null || true
git -C "$CLODEX_WORKING_COPY" fetch -q "$CLODEX_WORKING_COPY" HEAD
HUMAN_FETCH_HEAD="$(git -C "$CLODEX_WORKING_COPY" rev-parse FETCH_HEAD)"
set +e
launch_investigation 9.9.9 "some reason" "$TMP/x.log" >/dev/null 2>&1; LAUNCH_RC=$?
set -e
launch_check "a clean launch reports success" "$LAUNCH_RC"
[ "$(cat "$STDIN_LOG" 2>/dev/null)" = "$MARKER" ] && r=0 || r=1; launch_check "the prompt reaches t3cli intact on stdin" "$r"
grep -qx -- --stdin "$ARGV_LOG" && r=0 || r=1; launch_check "t3cli is told to read the prompt from stdin" "$r"
[ "$(argv_pair --project)" = "$CLODEX_WORKING_COPY" ] && r=0 || r=1; launch_check "the thread is started in the clodex project" "$r"
[ "$(argv_pair --worktree)" = "$WT" ] && r=0 || r=1; launch_check "the thread is bound to the investigation worktree" "$r"
[ "$(git -C "$WT" rev-parse HEAD 2>/dev/null)" = "$MAIN_SHA" ] && r=0 || r=1
launch_check "the worktree is at the exact commit the canary tested" "$r"
[ "$(git -C "$WT" branch --show-current 2>/dev/null)" = "fix/patch-cc-9.9.9" ] && r=0 || r=1
launch_check "the worktree is on its own fix branch" "$r"
[ "$(git -C "$CLODEX_WORKING_COPY" rev-parse FETCH_HEAD)" = "$HUMAN_FETCH_HEAD" ] && r=0 || r=1
launch_check "creating the worktree leaves the working copy's FETCH_HEAD alone" "$r"
[ "$THREAD_ID" = "t-123" ] && grep -q -- '--arg i t-123' "$STATE_LOG" && grep -q -- "--arg w $WT" "$STATE_LOG" && r=0 || r=1
launch_check "the thread id and worktree are recorded as in flight" "$r"

# The same release failing again after a re-triage finds its first investigation's names taken.
set +e
launch_investigation 9.9.9 "again" "$TMP/x.log" >/dev/null 2>&1; LAUNCH_RC=$?
set -e
WT2="$(argv_pair --worktree)"
[ "$LAUNCH_RC" -eq 0 ] && [ "${WT2#"$WT"-}" != "$WT2" ] && [ -d "$WT2" ] &&
  [ "$(git -C "$WT2" branch --show-current)" = "fix/patch-cc-9.9.9${WT2#"$WT"}" ] && r=0 || r=1
launch_check "a second investigation of one release gets a worktree and branch of its own" "$r"

# An empty prompt must be refused outright, before any worktree or thread exists.
investigation_prompt() { printf '   \n'; }
LAST_SLACK=""; rm -f "$ARGV_LOG"
if launch_investigation 9.9.8 "r" "$TMP/x.log" >/dev/null 2>&1; then LAUNCH_RC=0; else LAUNCH_RC=1; fi
[ "$LAUNCH_RC" -eq 1 ] && case "$LAST_SLACK" in *EMPTY*) true ;; *) false ;; esac &&
  [ ! -e "$ARGV_LOG" ] && [ ! -e "$LAUNCH_ROOT/clodex-canary-9.9.8" ] && r=0 || r=1
launch_check "an empty prompt is refused and reported, and nothing is created" "$r"
investigation_prompt() { printf '%s\n' "$MARKER"; }

# A start that fails, or succeeds without a thread id, must not be recorded as in flight.
LAST_SLACK=""; rm -f "$STATE_LOG"; WORK="$TMP/launch-sandbox"
if FAKE_T3_MODE=fail launch_investigation 9.9.7 "r" "$TMP/x.log" >/dev/null 2>&1; then LAUNCH_RC=0; else LAUNCH_RC=1; fi
[ "$LAUNCH_RC" -eq 1 ] && [ "$LAUNCH_OUTCOME" = uncertain ] &&
  grep -q '^.uncertainLaunch = ' "$STATE_LOG" && grep -q -- "--arg s $WORK " "$STATE_LOG" &&
  ! grep -q '^.inflight = ' "$STATE_LOG" &&
  case "$LAST_SLACK" in *"t3cli start exit 1"*"could not be asked"*) true ;; *) false ;; esac && r=0 || r=1
launch_check "a failed start T3 Code cannot be asked about is marked uncertain, not in flight" "$r"
LAST_SLACK=""; rm -f "$STATE_LOG"
if FAKE_T3_MODE=refused launch_investigation 9.9.2 "r" "$TMP/x.log" >/dev/null 2>&1; then LAUNCH_RC=0; else LAUNCH_RC=1; fi
[ "$LAUNCH_RC" -eq 1 ] && [ ! -e "$STATE_LOG" ] && [ "$LAUNCH_OUTCOME" = "not started" ] &&
  case "$LAST_SLACK" in *"t3cli start exit 1"*) true ;; *) false ;; esac && r=0 || r=1
launch_check "a failed start with no thread to show for it is reported as not started" "$r"
LAST_SLACK=""
if FAKE_T3_MODE=noid launch_investigation 9.9.6 "r" "$TMP/x.log" >/dev/null 2>&1; then LAUNCH_RC=0; else LAUNCH_RC=1; fi
[ "$LAUNCH_RC" -eq 1 ] && [ ! -e "$STATE_LOG" ] && [ "$LAUNCH_OUTCOME" = uncertain ] &&
  case "$LAST_SLACK" in *"no thread id"*) true ;; *) false ;; esac && r=0 || r=1
launch_check "a start with no thread id is reported and nothing is recorded" "$r"

# A start whose reply was lost, for a thread T3 Code did create, is found by its title and tracked.
rm -f "$STATE_LOG" "$LOST_THREADS"; THREAD_ID=""
if FAKE_T3_MODE=lost launch_investigation 9.9.3 "r" "$TMP/x.log" >/dev/null 2>&1; then LAUNCH_RC=0; else LAUNCH_RC=1; fi
rm -f "$LOST_THREADS"
[ "$LAUNCH_RC" -eq 0 ] && [ "$THREAD_ID" = "t-lost" ] && grep -q -- '--arg i t-lost' "$STATE_LOG" && r=0 || r=1
launch_check "a thread whose start reply was lost is found by its title and tracked" "$r"

# A worktree that cannot be made (here: the tested commit is not in the canary clone) is reported,
# and no thread is started without one.
LAST_SLACK=""; rm -f "$ARGV_LOG" "$STATE_LOG"
REAL_MAIN_SHA="$MAIN_SHA"; MAIN_SHA=0123456789abcdef0123456789abcdef01234567
if launch_investigation 9.9.4 "r" "$TMP/x.log" >/dev/null 2>&1; then LAUNCH_RC=0; else LAUNCH_RC=1; fi
MAIN_SHA="$REAL_MAIN_SHA"
[ "$LAUNCH_RC" -eq 1 ] && [ ! -e "$ARGV_LOG" ] && [ ! -e "$STATE_LOG" ] &&
  case "$LAST_SLACK" in *"creating the worktree"*) true ;; *) false ;; esac && r=0 || r=1
launch_check "a worktree that cannot be created is reported and no thread is started" "$r"

# An earlier launch nobody could confirm blocks the next one until T3 Code can say what happened.
PENDING='{"uncertainLaunch":{"version":"9.9.0","threadTitle":"clodex-patch-canary 9.9.0 202610300000","worktree":"/w","branch":"b"}}'
pending_case() { # pending_case <label> <fake-mode> <list-json-or-empty> <want-rc> <want-start yes|no> <state-update-pattern-or-NONE>
  local rc started=no
  rm -f "$ARGV_LOG" "$STATE_LOG"
  if [ -n "$3" ]; then printf '%s\n' "$3" > "$LOST_THREADS"; else rm -f "$LOST_THREADS"; fi
  state_read() { printf '%s\n' "$PENDING"; }
  if FAKE_T3_MODE="$2" launch_investigation "9.9.1$RANDOM" "r" "$TMP/x.log" >/dev/null 2>&1; then rc=0; else rc=1; fi
  state_read() { printf '{}\n'; }
  rm -f "$LOST_THREADS"
  [ -e "$ARGV_LOG" ] && started=yes
  [ "$rc" -eq "$4" ] && [ "$started" = "$5" ] &&
    { [ "$6" = NONE ] && [ ! -e "$STATE_LOG" ] || grep -q -- "$6" "$STATE_LOG" 2>/dev/null; } && r=0 || r=1
  launch_check "$1" "$r"
}
pending_case "an unconfirmed launch blocks the next while T3 Code still cannot be asked" fail "" 1 no NONE
pending_case "an unconfirmed launch that did start and still runs is adopted, not duplicated" ok \
  '[{"id":"t-was-lost","title":"clodex-patch-canary 9.9.0 202610300000","status":"running"}]' 1 no \
  '^.inflight = (.uncertainLaunch + {threadId: $i}) | del(.uncertainLaunch) --arg i t-was-lost$'
pending_case "an unconfirmed launch that is already over is cleared and the next goes ahead" ok \
  '[{"id":"t-was-lost","title":"clodex-patch-canary 9.9.0 202610300000","status":"completed"}]' 0 yes \
  '^del(.uncertainLaunch)$'
pending_case "an unconfirmed launch that never happened is cleared and the next goes ahead" ok '[]' 0 yes \
  '^del(.uncertainLaunch)$'

# One investigation at a time: a tracked one blocks the launch before anything is created.
state_read() { printf '{"inflight":{"version":"1.0.0","threadId":"t-0"}}\n'; }
rm -f "$ARGV_LOG"
if launch_investigation 9.9.5 "r" "$TMP/x.log" >/dev/null 2>&1; then LAUNCH_RC=0; else LAUNCH_RC=1; fi
[ "$LAUNCH_RC" -eq 1 ] && [ ! -e "$ARGV_LOG" ] && [ ! -e "$LAUNCH_ROOT/clodex-canary-9.9.5" ] && r=0 || r=1
launch_check "a tracked investigation blocks a second launch" "$r"
state_read() { printf '{}\n'; }


# ---------------------------------------------------------------- coverage_gap_action
#
# A run short of full coverage must open with what to DO about it. The first version of the
# notification reported the hole (":warning: not a full all-clear" plus an eight-line platform
# table) without ever saying that Docker Desktop being quit was the whole cause, so the same
# fixable problem read as an unexplained wall of text twice in one evening.

MATRIX="$TMP/matrix.jsonl"
# reasons matters: a leg that could not run always carries one in production, and
# matrix_error_notes reads the disclosure out of it rather than out of the status.
leg_row() { # leg_row <platform> <mode> <status> <downgraded> [reasons]
  jq -n -c --arg p "$1" --arg m "$2" --arg s "$3" --argjson d "$4" --arg r "${5:-}" \
    '{platform: $p, mode: $m, status: $s, reasons: $r, downgraded: $d, sites: {}, markers: []}' >> "$MATRIX"
}
gap_check() { # gap_check <name> <expected-substring-or-EMPTY>
  local name="$1" want="$2" got
  got="$(coverage_gap_action darwin-arm64 6)"
  if [ "$want" = "EMPTY" ]; then
    if [ -z "$got" ]; then pass=$((pass + 1)); printf 'ok   %s\n' "$name"
    else fail=$((fail + 1)); printf 'FAIL %s — expected no action, got:\n%s\n' "$name" "$got"; fi
  else
    case "$got" in
      *"$want"*) pass=$((pass + 1)); printf 'ok   %s\n' "$name" ;;
      *) fail=$((fail + 1)); printf 'FAIL %s — expected to contain %s, got:\n%s\n' "$name" "$want" "$got" ;;
    esac
  fi
}

# Docker quit: the two Linux legs with container images fall back to a probe.
: > "$MATRIX"; opt_platforms=""; opt_container=1
leg_row darwin-arm64 host pass false
leg_row linux-arm64 probe pass true
leg_row linux-arm64-musl probe pass true
gap_check "a Docker outage says to start Docker Desktop" "Start Docker Desktop"
gap_check "a Docker outage names the platforms it cost" "linux-arm64 and linux-arm64-musl"
gap_check "a Docker outage quotes the retry cadence" "every 6h"

# Full coverage: nothing to do, and nothing must be invented.
: > "$MATRIX"; opt_platforms=""; opt_container=1
leg_row darwin-arm64 host pass false
leg_row linux-arm64 container pass false
gap_check "a fully covered run has no action" EMPTY

# --no-container is the operator's own doing, not a daemon that needs starting.
: > "$MATRIX"; opt_platforms=""; opt_container=0
leg_row darwin-arm64 host pass false
leg_row linux-arm64 probe pass true
gap_check "--no-container is reported as the cause it is" "\`--no-container\` was passed"
case "$(coverage_gap_action darwin-arm64 6)" in
  *"Start Docker Desktop"*) fail=$((fail + 1)); printf 'FAIL %s\n' "--no-container does not blame Docker" ;;
  *) pass=$((pass + 1)); printf 'ok   %s\n' "--no-container does not blame Docker" ;;
esac

# A host leg that did not pass is the one hole that must not be buried under the others.
: > "$MATRIX"; opt_platforms=""; opt_container=1
leg_row darwin-arm64 host error false
leg_row linux-arm64 probe pass true
gap_check "a broken host leg is called out" "nothing was established for your machine"
gap_check "a broken host leg does not hide the Docker cause" "Start Docker Desktop"

# A platform package that has not published yet is an untested leg, not a downgrade.
: > "$MATRIX"; opt_platforms=""; opt_container=1
leg_row darwin-arm64 host pass false
leg_row win32-arm64 none error false
gap_check "an untested leg names the platform" "win32-arm64"
gap_check "an untested leg is not blamed on the release" "not the release"

# A --platforms run tested almost nothing; saying "not a full all-clear" without saying why is
# actively misleading, because it reads as a problem with the release.
: > "$MATRIX"; opt_platforms="darwin-arm64"; opt_container=1
leg_row darwin-arm64 host pass false
gap_check "a --platforms debug run says so" "debug run"
opt_platforms=""

# ---------------------------------------------------------------- the notification itself
#
# Through pass_notification_text, the function the script actually posts, rather than through the
# pieces it is built from. A review found that deleting the action line from the message left all
# of the component-level cases green, which is exactly the "tests do not discriminate" failure the
# pr-verification gate puts first.

msg_setup() { # msg_setup <host-status> <linux-legs-downgraded> [extra-soft-note]
  MATRIX="$TMP/msgmatrix.jsonl"; : > "$MATRIX"
  opt_platforms=""; opt_container=1
  # Production shapes only. `downgraded` is not free-form: run_platform_matrix sets it exactly when
  # a platform that HAS a container image was tested by the probe instead, so the container-capable
  # Linux rows must move between container/false and probe/true together. Writing probe+false there
  # staged a "full coverage" matrix the canary can never actually produce, and any assertion about
  # full coverage made against it was about nothing.
  local linux_mode=container
  [ "$2" = true ] && linux_mode=probe
  leg_row darwin-arm64 host "$1" false
  leg_row darwin-x64 probe pass false
  leg_row linux-x64 probe pass false
  leg_row linux-arm64 "$linux_mode" pass "$2"
  leg_row linux-x64-musl probe pass false
  leg_row linux-arm64-musl "$linux_mode" pass "$2"
  leg_row win32-x64 probe pass false
  leg_row win32-arm64 probe pass false
  VERSION=2.1.268; INSTALLED_VERSION=2.1.267; HOST_PLATFORM=darwin-arm64
  MAIN_SHA=665c9a0b5d4ce3137f42812ea45309293c468dcd; REPO_DIR="$PWD"
  HOST_STATUS="$(matrix_status_of "$HOST_PLATFORM")"
  TOTAL_COUNT="$(matrix_total)"; COVERAGE="$(matrix_coverage_line)"
  COVERAGE_COMPLETE=0; coverage_is_complete "$HOST_PLATFORM" && COVERAGE_COMPLETE=1
  DOWNGRADE_NOTES="$(matrix_downgrade_notes)"
  SUBSET_NOTE=""
  SOFT_NOTES=""
  [ -z "${3:-}" ] || SOFT_NOTES="$3
"
  [ -z "$DOWNGRADE_NOTES" ] || SOFT_NOTES="$SOFT_NOTES$DOWNGRADE_NOTES
"
  MSG="$(pass_notification_text)"
}
msg_has() { # msg_has <name> <substring>
  case "$MSG" in *"$2"*) pass=$((pass + 1)); printf 'ok   %s\n' "$1" ;;
    *) fail=$((fail + 1)); printf 'FAIL %s — message was:\n%s\n' "$1" "$MSG" ;; esac
}
msg_lacks() { # msg_lacks <name> <substring>
  case "$MSG" in *"$2"*) fail=$((fail + 1)); printf 'FAIL %s — message was:\n%s\n' "$1" "$MSG" ;;
    *) pass=$((pass + 1)); printf 'ok   %s\n' "$1" ;; esac
}

# Docker quit — the 2.1.268 run that was announced twice with no stated cause.
msg_setup pass true "- linux-arm64 was tested as a probe leg this time and a container leg on 2.1.267."
msg_has "the posted message says what to do" "To close this out:"
msg_has "the posted message names Docker Desktop" "Start Docker Desktop"
msg_lacks "the posted message does not claim an all-clear" "safe to update"
# The action line replaces the duplicate, it does not replace the disclosure: both the per-platform
# table and the unrelated note still have to survive into what is actually sent.
msg_has "the posted message still shows the per-platform coverage" ":warning: *linux-arm64*"
msg_has "the posted message keeps notes the action did not cover" "container leg on 2.1.267"
# Not anchored to where the note would appear: it must not be anywhere in the message, whatever
# order the notes happen to be in. The action line says "Start Docker Desktop", never this phrase,
# so any occurrence at all is the duplicate coming back.
msg_lacks "the posted message does not repeat the Docker note" "Docker was not available"

# Full coverage — the action machinery must stay entirely out of a green message.
msg_setup pass false ""
msg_has "a fully covered run is announced as safe" "safe to update"
msg_lacks "a fully covered run offers no action" "To close this out:"

# A host leg that did not pass may never be dressed up as a release you can take.
msg_setup error true ""
msg_has "a broken host leg withholds the update recommendation" "hold off until a run covers it"
msg_has "a broken host leg says nothing was established" "nothing was established for you"

# A --platforms run tested a subset, so every count in the message is out of that subset. The pass
# path says so in its action line; the FAILURE path has no action line, and a review found it
# announcing "breaks `clodex patch` on 1 of 1 builds" with nothing anywhere saying the other seven
# published builds were never looked at.
msg_setup pass false ""
opt_platforms="darwin-arm64"
SUBSET_NOTE="$(subset_note)"          # computed, not staged: staging it made the case vacuous
SOFT_NOTES="$SUBSET_NOTE
"
MSG="$(pass_notification_text)"
msg_has "a subset run discloses the subset" "limited to darwin-arm64"
msg_has "a subset run says the other builds went untested" "not tested at all"
opt_platforms=""
matrix_check "a normal full run adds no subset note" "" "$(subset_note)"
# --platforms naming every published build covers the release, so it is not a subset run.
opt_platforms="$(printf '%s\n' "$CANARY_PLATFORM_TABLE" | awk -F'|' 'NF{printf "%s,", $1}' | sed 's/,$//')"
matrix_check "--platforms naming every build adds no subset note" "" "$(subset_note)"
opt_platforms="darwin-arm64,linux-x64"
case "$(subset_note)" in *"limited to"*) pass=$((pass + 1)); printf 'ok   %s\n' "a genuine subset still says so" ;;
  *) fail=$((fail + 1)); printf 'FAIL %s\n' "a genuine subset still says so" ;; esac
opt_platforms=""
SUBSET_NOTE=""

# ---------------------------------------------------------------- wiring
#
# The seams between the helpers and the run, which is where the previous round of cases stopped. A
# review proved that disconnecting the subset note from the production note list, or either composer
# from the posting, left all of the helper-level assertions green.

# collect_soft_notes is the only producer of SOFT_NOTES. A disclosure that does not make it in here
# is disclosed in neither notification.
: > "$MATRIX"; opt_platforms=""; opt_container=1
leg_row darwin-arm64 host pass false
leg_row linux-arm64 probe pass true
leg_row win32-arm64 none error false \
  "- claude-code-win32-arm64 has still not published 2.1.268 130 minutes after the other platforms did, so it was not tested
"
SOFT_NOTES=""
collect_soft_notes
soft_has() { case "$SOFT_NOTES" in *"$2"*) pass=$((pass + 1)); printf 'ok   %s\n' "$1" ;;
  *) fail=$((fail + 1)); printf 'FAIL %s — SOFT_NOTES was:\n%s\n' "$1" "$SOFT_NOTES" ;; esac; }
soft_has "the run's notes disclose a downgraded leg" "Docker was not available"
soft_has "the run's notes disclose a leg that could not be tested" "win32-arm64"

# ...including the subset note, which is the failure alert's ONLY disclosure that most of the
# matrix was skipped.
opt_platforms="darwin-arm64"; SOFT_NOTES=""
collect_soft_notes
soft_has "the run's notes disclose a --platforms subset" "limited to darwin-arm64"
opt_platforms=""; SOFT_NOTES=""
collect_soft_notes
case "$SOFT_NOTES" in *"limited to"*) fail=$((fail + 1)); printf 'FAIL %s\n' "a normal run adds no subset note to the run's notes" ;;
  *) pass=$((pass + 1)); printf 'ok   %s\n' "a normal run adds no subset note to the run's notes" ;; esac

# announce_verdict is the seam between a composed message and Slack. Both branches must post, and
# must post what their own composer produced.
POSTED=""
slack() { POSTED="$1"; }
msg_setup pass true ""
REASONS=""
announce_verdict
case "$POSTED" in *"To close this out:"*) pass=$((pass + 1)); printf 'ok   %s\n' "a clean run posts the pass notification" ;;
  *) fail=$((fail + 1)); printf 'FAIL %s — posted:\n%s\n' "a clean run posts the pass notification" "$POSTED" ;; esac

POSTED=""
FAILED_PLATFORMS="linux-x64"; REASONS="- PATCH 5 failed on linux-x64"; NEXT_STEP=":mag: investigating"
BASE_VERSION=2.1.267; COMPACT_PROMPT_DRIFT_ONLY=0; MAIN_SUBJECT="subj"; RUN_LOG="$TMP/r.log"; WORK="$TMP/w"
announce_verdict
case "$POSTED" in *"breaks"*) pass=$((pass + 1)); printf 'ok   %s\n' "a broken release posts the failure alert" ;;
  *) fail=$((fail + 1)); printf 'FAIL %s — posted:\n%s\n' "a broken release posts the failure alert" "$POSTED" ;; esac
case "$POSTED" in *"To close this out:"*) fail=$((fail + 1)); printf 'FAIL %s\n' "the failure alert is not the pass notification" ;;
  *) pass=$((pass + 1)); printf 'ok   %s\n' "the failure alert is not the pass notification" ;; esac

# The failure alert carries the run's notes, which is where a subset or a downgrade is disclosed on
# that path — it has no action line to carry them.
POSTED=""; SOFT_NOTES="- linux-arm64 got the probe instead.
"
announce_verdict
case "$POSTED" in *"linux-arm64 got the probe instead"*) pass=$((pass + 1)); printf 'ok   %s\n' "the failure alert discloses reduced coverage" ;;
  *) fail=$((fail + 1)); printf 'FAIL %s — posted:\n%s\n' "the failure alert discloses reduced coverage" "$POSTED" ;; esac
REASONS=""; SOFT_NOTES=""

# Duplicate --platforms names must not reach the published-platform count and buy a green tick.
: > "$MATRIX"; opt_platforms="darwin-arm64,darwin-arm64"
matrix_check "duplicate --platforms names select one platform" "darwin-arm64" "$(platform_names | tr '\n' ' ' | sed 's/ *$//')"
for _i in 1 2 3 4 5 6 7 8; do leg_row darwin-arm64 host pass false; done
if coverage_is_complete darwin-arm64; then
  fail=$((fail + 1)); printf 'FAIL %s\n' "eight rows for one platform is not full coverage"
else
  pass=$((pass + 1)); printf 'ok   %s\n' "eight rows for one platform is not full coverage"
fi
opt_platforms=""

# ---------------------------------------------------------------- failing under a broken jq
#
# Both of these are about which way the canary breaks when a tool it depends on fails mid-run. It
# may refuse to answer; it may never answer "everything is fine" because it could not tell.

# coverage_is_complete decided the downgrade question with `[ -z "$(jq ...)" ]`, which reads a jq
# that FAILED — no output — as "nothing was downgraded", and returns full coverage. That is a green
# tick issued because the check broke, which is the one direction this function may never fail in.
: > "$MATRIX"; opt_platforms=""; opt_container=1
leg_row darwin-arm64 host pass false
leg_row darwin-x64 probe pass false
leg_row linux-x64 probe pass false
leg_row linux-arm64 probe pass true
leg_row linux-x64-musl probe pass false
leg_row linux-arm64-musl probe pass true
leg_row win32-x64 probe pass false
leg_row win32-arm64 probe pass false
if coverage_is_complete darwin-arm64; then
  fail=$((fail + 1)); printf 'FAIL %s\n' "downgraded legs are not full coverage"
else pass=$((pass + 1)); printf 'ok   %s\n' "downgraded legs are not full coverage"; fi

jq() { case "$*" in *downgraded*) return 4 ;; *) command jq "$@" ;; esac; }
if coverage_is_complete darwin-arm64; then
  fail=$((fail + 1)); printf 'FAIL %s\n' "a jq that fails cannot buy an all-clear"
else pass=$((pass + 1)); printf 'ok   %s\n' "a jq that fails cannot buy an all-clear"; fi
unset -f jq

# announce_verdict composes and posts in one expression no longer: the `|| true` that keeps a Slack
# outage from killing the canary used to swallow a failure in the RENDERER too, and shipped a
# "safe to update" headline over a body whose counts had come out empty. set -e does not catch it —
# a failing assignment inside a function running in a command substitution does not trip errexit —
# so the composers return non-zero explicitly and this refuses to post rather than post rubbish.
msg_setup pass false ""
REASONS=""
POSTED_FILE="$TMP/posted.txt"; : > "$POSTED_FILE"
(
  slack() { printf '%s' "$1" > "$POSTED_FILE"; }
  jq() { case "$*" in *'.mode == "host"'*) return 4 ;; *) command jq "$@" ;; esac; }
  announce_verdict
) >/dev/null 2>&1 && RC=0 || RC=$?
if [ "$RC" -ne 0 ]; then pass=$((pass + 1)); printf 'ok   %s\n' "a broken renderer fails the run"
else fail=$((fail + 1)); printf 'FAIL %s — announce_verdict returned 0\n' "a broken renderer fails the run"; fi
if [ ! -s "$POSTED_FILE" ]; then pass=$((pass + 1)); printf 'ok   %s\n' "a broken renderer posts nothing at all"
else fail=$((fail + 1)); printf 'FAIL %s — it posted:\n%s\n' "a broken renderer posts nothing at all" "$(cat "$POSTED_FILE")"; fi

# ...while a Slack outage on its own must still NOT take the canary down: that is what the `|| true`
# is for, and tightening the renderer must not have tightened the transport with it.
: > "$POSTED_FILE"
(
  slack() { return 1; }
  announce_verdict
) >/dev/null 2>&1 && RC=0 || RC=$?
if [ "$RC" -eq 0 ]; then pass=$((pass + 1)); printf 'ok   %s\n' "a Slack outage alone does not fail the run"
else fail=$((fail + 1)); printf 'FAIL %s — announce_verdict returned %s\n' "a Slack outage alone does not fail the run" "$RC"; fi

# ---------------------------------------------------------------- notes_for_display
#
# The notification says what to do at the top; the "Worth knowing" list below it must not repeat it.

DOWNGRADE='- Docker was not available, so linux-arm64 got the probe instead.'
OTHER='- linux-arm64 was tested as a probe leg this time and a container leg on 2.1.267.'

# Both sides through $(...), which strips trailing newlines, so the case is about which notes
# survive and not about a trailing blank line the caller's own substitution discards anyway.
notes_check() { # notes_check <name> <all> <covered> <expected>
  local got want
  got="$(notes_for_display "$2" "$3")"
  want="$(printf '%s' "$4")"
  if [ "$got" = "$want" ]; then pass=$((pass + 1)); printf 'ok   %s\n' "$1"
  else fail=$((fail + 1)); printf 'FAIL %s\n  want %s\n  got  %s\n' "$1" "$(printf '%s' "$want" | tr '\n' '|')" "$(printf '%s' "$got" | tr '\n' '|')"; fi
}

notes_check "the note the action line already made is dropped" "$DOWNGRADE
" "$DOWNGRADE" ""

# The footgun this exists to pin: every note starts with "- ", so an unanchored grep pattern is read
# as flags. grep then fails and the `|| true` swallows it, taking every unrelated note with it —
# the reduced-coverage disclosures this canary exists to make.
notes_check "an unrelated note survives the trim" "$OTHER
$DOWNGRADE
" "$DOWNGRADE" "$OTHER
"

notes_check "nothing is dropped when there is nothing to drop" "$OTHER
" "" "$OTHER
"

# Whole-line, not substring: a longer note that quotes the covered one is a different note and has
# its own thing to say.
notes_check "a note that merely contains the covered one is kept" "$DOWNGRADE plus a detail
" "$DOWNGRADE" "$DOWNGRADE plus a detail
"

# ---------------------------------------------------------------- baseline merge
#
# A platform's baseline entry must be exactly what its last passing leg observed. The merge used
# jq's `*`, which recurses, so a new entry inherited `sites` keys from the entry it replaced. A
# host/container leg records `probe:PATCH …` names that a probe-only leg never emits, so after one
# Docker outage the fresh probe entry carried the container run's leftover names, the leg-mode
# guard saw two matching `probe` modes and compared anyway, and the next run reported all eleven
# leftover names as checks that had been "not attempted at all this time".

# Driven through $CANARY_VERDICT_FILTER, the script's own expression, rather than a copy of it
# here: the copy is what let the real filter be edited without any test noticing. The stub installed
# for the launch_investigation cases above has to go first, or this writes nothing and every
# assertion below reads back the fixture it started from and passes for free.
unset -f state_update
CANARY_STATE_DIR="$TMP/basemerge" CANARY_SOURCE_ONLY=1 . "$CANARY"
STATE_DIR="$TMP/basemerge"; mkdir -p "$STATE_DIR"; STATE_FILE="$STATE_DIR/state.json"
jq -n '{versions: {}, inflight: null, deferred: {}, pending: {},
        baseline: {version: "2.1.267", platforms: {
          "linux-arm64": {mode: "container",
                          sites: {"PATCH 1: enum": "OK", "probe:PATCH 1: enum": "OK"}},
          "win32-x64":   {mode: "probe", sites: {"PATCH 1: enum": "OK"}}}}}' > "$STATE_FILE"

# The next release: linux-arm64 gets the probe (Docker is down), win32-x64 is not in this run.
record_verdict 2.1.268 partial '{"linux-arm64": {"mode": "probe", "sites": {"PATCH 1: enum": "OK"}}}'

GOT="$(jq -c '.baseline.platforms["linux-arm64"].sites | keys' "$STATE_FILE")"
if [ "$GOT" = '["PATCH 1: enum"]' ]; then
  pass=$((pass + 1)); printf 'ok   %s\n' "a probe entry does not inherit the container entry's probe: names"
else
  fail=$((fail + 1))
  printf 'FAIL %s — want ["PATCH 1: enum"], got %s\n' "a probe entry does not inherit the container entry's probe: names" "$GOT"
fi

# The whole point of merging rather than replacing: a leg that did not run this time keeps its
# record, so one permanently unavailable platform cannot freeze regression detection for the rest.
GOT="$(jq -r '.baseline.platforms["win32-x64"].mode // "GONE"' "$STATE_FILE")"
if [ "$GOT" = "probe" ]; then
  pass=$((pass + 1)); printf 'ok   %s\n' "a platform absent from this run keeps its previous baseline entry"
else
  fail=$((fail + 1))
  printf 'FAIL %s — win32-x64 mode is %s\n' "a platform absent from this run keeps its previous baseline entry" "$GOT"
fi

# ------------------------------------------------------------------ the hourly flow, end to end
#
# The helpers above are tested one by one, which cannot show that a real run ever reaches them:
# disconnecting the post-merge re-test from the main flow left every case above green. These cases
# run the script's own option parsing and main flow in a child shell, with every external effect
# (registry, build, platform matrix, Slack, GitHub, T3 Code, git) replaced by a stand-in.
MAINFLOW="$TMP/mainflow.sh"
cat > "$MAINFLOW" <<'MAINEOF'
#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$1" TARGET="$2"; shift 2
export CANARY_STATE_DIR="$ROOT/state" CANARY_CACHE_DIR="$ROOT/cache"
export CLODEX_WORKING_COPY="$ROOT/wc" T3CLI_BIN="$ROOT/t3cli" PROBE_ROOT="$ROOT"
CANARY_SOURCE_ONLY=1 . "$TARGET"
unset CANARY_SOURCE_ONLY
REAL_CLODEX_HOME="$ROOT/no-clodex"; REAL_TWEAKCC_DIR="$ROOT/no-tweakcc"
preflight() { :; }
validate_platforms() { :; }
acquire_lock() { :; }
housekeeping() { :; }
cleanup() { :; }
slack() { printf 'SLACK %s\n' "$*" >> "$ROOT/slack.log"; }
registry_doc() { printf '{"dist-tags":{"latest":"%s"}}\n' "$MF_VERSION"; }
real_state_fingerprint() { printf stable; }
sync_repo() { MAIN_SHA=0123456789abcdef0123456789abcdef01234567; MAIN_SUBJECT=fixture; }
resolve_node_bin_dir() { dirname "$(command -v node)"; }
build_repo() { printf 'BUILD\n' >> "$ROOT/calls.log"; }
prepare_sandbox() { WORK="$(mktemp -d "$CACHE_DIR/work.XXXXXX")"; CONFIG_FP=fixture; }
run_platform_matrix() {
  MATRIX="$WORK/matrix.jsonl"
  local p mode st
  for p in darwin-arm64 darwin-x64 linux-x64 linux-x64-musl linux-arm64 linux-arm64-musl win32-arm64 win32-x64; do
    mode=probe; st=pass
    case "$p" in darwin-arm64) mode=host ;; linux-arm64|linux-arm64-musl) mode=container ;; esac
    [ "$p" != win32-arm64 ] || st="$MF_VERDICT"
    jq -nc --arg p "$p" --arg m "$mode" --arg s "$st" \
      '{platform: $p, mode: $m, status: $s, sites: {}, markers: [], downgraded: false,
        reasons: (if $s == "fail" then "- patch anchor missing" else "" end), detail: {}}' >> "$MATRIX"
  done
}
write_repro_script() { :; }
investigation_prompt() { printf 'fixture investigation prompt\n'; }
create_investigation_worktree() { mkdir -p "$INVESTIGATION_WORKTREE"; }
announce_verdict() { printf 'ANNOUNCE\n' >> "$ROOT/calls.log"; printf '%s\n' "${NEXT_STEP:-}" > "$ROOT/next-step.txt"; }
curl() { printf 'CURL\n' >> "$ROOT/calls.log"; printf '%s\n' "${MF_PRS:-[]}"; }
cat > "$T3CLI_BIN" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >> "$PROBE_ROOT/t3calls.log"
case "$1" in
  list) [ "${MF_LIST_FAIL:-0}" != 1 ] || exit 1; cat "$PROBE_ROOT/threads.json" ;;
  thread)
    [ "${MF_INTERRUPT_FAIL:-0}" != 1 ] || exit 1
    jq 'map(.status = "interrupted")' "$PROBE_ROOT/threads.json" > "$PROBE_ROOT/threads.tmp"
    mv "$PROBE_ROOT/threads.tmp" "$PROBE_ROOT/threads.json" ;;
  start)
    cat > /dev/null
    title=""; while [ $# -gt 0 ]; do [ "$1" != --title ] || title="$2"; shift; done
    id="new-$(jq length "$PROBE_ROOT/threads.json")"
    jq --arg id "$id" --arg t "$title" '. + [{id: $id, title: $t, status: "running"}]' \
      "$PROBE_ROOT/threads.json" > "$PROBE_ROOT/threads.tmp"
    mv "$PROBE_ROOT/threads.tmp" "$PROBE_ROOT/threads.json"
    [ "${MF_START_LOST:-0}" != 1 ] || exit 1   # created, but the reply never arrives
    printf '{"threadId":"%s"}\n' "$id" ;;
  *) exit 1 ;;
esac
FAKE
chmod +x "$T3CLI_BIN"
. <(sed -n '/^while \[ \$# -gt 0 \]; do/,$p' "$TARGET")
MAINEOF

mf_run() { # mf_run <name> <state-json|KEEP> <threads-json|KEEP> -- sets MF_ROOT; env MF_* configures it
  MF_ROOT="$TMP/mf-$1"; mkdir -p "$MF_ROOT/state" "$MF_ROOT/cache" "$MF_ROOT/wc"
  [ -d "$MF_ROOT/cache/repo" ] || cp -R "$FIX_REPO" "$MF_ROOT/cache/repo"   # for the fix-ancestry check
  [ "$2" = KEEP ] || printf '%s\n' "$2" > "$MF_ROOT/state/state.json"
  [ "$3" = KEEP ] || printf '%s\n' "$3" > "$MF_ROOT/threads.json"
  : > "$MF_ROOT/calls.log"; : > "$MF_ROOT/t3calls.log"; : > "$MF_ROOT/slack.log"
  MF_RC=0
  bash "$MAINFLOW" "$MF_ROOT" "$CANARY" > "$MF_ROOT/out.log" 2>&1 || MF_RC=$?
}
mf_check() { # mf_check <label> <0-if-it-held>
  if [ "$2" -eq 0 ]; then pass=$((pass + 1)); printf 'ok   %s\n' "$1"
  else fail=$((fail + 1)); printf 'FAIL %s — run log:\n%s\n' "$1" "$(tail -20 "$MF_ROOT/out.log")"; fi
}
mf_state() { jq -r "$1" "$MF_ROOT/state/state.json"; }
NOW_EPOCH="$(date +%s)"
FAILED_STATE="$(jq -n -c --arg sha "$TESTED_SHA" '{versions: {"9.9.9": {status: "fail", at: "2026-10-30T10:00:00Z",
                                                     atEpoch: 1, clodexSha: $sha}},
                                          baseline: null, inflight: null, deferred: {}, pending: {}}')"

MF_VERSION=9.9.9 MF_VERDICT=pass MF_PRS="[$(pr 7 fix/patch-cc-9.9.9 2026-10-30T12:00:00Z "$UNFETCHED_SHA")]" \
  mf_run reopen "$FAILED_STATE" '[]'
[ "$MF_RC" -eq 0 ] && grep -qx BUILD "$MF_ROOT/calls.log" && grep -qx ANNOUNCE "$MF_ROOT/calls.log" &&
  [ "$(mf_state '.versions["9.9.9"].status')" = pass ] && r=0 || r=1
mf_check "an hourly run re-tests the failing newest release once a canary fix has merged" "$r"

MF_VERSION=9.9.9 MF_VERDICT=pass MF_PRS="[$(pr 7 fix/patch-cc-9.9.9 2026-10-31T12:00:00Z "$OLD_FIX_SHA")]" \
  mf_run stale-fix "$FAILED_STATE" '[]'
[ "$MF_RC" -eq 0 ] && grep -qx CURL "$MF_ROOT/calls.log" && ! grep -qx BUILD "$MF_ROOT/calls.log" &&
  [ "$(mf_state '.versions["9.9.9"].status')" = fail ] && r=0 || r=1
mf_check "an hourly run leaves the release failing when no fix merged since" "$r"

STUCK_STATE="$(jq -n -c --argjson e "$((NOW_EPOCH - 25 * 3600))" \
  '{versions: {"9.9.8": {status: "fail", at: "2026-10-29T10:00:00Z", atEpoch: 1}},
    baseline: null, deferred: {}, pending: {},
    inflight: {version: "9.9.8", threadTitle: "old investigation", threadId: "old", startedEpoch: $e}}')"
MF_VERSION=9.9.9 MF_VERDICT=fail MF_INTERRUPT_FAIL=1 \
  mf_run stuck "$STUCK_STATE" '[{"id":"old","status":"running"}]'
[ "$MF_RC" -eq 0 ] && [ "$(mf_state '.inflight.threadId')" = old ] && ! grep -qx start "$MF_ROOT/t3calls.log" &&
  grep -q 'stopping it could not be confirmed' "$MF_ROOT/slack.log" &&
  [ "$(mf_state '.versions["9.9.9"].status')" = fail ] && r=0 || r=1
mf_check "a 24h investigation that cannot be stopped stays recorded and blocks a second one" "$r"
[ "$(mf_state '.versions["9.9.9"].investigation')" = suppressed ] &&
  [ "$(mf_state '.versions["9.9.9"].investigationHeldBy')" = 9.9.8 ] &&
  grep -q 'No second investigation was started' "$MF_ROOT/next-step.txt" &&
  grep -q 'old investigation' "$MF_ROOT/next-step.txt" && ! grep -q 'Nobody is working' "$MF_ROOT/next-step.txt" &&
  r=0 || r=1
mf_check "the failure alert names the investigation still running instead of saying nobody is" "$r"

# The sweep keeps only the newest sandboxes, except any an investigation is or may be reading.
# work.0 belongs to an unconfirmed launch, work.1 to an adopted in-flight thread whose version record
# a later run replaced (it now points at work.2), and work.3 to nobody. work.4 and .5 are newest.
SWEEP="$TMP/sweep"; mkdir -p "$SWEEP/cache" "$SWEEP/state/logs"
for n in 0 1 2 3 4 5; do mkdir "$SWEEP/cache/work.$n"; touch -t "20261030000$n" "$SWEEP/cache/work.$n"; done
( CACHE_DIR="$SWEEP/cache" LOG_DIR="$SWEEP/state/logs" CANARY_KEEP_SANDBOXES=2 CANARY_KEEP_LOGS=200
  state_read() { jq -n -c --arg m "$SWEEP/cache/work.0" --arg i "$SWEEP/cache/work.1" --arg v "$SWEEP/cache/work.2" \
    '{versions: {"9.9.7": {sandbox: $v}}, inflight: {version: "9.9.7", sandbox: $i},
      uncertainLaunch: {sandbox: $m}}'; }
  log() { :; }
  housekeeping )
[ -d "$SWEEP/cache/work.0" ] && [ -d "$SWEEP/cache/work.1" ] && [ -d "$SWEEP/cache/work.2" ] &&
  [ ! -e "$SWEEP/cache/work.3" ] && [ -d "$SWEEP/cache/work.4" ] && [ -d "$SWEEP/cache/work.5" ] && r=0 || r=1
mf_check "the sandbox sweep keeps the in-flight and the unconfirmed investigation's evidence" "$r"

MF_VERSION=9.9.9 MF_VERDICT=fail \
  mf_run stopped "$STUCK_STATE" '[{"id":"old","status":"running"}]'
[ "$MF_RC" -eq 0 ] && grep -qx thread "$MF_ROOT/t3calls.log" && grep -qx start "$MF_ROOT/t3calls.log" &&
  [ "$(mf_state '.inflight.version')" = 9.9.9 ] && [ "$(mf_state '.inflight.threadId')" != old ] &&
  [ "$(jq -r '.[] | select(.id == "old") | .status' "$MF_ROOT/threads.json")" = interrupted ] && r=0 || r=1
mf_check "a 24h investigation confirmed stopped makes way for the next one" "$r"

HELD_STATE="$(jq -n -c --arg sha "$TESTED_SHA" '{versions: {"9.9.9": {status: "fail", at: "2026-10-30T10:00:00Z",
                                       atEpoch: 1, clodexSha: $sha, investigation: "suppressed",
                                       investigationHeldBy: "9.9.8"}},
                    baseline: null, inflight: null, deferred: {}, pending: {}}')"
MF_VERSION=9.9.9 MF_VERDICT=fail mf_run held "$HELD_STATE" '[]'
[ "$MF_RC" -eq 0 ] && grep -qx start "$MF_ROOT/t3calls.log" && [ "$(mf_state '.inflight.version')" = 9.9.9 ] &&
  [ "$(mf_state '.versions["9.9.9"].investigation')" = started ] && r=0 || r=1
mf_check "a failure held back by a stuck investigation gets its own once the slot frees" "$r"

# A launch T3 Code accepted but whose reply was lost, while T3 Code could not be asked either, must
# not let the next failing release start a second thread beside it.
EMPTY_STATE='{"versions":{},"baseline":null,"inflight":null,"deferred":{},"pending":{}}'
MF_VERSION=9.9.8 MF_VERDICT=fail MF_START_LOST=1 MF_LIST_FAIL=1 mf_run lost "$EMPTY_STATE" '[]'
LOST_RC="$MF_RC"
LOST_SANDBOX="$(mf_state '.uncertainLaunch.sandbox // ""')"
[ "$LOST_RC" -eq 0 ] && [ -d "$LOST_SANDBOX" ] && [ "$LOST_SANDBOX" = "$(mf_state '.versions["9.9.8"].sandbox')" ] &&
  r=0 || r=1
mf_check "an unconfirmed launch's marker keeps the path of the evidence it was given" "$r"
MF_VERSION=9.9.9 MF_VERDICT=fail mf_run lost KEEP KEEP
[ "$LOST_RC" -eq 0 ] && [ "$MF_RC" -eq 0 ] &&
  [ "$(jq '[.[] | select(.status == "running")] | length' "$MF_ROOT/threads.json")" = 1 ] &&
  [ "$(mf_state '.inflight.threadId')" = new-0 ] && [ "$(mf_state '.uncertainLaunch')" = null ] &&
  [ "$(mf_state '.inflight.sandbox')" = "$LOST_SANDBOX" ] &&
  [ "$(mf_state '.versions["9.9.9"] // "untested"')" = untested ] && r=0 || r=1
mf_check "a lost launch nobody could confirm is adopted later, and newer releases wait on it" "$r"

# While T3 Code stays unreachable, a release held back by the unconfirmed launch is not re-tested
# every hour; once T3 Code answers and that launch never happened, the release gets its own.
MARKED_STATE="$(jq -n -c --arg sha "$TESTED_SHA" '{versions: {"9.9.9": {status: "fail", at: "2026-10-30T10:00:00Z",
                                       atEpoch: 1, clodexSha: $sha, investigation: "suppressed",
                                       investigationHeldBy: "9.9.8"}},
                    uncertainLaunch: {version: "9.9.8", threadTitle: "clodex-patch-canary 9.9.8 202610300000"},
                    baseline: null, inflight: null, deferred: {}, pending: {}}')"
MF_VERSION=9.9.9 MF_VERDICT=fail MF_LIST_FAIL=1 mf_run marked "$MARKED_STATE" '[]'
[ "$MF_RC" -eq 0 ] && ! grep -qx BUILD "$MF_ROOT/calls.log" && ! grep -qx start "$MF_ROOT/t3calls.log" &&
  [ "$(mf_state '.uncertainLaunch.version')" = 9.9.8 ] && r=0 || r=1
mf_check "a release held back by an unconfirmed launch is not re-tested while T3 Code is unreachable" "$r"
MF_VERSION=9.9.9 MF_VERDICT=fail mf_run marked KEEP KEEP
[ "$MF_RC" -eq 0 ] && grep -qx BUILD "$MF_ROOT/calls.log" && grep -qx start "$MF_ROOT/t3calls.log" &&
  [ "$(mf_state '.uncertainLaunch')" = null ] && [ "$(mf_state '.inflight.version')" = 9.9.9 ] && r=0 || r=1
mf_check "once T3 Code answers and the launch never happened, the held release gets its own" "$r"

MF_VERSION=9.9.9 MF_VERDICT=fail MF_LIST_FAIL=1 mf_run marked-new \
  "$(printf '%s' "$MARKED_STATE" | jq -c 'del(.versions["9.9.9"])')" '[]'
[ "$MF_RC" -eq 0 ] && ! grep -qx start "$MF_ROOT/t3calls.log" &&
  [ "$(mf_state '.versions["9.9.9"].investigationHeldBy')" = 9.9.8 ] &&
  grep -q 'could not be confirmed' "$MF_ROOT/next-step.txt" && ! grep -q 'still recorded as running' "$MF_ROOT/next-step.txt" &&
  r=0 || r=1
mf_check "a failure held back by an unconfirmed launch says so, without calling it running" "$r"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
