#!/usr/bin/env bash
#
# clodex-patch-canary.sh — early warning for "the next Claude Code release breaks clodex patch".
#
# Each run:
#   1. asks the npm registry for the newest Claude Code release on a dist-tag (default: latest)
#   2. stops immediately if that version was already triaged, or if a previous failure is still
#      being investigated by a background Claude session
#   3. syncs a private clone of clodex to a freshly fetched origin/main and builds it
#   4. downloads that release for EVERY published platform into a throwaway sandbox and tests each
#      one — the real `clodex patch` on this Mac, the real `clodex patch` in a Linux container for
#      arm64 glibc and musl, and a bundle-patch + binary-handling probe for the rest. See
#      clodex-patch-canary-platforms.sh for why, and for what each leg proves.
#   5. if any platform's patch mechanism is broken, launches ONE background Claude session to
#      investigate all of them, fix, and open a PR — and pings Slack at the start
#
# It never installs Claude Code, never patches the installed Claude Code, and never writes to
# ~/.clodex or ~/.tweakcc: the patch run is redirected with CLODEX_HOME, TWEAKCC_CONFIG_DIR and
# TWEAKCC_CC_INSTALLATION_PATH, and runs with HOME pointed inside the sandbox.
#
# Usage: clodex-patch-canary.sh [options]
#   --status            print triage state and exit
#   --version VER       test this Claude Code version instead of the dist-tag's
#   --retriage VER      forget VER's recorded verdict, then run
#   --force             ignore the already-triaged record and the in-flight deferral
#   --platforms LIST    comma-separated platforms to test instead of all of them
#   --no-container      never use Docker; test Linux with the probe only (no binary is started)
#   --no-launch         report a failure but do not start the background Claude session
#   --no-slack          never post to Slack
#   --keep-work         keep the sandbox even when the run passes
#   --help
#
set -Eeuo pipefail

# ---------------------------------------------------------------- configuration

CANARY_NAME=clodex-patch-canary
STATE_DIR="${CANARY_STATE_DIR:-$HOME/.local/state/$CANARY_NAME}"
CACHE_DIR="${CANARY_CACHE_DIR:-$HOME/.cache/$CANARY_NAME}"
REPO_DIR="$CACHE_DIR/repo"
LOG_DIR="$STATE_DIR/logs"
STATE_FILE="$STATE_DIR/state.json"
LOCK_DIR="$STATE_DIR/lock"

CANARY_REPO_URL="${CANARY_REPO_URL:-https://github.com/bman654/clodex.git}"
CANARY_BRANCH="${CANARY_BRANCH:-main}"
CANARY_CHANNEL="${CANARY_CHANNEL:-latest}"
CANARY_PKG="${CANARY_PKG:-@anthropic-ai/claude-code}"
CANARY_REGISTRY="${CANARY_REGISTRY:-https://registry.npmjs.org}"

# Where the investigation session runs (the real working copy, not the canary clone).
CLODEX_WORKING_COPY="${CLODEX_WORKING_COPY:-$HOME/dev/general/clodex}"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
SLACK_PY="${SLACK_PY:-$HOME/.claude-expero/expero/bin/slack.py}"
SLACK_PYTHON="${SLACK_PYTHON:-$HOME/.claude-expero/expero/bin/python3}"
CANARY_SLACK_TO="${CANARY_SLACK_TO:-@brandon@experoinc.com}"

# The real clodex state the sandbox borrows its model config from (read-only).
REAL_CLODEX_HOME="${CLODEX_HOME:-$HOME/.clodex}"
REAL_TWEAKCC_DIR="${TWEAKCC_CONFIG_DIR:-$HOME/.tweakcc}"

# An investigation older than this is treated as abandoned so the canary can resume.
CANARY_MAX_INFLIGHT_HOURS="${CANARY_MAX_INFLIGHT_HOURS:-24}"
# Ceilings on the two steps that can hang. A wedged run would otherwise hold the lock and silently
# stop every later run from ever testing a release.
CANARY_BUILD_TIMEOUT="${CANARY_BUILD_TIMEOUT:-900}"
CANARY_PATCH_TIMEOUT="${CANARY_PATCH_TIMEOUT:-1200}"
# A lock older than this belonged to a run that died.
CANARY_LOCK_STALE_MIN="${CANARY_LOCK_STALE_MIN:-90}"
CANARY_KEEP_LOGS="${CANARY_KEEP_LOGS:-200}"
# How a condition that stops the canary working (a network outage, a stuck lock, no favourites) is
# escalated: reported once when it appears, again and more loudly once it has lasted this long, then
# a reminder on the slower cadence until it clears. See warn_persisting.
CANARY_ESCALATE_HOURS="${CANARY_ESCALATE_HOURS:-6}"
CANARY_REMIND_HOURS="${CANARY_REMIND_HOURS:-24}"
# A preserved failure sandbox keeps one ~280 MB binary per FAILING leg plus the pristine backup of
# each leg that really ran `clodex patch`, so it is ~0.3 GB when one platform fails and ~3 GB when
# all eight do. Passing legs have their binary and backup reclaimed as the matrix runs.
CANARY_KEEP_SANDBOXES="${CANARY_KEEP_SANDBOXES:-2}"
# How long a version whose coverage came out incomplete waits before the canary tries it again.
# Short enough that a Docker Desktop restarted this afternoon is picked up today; long enough that
# a permanently unavailable leg does not re-download every platform once an hour, forever.
CANARY_PARTIAL_RETRY_HOURS="${CANARY_PARTIAL_RETRY_HOURS:-6}"

# A background session in one of these states is finished; anything else is still working.
TERMINAL_AGENT_STATES="done stopped failed error cancelled"

opt_status=0 opt_force=0 opt_launch=1 opt_slack=1 opt_keep=0 opt_version="" opt_retriage=""
opt_platforms="" opt_container=1

# The platform matrix and the three ways of testing one live next door, so neither file has to be
# read in full to work on the other.
CANARY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=clodex-patch-canary-platforms.sh
. "$CANARY_LIB_DIR/$CANARY_NAME-platforms.sh"

# ---------------------------------------------------------------------- helpers

now_iso()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch() { date +%s; }
log()  { printf '[%s] %s\n' "$(now_iso)" "$*"; }
die()  { log "ERROR: $*"; exit 1; }

usage() { sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; }

# Post to Slack. Never fatal: a broken notifier must not take the canary down. Returns non-zero
# when the message did NOT go out, so a caller that records "already told them" can tell the
# difference between a delivered notice and a swallowed one.
slack() {
  local text="$1"
  if [ "$opt_slack" -ne 1 ]; then log "slack (suppressed): $text"; return 0; fi
  if [ ! -x "$SLACK_PYTHON" ] || [ ! -f "$SLACK_PY" ]; then
    log "WARN: slack CLI not found ($SLACK_PYTHON $SLACK_PY); message not sent:"
    log "$text"
    return 1
  fi
  if ! "$SLACK_PYTHON" "$SLACK_PY" notify "$CANARY_SLACK_TO" "$text" >/dev/null 2>&1; then
    log "WARN: slack notify failed; message was:"
    log "$text"
    return 1
  fi
  return 0
}

state_read() {
  if [ -s "$STATE_FILE" ]; then
    cat "$STATE_FILE"
  else
    printf '{"versions":{},"baseline":null,"inflight":null,"deferred":{},"pending":{}}\n'
  fi
}

# Never quietly fall back to empty history: an unreadable state.json would otherwise be replaced by
# a fresh one on the next write, re-triaging every version and forgetting a live investigation.
validate_state() {
  [ -s "$STATE_FILE" ] || return 0
  # `jq -e .` also accepts a stream of several concatenated documents, which would make every
  # later read ambiguous — require exactly one object.
  jq -e -s 'length == 1 and (.[0] | type == "object")' "$STATE_FILE" >/dev/null 2>&1 && return 0
  slack ":warning: clodex patch canary is halted: \`$STATE_FILE\` is not valid JSON, so it cannot tell which Claude Code releases were already triaged or whether an investigation is running. Move the file aside to reset it." || true
  die "state file $STATE_FILE is not valid JSON — refusing to run with unknown triage history"
}

# state_update <jq filter> [jq args...] — atomically rewrite state.json. state.json is what stops a
# version being triaged twice, so a half-written one is worse than a failed run: the temp file is
# validated before it replaces the real thing.
state_update() {
  local filter="$1"; shift
  local tmp
  tmp="$(mktemp "$STATE_DIR/.state.XXXXXX")"
  if ! state_read | jq "$@" "$filter" > "$tmp" ||
     ! jq -e -s 'length == 1 and (.[0] | type == "object")' "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    die "refusing to write a corrupt state.json (filter: $filter)"
  fi
  mv "$tmp" "$STATE_FILE"
}

# Baselines are per platform. A run before this file grew a platform matrix recorded one flat
# `sites`/`markers` pair, which described the host and nothing else — read it as such rather than
# discarding it, or the first multi-platform run has nothing to compare against.
baseline_platforms() {
  state_read | jq -c --arg host "$(host_platform)" \
    '.baseline // {} | (.platforms // (if .sites then {($host): {mode: "host", sites: .sites, markers: (.markers // [])}} else {} end))'
}

# Say something the first time a condition appears, then keep the volume honest. Repeating a
# warning every hour trains you to ignore it; saying it exactly once and then going quiet forever is
# worse, because a canary that has silently stopped testing releases looks identical to a canary
# with nothing to report. So every condition here follows one cadence: once when it appears, again
# and more loudly once it has persisted for CANARY_ESCALATE_HOURS, then a reminder at most every
# CANARY_REMIND_HOURS until it clears. clear_warning resets the whole cycle.
#
#   $1  key
#   $2  message for the first sighting
#   $3  message for "this still has not resolved" — {hours} expands to how long the condition has
#       been unbroken, {since} to when it started
#
# Sentinel files rather than state.json because the stuck-lock warning fires from a run that does
# NOT hold the lock, and an unsynchronised read-modify-write of state.json could erase the verdict
# the lock holder is in the middle of recording. Each holds "<first-seen> <last-spoken>" as epochs,
# stamped only once a message is delivered so a Slack outage cannot swallow one.
warn_persisting() {
  local key="$1" first_msg="$2" persist_msg="$3" flag="$STATE_DIR/.warned-$1"
  local now first spoke age_h due_h
  now="$(now_epoch)"
  first="$(awk 'NR==1{print $1+0}' "$flag" 2>/dev/null || echo 0)"; first="${first:-0}"
  spoke="$(awk 'NR==1{print $2+0}' "$flag" 2>/dev/null || echo 0)"; spoke="${spoke:-0}"

  if [ "$first" -le 0 ]; then
    if slack "$first_msg"; then printf '%s %s\n' "$now" "$now" > "$flag"; fi
    return 0
  fi

  age_h=$(( (now - first) / 3600 ))
  # Nothing said since the first sighting means the escalation is still pending; once it has gone
  # out, the slower reminder cadence takes over.
  if [ "$spoke" -gt "$first" ]; then due_h="$CANARY_REMIND_HOURS"; else due_h="$CANARY_ESCALATE_HOURS"; fi

  if [ $(( (now - spoke) / 3600 )) -ge "$due_h" ]; then
    persist_msg="${persist_msg//\{hours\}/$age_h}"
    persist_msg="${persist_msg//\{since\}/$(date -r "$first" '+%a %H:%M' 2>/dev/null || echo "$first")}"
    if slack "$persist_msg"; then printf '%s %s\n' "$first" "$now" > "$flag"; fi
    return 0
  fi

  log "($key unresolved for ${age_h}h, already reported) $first_msg"
}

clear_warning() {
  rm -f "$STATE_DIR/.warned-$1"
}


# Runs on EVERY path, including the hourly no-ops, because the paths that exit early are the common
# ones and they are what let logs and abandoned sandboxes accumulate.
housekeeping() {
  local keep old inflight_sandbox
  # Newline-delimited, with delimiters on both ends so the match below is a whole-line match: an
  # entry that merely appears in the middle of the list must count as kept too.
  keep="
$(state_read | jq -r '[(.versions | to_entries[]? | .value.log), .inflight.log]
                      | map(select(type == "string")) | .[]' 2>/dev/null || true)
"
  # `ls` on an unmatched glob exits non-zero; with pipefail that would abort the whole run.
  { ls -1t "$LOG_DIR"/*.log 2>/dev/null || true; } | tail -n +"$((CANARY_KEEP_LOGS + 1))" |
  while read -r old; do
    [ -f "$old" ] || continue
    [ "$old" = "${RUN_LOG:-}" ] && continue
    # Never delete a log some triage record still points at.
    case "$keep" in *"
$old
"*) continue ;; esac
    rm -f "$old"
  done

  # The in-flight investigation is reading its sandbox — that one is never swept.
  inflight_sandbox="$(state_read | jq -r '(.inflight.version // "") as $v | .versions[$v].sandbox // ""')"
  { ls -1dt "$CACHE_DIR"/work.* 2>/dev/null || true; } | tail -n +"$((CANARY_KEEP_SANDBOXES + 1))" |
  while read -r old; do
    [ -d "$old" ] || continue
    [ "$old" = "$inflight_sandbox" ] && continue
    log "removing old sandbox $old ($(du -sh "$old" 2>/dev/null | awk '{print $1}' || echo '?'))"
    rm -rf "$old"
  done
  return 0
}

# `kill -0` alone is not proof the lock's owner is still ours: claude's daemon recycles pids, and a
# crashed run's pid can be reissued to anything. Check what the process actually is.
lock_holder_is_canary() {
  ps -p "$1" -o command= 2>/dev/null | grep -q "$CANARY_NAME"
}

acquire_lock() {
  local pid age_min stale_dir
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$LOCK_DIR/pid"
    return 0
  fi
  age_min=$(( ( $(now_epoch) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0) ) / 60 ))
  pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")"

  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && lock_holder_is_canary "$pid"; then
    # A live holder is normally a run that just started. A live holder older than the staleness
    # window is a hung run — and every later run would quietly yield to it forever, which looks
    # exactly like "no new releases". Never kill it (it may be mid-repack), but say so.
    if [ "$age_min" -ge "$CANARY_LOCK_STALE_MIN" ]; then
      warn_persisting stuck-lock \
":warning: clodex patch canary looks stuck: a run (pid $pid) has held its lock for ${age_min} minutes, so no Claude Code release is being tested. Check \`ps -p $pid\`; if it is wedged, kill it and \`rm -rf $LOCK_DIR\`." \
":rotating_light: *clodex patch canary is still stuck, {hours}h on* — a wedged run (now pid $pid, holding its lock ${age_min} minutes) has blocked every hourly run since {since}, so *no Claude Code release has been tested in {hours}h*. This will not fix itself: kill the process and \`rm -rf $LOCK_DIR\`. Until then, treat any Claude Code update as untested."
    fi
    log "another canary run (pid $pid) holds the lock (${age_min}m) — exiting"
    exit 0
  fi

  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "lock pid $pid is alive but is not a canary process (recycled pid) — taking the lock over"
  elif [ "$age_min" -lt "$CANARY_LOCK_STALE_MIN" ]; then
    # Possibly a run that has created the dir but not yet written its pid.
    log "lock held by pid ${pid:-?} (${age_min}m old, not yet stale) — exiting"
    exit 0
  else
    log "WARN: breaking stale lock (pid ${pid:-?}, ${age_min}m old)"
  fi

  # Claim the takeover with a rename: two runs racing on the same stale lock cannot both win, so
  # they cannot both go on to test the same version.
  stale_dir="$LOCK_DIR.stale.$$"
  mv "$LOCK_DIR" "$stale_dir" 2>/dev/null || { log "another run claimed the stale lock first — exiting"; exit 0; }
  rm -rf "$stale_dir"
  mkdir "$LOCK_DIR" 2>/dev/null || { log "another run recreated the lock first — exiting"; exit 0; }
  echo $$ > "$LOCK_DIR/pid"
}

WORK=""
KEEP_WORK=0

# Set while a step is running whose failure means "the canary could not reach the network", not
# "something is broken" — the value is that step in plain language. Only steps that are
# unambiguously a fetch set it: a failed `pnpm install` can equally be a lockfile problem, and
# calling that transient would talk you out of looking at a real breakage. Assignments must happen
# in the parent shell (a `$(...)` runs in a subshell and its variables die with it), so each site
# sets it before the fetch and clears it on the line after.
TRANSIENT_STEP=""

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    # The canary itself broke (network, build, bad state). Nobody is watching a launchd job's
    # exit code, so say so out loud — but never let the notifier change the exit status.
    log "canary run failed with exit $rc${TRANSIENT_STEP:+ (network step: $TRANSIENT_STEP)}"
    # stdout goes through an asynchronous `tee`, so the line just logged is not necessarily in the
    # file yet. Wait for it before quoting the tail, or the alert arrives with a stale excerpt.
    local waited=0
    while [ -n "${RUN_LOG:-}" ] && [ "$waited" -lt 20 ] &&
          ! grep -Fq "canary run failed with exit $rc" "$RUN_LOG" 2>/dev/null; do
      waited=$((waited + 1)); sleep 0.05
    done
    local tail_lines
    tail_lines="$( [ -n "${RUN_LOG:-}" ] && tail -12 "$RUN_LOG" 2>/dev/null || echo "(no log)" )"
    if [ -n "$TRANSIENT_STEP" ]; then
      warn_persisting transient \
":cloud: *clodex patch canary: skipped a run, nothing for you to do* — it failed while $TRANSIENT_STEP, so this is a network problem on this machine, not a problem with clodex or with Claude Code.
No Claude Code release was tested and no verdict was recorded, so nothing is lost: the next hourly run picks up where this one left off. This is the only message you get for a passing blip — if it is still failing ${CANARY_ESCALATE_HOURS}h from now I will tell you again and say so plainly. Log: \`${RUN_LOG:-none}\`
\`\`\`
$tail_lines
\`\`\`" \
":rotating_light: *clodex patch canary has been down for {hours}h* — every run since {since} has failed while $TRANSIENT_STEP. That is no longer a passing blip, so something is actually wrong: check this machine's network and DNS (\`fix-dns\` if the gateway is hijacking port 53).
Meanwhile *no Claude Code release is being tested at all* — if one shipped in the last {hours}h you have no verdict on whether \`clodex patch\` still applies to it, so hold off updating Claude Code until this clears. It re-checks hourly and goes quiet on its own the moment a run completes. Log: \`${RUN_LOG:-none}\`
\`\`\`
$tail_lines
\`\`\`" || true
    else
      slack ":warning: *clodex patch canary run failed* (exit $rc) — this is the canary breaking, not necessarily clodex. Log: \`${RUN_LOG:-none}\`
Last lines:
\`\`\`
$tail_lines
\`\`\`" || true
    fi
  else
    # Any run that reached its own exit — including the hourly "already triaged, nothing to do" —
    # proves the network came back, so the next blip gets reported instead of being swallowed.
    clear_warning transient
  fi
  if [ -n "$WORK" ] && [ -d "$WORK" ] && [ "$KEEP_WORK" = "0" ]; then
    rm -rf "$WORK" || log "WARN: could not remove $WORK"
  fi
  if [ -d "$LOCK_DIR" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null || echo)" = "$$" ]; then
    rm -rf "$LOCK_DIR" || log "WARN: could not remove my own lock $LOCK_DIR"
  fi
  return $rc
}

# Fingerprint of the real state the canary must never touch. Size alone would miss a same-length
# edit, and `ls` output would mangle names containing spaces, so this stats each entry explicitly.
real_state_fingerprint() {
  {
    printf 'claude-symlink %s\n' "$(readlink "$HOME/.local/bin/claude" 2>/dev/null || echo none)"
    if [ -e "$HOME/.local/bin/claude" ]; then
      stat -f '%N %z %m' "$(readlink "$HOME/.local/bin/claude" 2>/dev/null || echo "$HOME/.local/bin/claude")" 2>/dev/null || true
    fi
    stat -f '%N %z %m' "$REAL_CLODEX_HOME/patch-state.json" 2>/dev/null || echo "no patch-state"
    if [ -d "$REAL_TWEAKCC_DIR" ]; then
      find "$REAL_TWEAKCC_DIR" -maxdepth 1 -mindepth 1 -print0 2>/dev/null |
        xargs -0 stat -f '%N %z %m' 2>/dev/null | sort || true
    else
      echo "no tweakcc dir"
    fi
  } | shasum -a 256 | awk '{print $1}'
}

# ------------------------------------------------------------------ toolchain

resolve_node_bin_dir() {
  local dir=""
  if [ -n "${CANARY_NODE_BIN:-}" ] && [ -x "$CANARY_NODE_BIN/node" ]; then
    echo "$CANARY_NODE_BIN"; return 0
  fi
  # Honour the repo's .nvmrc when fnm can (matches what CI and the maintainer use).
  if command -v fnm >/dev/null 2>&1 && [ -f "$REPO_DIR/.nvmrc" ]; then
    dir="$(cd "$REPO_DIR" && fnm exec -- node -e \
      'process.stdout.write(require("path").dirname(process.execPath))' 2>/dev/null || echo "")"
    if [ -n "$dir" ] && [ -x "$dir/node" ]; then echo "$dir"; return 0; fi
  fi
  if [ -x "$HOME/.local/share/fnm/aliases/default/bin/node" ]; then
    echo "$HOME/.local/share/fnm/aliases/default/bin"; return 0
  fi
  if command -v node >/dev/null 2>&1; then
    dirname "$(command -v node)"; return 0
  fi
  return 1
}

preflight() {
  local missing=""
  # BSD stat flags, ~/.local/bin/claude, launchd — this is a macOS script and should say so rather
  # than half-work somewhere else.
  [ "$(uname -s)" = "Darwin" ] || die "clodex-patch-canary supports macOS only (found $(uname -s))"
  for t in curl jq git tar shasum openssl awk sed; do
    command -v "$t" >/dev/null 2>&1 || missing="$missing $t"
  done
  [ -z "$missing" ] || die "missing required tools:$missing"
  TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || echo "")"
  [ -n "$TIMEOUT_BIN" ] || log "WARN: no timeout(1) — a hung build or patch will not be cut short"
  # host_platform dies on an arch it does not know, but every later caller reads it through a
  # `$(...)` or an `if`, both of which swallow that exit — so it is resolved once, here, in the
  # parent shell, where the failure can actually stop the run.
  HOST_PLATFORM_NAME="$(host_platform)" || die "cannot determine this machine's platform"
  [ -n "$(platform_member "$HOST_PLATFORM_NAME")" ] ||
    die "this machine is $HOST_PLATFORM_NAME, which Claude Code does not publish a build for"
}

with_timeout() {
  local secs="$1"; shift
  if [ -n "${TIMEOUT_BIN:-}" ]; then "$TIMEOUT_BIN" -k 30 "$secs" "$@"; else "$@"; fi
}

# ------------------------------------------------------------- registry access

registry_doc() {
  local pkg="$1" encoded
  encoded="$(printf '%s' "$pkg" | sed 's|/|%2f|')"
  # --retry alone only covers curl's "transient" set (timeouts and a few 5xx). A dropped TLS
  # handshake — `curl: (35) Recv failure` — is not in that set, so a single blip on the way to the
  # registry used to fail the whole run without one retry. --retry-all-errors is what makes those
  # retryable; the cost is that a genuine 404 now takes three attempts, which does not happen here
  # because both packages this is called for always exist.
  curl -fsSL --retry 3 --retry-delay 5 --retry-all-errors --retry-connrefused --max-time 120 \
    -H 'Accept: application/vnd.npm.install-v1+json' "$CANARY_REGISTRY/$encoded"
}

# --------------------------------------------------------------- repo + build

sync_repo() {
  if [ ! -d "$REPO_DIR/.git" ]; then
    log "cloning $CANARY_REPO_URL -> $REPO_DIR"
    mkdir -p "$(dirname "$REPO_DIR")"
    TRANSIENT_STEP="cloning the clodex repository from GitHub"
    git clone --quiet --no-tags "$CANARY_REPO_URL" "$REPO_DIR" || die "clone failed"
    TRANSIENT_STEP=""
  fi
  git -C "$REPO_DIR" remote set-url origin "$CANARY_REPO_URL"
  log "fetching origin/$CANARY_BRANCH"
  TRANSIENT_STEP="fetching the latest clodex source from GitHub"
  git -C "$REPO_DIR" fetch --quiet --prune --no-tags origin "$CANARY_BRANCH" || die "git fetch failed"
  TRANSIENT_STEP=""
  git -C "$REPO_DIR" checkout --quiet --force --detach "origin/$CANARY_BRANCH" || die "git checkout failed"
  git -C "$REPO_DIR" clean --quiet -fd
  MAIN_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
  MAIN_SUBJECT="$(git -C "$REPO_DIR" log -1 --pretty=%s)"
  log "origin/$CANARY_BRANCH is $MAIN_SHA — $MAIN_SUBJECT"
}

build_repo() {
  local built_marker="$CACHE_DIR/built.sha"
  if [ -f "$built_marker" ] && [ -f "$REPO_DIR/dist/cli.js" ] &&
     [ "$(cat "$built_marker")" = "$MAIN_SHA" ]; then
    log "build cache hit for $MAIN_SHA"
    return 0
  fi
  # corepack honours the repo's pinned packageManager; a bare pnpm is the fallback.
  local pm
  if command -v corepack >/dev/null 2>&1; then pm="corepack pnpm"
  elif command -v pnpm >/dev/null 2>&1; then pm="pnpm"
  else die "neither corepack nor pnpm is available to build clodex"; fi
  log "installing dependencies ($pm install --frozen-lockfile)"
  ( cd "$REPO_DIR" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
      with_timeout "$CANARY_BUILD_TIMEOUT" $pm install --frozen-lockfile ) \
    || die "pnpm install failed on origin/$CANARY_BRANCH ($MAIN_SHA) — exit $?"
  log "building ($pm build)"
  ( cd "$REPO_DIR" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
      with_timeout "$CANARY_BUILD_TIMEOUT" $pm build ) \
    || die "pnpm build failed on origin/$CANARY_BRANCH ($MAIN_SHA) — exit $?"
  [ -f "$REPO_DIR/dist/cli.js" ] || die "build produced no dist/cli.js"
  echo "$MAIN_SHA" > "$built_marker"
}

# --------------------------------------------------------------------- sandbox

# One sandbox per run, shared by every platform leg: the clodex home is seeded once (the same
# favourites decide which patch sites run everywhere) and each platform gets its own subdirectory
# under it. The per-platform download lives in the platforms library.
prepare_sandbox() {
  WORK="$(mktemp -d "$CACHE_DIR/work.XXXXXX")"
  WORK="$(cd "$WORK" && pwd -P)"   # resolved, so the containment checks are exact
  mkdir -p "$WORK/clodex-home" "$WORK/tweakcc" "$WORK/home"

  # Model config drives which patch sites are exercised, so borrow the real favourites,
  # aliases and model registry. None of these files hold credentials: providers.json stores
  # only a keyring *reference* (authRef), and the patcher never reads credentials.
  if [ -f "$REAL_CLODEX_HOME/config.json" ]; then
    jq '{favoriteModels, modelAliases}' "$REAL_CLODEX_HOME/config.json" > "$WORK/clodex-home/config.json" \
      || die "cannot read $REAL_CLODEX_HOME/config.json"
  else
    printf '{}\n' > "$WORK/clodex-home/config.json"
  fi
  local favs
  favs="$(jq -r '(.favoriteModels // []) | length' "$WORK/clodex-home/config.json")"
  if [ "$favs" -eq 0 ]; then
    # Without favourites `clodex patch` has nothing to bake in and refuses to run, so there is
    # nothing to learn from this release. Not a Claude Code problem — don't burn a session on it.
    warn_persisting no-favourites \
":warning: clodex patch canary is idle: $REAL_CLODEX_HOME/config.json lists no favourite models, so \`clodex patch\` has nothing to apply and new Claude Code releases are going untested. Add a favourite (\`clodex models\`) to re-arm it." \
":rotating_light: *clodex patch canary has been idle for {hours}h* — $REAL_CLODEX_HOME/config.json has listed no favourite models since {since}, so \`clodex patch\` still has nothing to apply and *no Claude Code release has been tested in {hours}h*. Nothing is broken, but the canary is not guarding you either: add a favourite with \`clodex models\` to re-arm it."
    exit 0
  fi
  clear_warning no-favourites
  for f in providers.json models-dev-cache.json; do
    if [ -f "$REAL_CLODEX_HOME/$f" ]; then cp "$REAL_CLODEX_HOME/$f" "$WORK/clodex-home/$f"; fi
  done
  # Which sites even run depends on this config, so a baseline is only comparable against a run
  # seeded the same way.
  CONFIG_FP="$(shasum -a 256 "$WORK/clodex-home/config.json" | awk '{print $1}')"
  log "sandbox $WORK seeded with $favs favourite model(s), config fingerprint ${CONFIG_FP:0:8}"
}

# Both patch streams with @clack/prompts decoration removed. The same report is written twice —
# raw on stderr by --trace, and prefixed with box drawing on stdout by clack — so each interesting
# line is re-anchored on the token that starts it and duplicates are dropped. Deleting the
# decoration characters instead would also destroy the em dash that separates a site from its
# reason: their UTF-8 bytes overlap, and a byte-wise character class eats both.
report_lines() {
  cat "$PATCH_OUT" "$PATCH_ERR" 2>/dev/null |
    LC_ALL=C sed -E -e 's/^.*((OK|SKIP|FAIL)[[:space:]]+PATCH )/\1/' \
                    -e 's/^.*(Patch failed: )/\1/' \
                    -e 's/^.*(clodex patch: [0-9]+ applied)/\1/' \
                    -e 's/^.*(clodex patch: FAILED patches: )/\1/' |
    LC_ALL=C sed -e 's/[[:space:]]*$//' |
    awk '!seen[$0]++'
}

parse_sites() {
  # No matching lines is itself a finding (the patch aborted early), not a script error.
  { report_lines | grep -E '^(OK|SKIP|FAIL)[[:space:]]+PATCH ' || true; } |
    awk '{ status = $1; sub(/^[A-Z]+[[:space:]]+/, ""); name = $0;
           idx = index(name, " — "); if (idx > 0) name = substr(name, 1, idx - 1);
           printf "%s\t%s\n", status, name }' |
    jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {key: .[1], value: .[0]})
              | from_entries'
}

markers_in_binary() { # markers_in_binary <binary>
  { LC_ALL=C grep -a -o 'ccpatch:[a-zA-Z0-9_-]*' "$1" 2>/dev/null || true; } |
    sort -u | jq -R -s 'split("\n") | map(select(length > 0))'
}

add_reason() { REASONS="$REASONS- $1
"; }

# Everything the patch report alone can tell us: reads $PATCH_OUT, $PATCH_ERR, $PATCH_EXIT and
# $SITES, appends to $REASONS. Split out so it can be exercised against captured output without
# downloading a 300 MB binary — see clodex-patch-canary-selftest.sh.
evaluate_report() {
  [ "$PATCH_EXIT" -eq 0 ] || add_reason "\`clodex patch\` exited $PATCH_EXIT"

  PATCH_FAILED_MSG="$( { report_lines | grep '^Patch failed: ' || true; } | head -1)"
  [ -z "$PATCH_FAILED_MSG" ] || add_reason "$PATCH_FAILED_MSG"

  FAILED_SITES="$(printf '%s' "$SITES" | jq -r 'to_entries | map(select(.value == "FAIL") | .key) | join("; ")')"
  [ -z "$FAILED_SITES" ] || add_reason "patch sites FAILED: $FAILED_SITES"

  SUMMARY_LINE="$( { report_lines | grep -E '^clodex patch: [0-9]+ applied, [0-9]+ skipped, [0-9]+ failed' || true; } | tail -1)"
  if [ -z "$SUMMARY_LINE" ]; then
    add_reason "no per-site summary was printed — the patch aborted before it could report ($( { report_lines | grep -iE 'error|failed|refus' || true; } | head -3 | tr '\n' ' ' | sed 's/  */ /g'))"
  else
    log "summary: $SUMMARY_LINE"
    FAILED_COUNT="$(printf '%s' "$SUMMARY_LINE" | sed -E 's/.*, ([0-9]+) failed.*/\1/')"
    if [ "${FAILED_COUNT:-0}" -gt 0 ] && [ -z "$FAILED_SITES" ]; then
      add_reason "the summary reports $FAILED_COUNT failed site(s)"
    fi
  fi
}

# A ready-to-run reproduction, so that "re-run the patch" never requires assembling four
# environment variables by hand. A background session told to verify a fix will reach for the
# easiest command it has; that command must be one that cannot touch the real install.
write_repro_script() {
  local script="$WORK/repro.sh"
  # The values are injected as %q-escaped assignments and the body is a quoted here-doc, so a path
  # or URL containing shell syntax stays data. An unquoted here-doc would paste those bytes in as
  # code, to be evaluated when the investigation runs this script.
  {
    printf '#!/usr/bin/env bash\n'
    printf '# Reproduce any of the clodex-patch-canary legs for Claude Code %s in a throwaway sandbox.\n' "$VERSION"
    printf '#\n'
    printf '# It seeds a fresh directory from the release bytes and redirects HOME, CLODEX_HOME,\n'
    printf '# TWEAKCC_CONFIG_DIR and TWEAKCC_CC_INSTALLATION_PATH, so it cannot touch the installed\n'
    printf '# Claude Code, ~/.clodex or ~/.tweakcc.\n'
    printf '#\n'
    printf '#   %s/repro.sh                              # this Mac, clodex origin/main\n' "$WORK"
    printf '#   %s/repro.sh linux-arm64                  # that leg, exactly as the canary ran it\n' "$WORK"
    printf '#   %s/repro.sh linux-arm64 <your-worktree>  # the same leg against your fix\n' "$WORK"
    printf '#\n'
    printf '# The leg matches the platform: the host runs the real `clodex patch`; linux-arm64 and\n'
    printf '# linux-arm64-musl run it inside a container; the rest run the bundle-patch probe,\n'
    printf '# scripts/probe-patch-mechanism.mjs. Your worktree does NOT need to be built first —\n'
    printf '# the host leg builds it if dist is missing and the container legs always rebuild.\n'
    printf '#\n'
    printf 'set -Eeuo pipefail\n'
    printf 'CANARY_WORK=%q\n' "$WORK"
    printf 'CANARY_REPO=%q\n' "$REPO_DIR"
    printf 'CANARY_VERSION=%q\n' "$VERSION"
    printf 'CANARY_HOST_PLATFORM=%q\n' "$(host_platform)"
    cat <<'REPRO_BODY'
PLATFORM="${1:-$CANARY_HOST_PLATFORM}"
REPO="${2:-$CANARY_REPO}"

ENTRY="$(jq -s -c --arg p "$PLATFORM" 'map(select(.platform == $p)) | last // empty' \
          "$CANARY_WORK/matrix.jsonl")"
[ -n "$ENTRY" ] || {
  echo "no leg for '$PLATFORM' in this run. Platforms tested:" >&2
  jq -s -r 'map("  \(.platform) [\(.mode)] \(.status)")[]' "$CANARY_WORK/matrix.jsonl" >&2
  exit 1
}
# The leg this platform actually got. MODE=container overrides it: if the canary ran without
# Docker, the recorded leg is a probe, and a probe never starts the binary it patched.
MODE="${MODE:-$(printf '%s' "$ENTRY" | jq -r '.mode')}"
TARBALL="$(printf '%s' "$ENTRY" | jq -r '.tarball')"
MEMBER=claude
case "$PLATFORM" in win32-*) MEMBER=claude.exe ;; esac

# Each run copies a ~300 MB binary; keep only the two most recent.
{ ls -1dt "$CANARY_WORK"/repro.?????? 2>/dev/null || true; } | tail -n +3 | while read -r stale; do
  if [ -d "$stale" ]; then rm -rf "$stale"; fi
done

SB="$(mktemp -d "$CANARY_WORK/repro.XXXXXX")"
mkdir -p "$SB/install" "$SB/clodex-home" "$SB/tweakcc" "$SB/home" "$SB/out"

# The canary keeps a failing leg's binary but deletes a passing one's, and the host leg's pristine
# backup is the most trustworthy source of all — it is the bytes clodex itself snapshotted.
if [ -f "$CANARY_WORK/tweakcc/native-binary.backup" ] && [ "$PLATFORM" = "$CANARY_HOST_PLATFORM" ]; then
  cp "$CANARY_WORK/tweakcc/native-binary.backup" "$SB/install/$MEMBER"
elif [ -f "$CANARY_WORK/$PLATFORM/install/$MEMBER" ]; then
  cp "$CANARY_WORK/$PLATFORM/install/$MEMBER" "$SB/install/$MEMBER"
elif [ -f "$CANARY_WORK/$PLATFORM/$MEMBER" ]; then
  cp "$CANARY_WORK/$PLATFORM/$MEMBER" "$SB/install/$MEMBER"
else
  echo "no $PLATFORM binary left in the sandbox — re-downloading $CANARY_VERSION"
  [ -n "$TARBALL" ] || { echo "and no tarball URL was recorded for it" >&2; exit 1; }
  curl -fsSL --retry 3 -o "$SB/claude.tgz" "$TARBALL"
  tar xzf "$SB/claude.tgz" -C "$SB/install" --strip-components=1 "package/$MEMBER"
  rm -f "$SB/claude.tgz"
fi
chmod +x "$SB/install/$MEMBER"

# A container leg keeps its binary already patched. Patching a patched binary is a different
# experiment from the one that failed, so say so rather than quietly running it.
if [ -f "$CANARY_WORK/$PLATFORM/install/$MEMBER" ] &&
   LC_ALL=C grep -aq 'ccpatch:' "$SB/install/$MEMBER" 2>/dev/null; then
  echo "NOTE: this $PLATFORM binary is already patched — re-download for a pristine run:" >&2
  echo "      curl -fsSL '$TARBALL' | tar xzf - -C <dir> --strip-components=1 package/$MEMBER" >&2
fi

cp "$CANARY_WORK/clodex-home/config.json" "$SB/clodex-home/"
for f in providers.json models-dev-cache.json; do
  if [ -f "$CANARY_WORK/clodex-home/$f" ]; then cp "$CANARY_WORK/clodex-home/$f" "$SB/clodex-home/"; fi
done

echo "clodex:   $REPO"
echo "platform: $PLATFORM [$MODE]"
echo "sandbox:  $SB   (the binary under test is $SB/install/$MEMBER)"

case "$MODE" in
  host)
    # Rebuild whenever a worktree was named. Building only when dist/ is ABSENT means the second
    # and every later run of a fix-verify loop silently tests the previous build — which reads as
    # "my change had no effect", or worse, as a pass.
    if [ -n "${2:-}" ] || [ ! -f "$REPO/dist/cli.js" ]; then
      ( cd "$REPO" && corepack pnpm install --frozen-lockfile && corepack pnpm build )
    fi
    cd "$REPO"
    exec env -u CLODEX_TRACE -u FORCE_COLOR -u CLICOLOR_FORCE \
      HOME="$SB/home" \
      CLODEX_HOME="$SB/clodex-home" \
      TWEAKCC_CONFIG_DIR="$SB/tweakcc" \
      TWEAKCC_CC_INSTALLATION_PATH="$SB/install/$MEMBER" \
      DISABLE_AUTOUPDATER=1 \
      node "$REPO/dist/cli.js" patch --trace
    ;;
  probe)
    # The probe imports tweakcc from node_modules, so a freshly created worktree — which is exactly
    # what the investigation prompt tells the agent to make — needs its dependencies. No build:
    # the probe runs from source.
    [ -d "$REPO/node_modules/tweakcc" ] || ( cd "$REPO" && corepack pnpm install --frozen-lockfile )
    cd "$REPO"
    exec node "$REPO/scripts/probe-patch-mechanism.mjs" "$SB/install/$MEMBER" \
      --label "$PLATFORM" --expect-version "$CANARY_VERSION" --scratch "$SB/probe"
    ;;
  container)
    IMAGE="$(printf '%s' "$ENTRY" | jq -r '.detail.image // ""')"
    ARCH="$(printf '%s' "$ENTRY" | jq -r '.detail.dockerPlatform // ""')"
    [ -n "$IMAGE" ] || case "$PLATFORM" in
      *-musl) IMAGE=node:24-alpine ;; *) IMAGE=node:24-bookworm ;;
    esac
    [ -n "$ARCH" ] || case "$PLATFORM" in
      *-x64|*-x64-musl) ARCH=linux/amd64 ;; *) ARCH=linux/arm64 ;;
    esac
    cp "$CANARY_WORK/container-run.sh" "$SB/container-run.sh"
    tar -cf "$SB/repo.tar" -C "$REPO" --exclude=node_modules --exclude=.git --exclude=dist .
    echo "image:    $IMAGE ($ARCH)"
    docker run --rm --platform "$ARCH" -v "$SB":/w "$IMAGE" sh /w/container-run.sh
    echo "--- report ---"
    cat "$SB/out/patch.stdout" "$SB/out/patch.stderr" 2>/dev/null |
      LC_ALL=C sed -E -e 's/^.*((OK|SKIP|FAIL)[[:space:]]+PATCH )/\1/' \
                      -e 's/^.*(Patch failed: )/\1/' \
                      -e 's/^.*(clodex patch: [0-9]+ applied)/\1/' |
      grep -aE '^(OK|SKIP|FAIL)[[:space:]]+PATCH |^clodex patch: |^Patch failed: ' | awk '!seen[$0]++'
    echo "patched binary: $(cat "$SB/out/patched-version.txt" 2>/dev/null | head -1) (exit $(cat "$SB/out/patched-version.exit" 2>/dev/null || echo '?'))"
    # Exit with what `clodex patch` exited with. Printing the failure and returning 0 lets a
    # verification loop that branches on status treat a failed container patch as green.
    exit "$(cat "$SB/out/patch.exit" 2>/dev/null || echo 1)"
    ;;
  *)
    echo "platform $PLATFORM was not tested this run (mode: $MODE)" >&2
    exit 1
    ;;
esac
REPRO_BODY
  } > "$script"
  chmod +x "$script"
  log "wrote one-command reproduction: $script"
}

# ------------------------------------------------------------------ investigate

investigation_prompt() {
  local version="$1" reasons="$2" logfile="$3"
  cat <<EOF
You are triaging an automated canary failure. Be rigorous: this ends in a pull request that changes
how every clodex user's Claude Code binary gets patched.

WHAT HAPPENED
Claude Code $version was published. An automated canary downloaded it for EVERY published platform
into a throwaway sandbox and tested \`clodex patch\` against each one, built from a freshly fetched
origin/main ($MAIN_SHA — $MAIN_SUBJECT). It did not come out clean:

$reasons

THE PLATFORM MATRIX
$(jq -s -r 'map("  \(.platform)\t[\(.mode)]\t\(.status)")[]' "$MATRIX")

Three kinds of leg, and they prove different things — read this before concluding anything about
scope:
  host       the real \`clodex patch\` on this Mac, all patch sites end to end.
  container  the real \`clodex patch\` inside a native-arch Linux container. \`clodex patch\`
             resolves the version by EXECUTING the binary, so a foreign binary can only go through
             the real command this way.
  probe      scripts/probe-patch-mechanism.mjs — it applies every clodex patch site to the
             bundle extracted from that build, repacks the result, and runs the same
             shim/read/repack/restore cycle src/patcher.ts runs, all without executing the
             binary. It covers the anchors AND the executable format; it never starts the
             patched binary.
A failure confined to one executable format (ELF, Mach-O, PE) points at src/bun-entry-module.ts or
tweakcc's repack, not at the patch anchors. A failure on every platform at once points at the
anchors in src/patch-transforms.ts. If instead the reasons say a check that passed on an earlier
release now SKIPs, the release is patchable and an ANCHOR DRIFTED: diff the two bundles with
scripts/extract-cc-bundles.mjs (last clean release: $BASE_VERSION) before touching anything.

Two limits on what a green leg proves, so you do not report a fix as verified when it is not:
- A leg recorded as \`probe\` never STARTS the binary it patched. It proves the anchors matched and
  the repack round-tripped; it cannot prove the patched binary runs, and it cannot tell an anchor
  that bound to the wrong function from one that bound to the right one. Where that distinction
  decides your fix, re-run the leg as
  \`MODE=container $WORK/repro.sh <platform> <your-worktree>\`, and if Docker is unavailable, say so
  in your concluding Slack rather than calling it verified.
- No leg ever EXECUTES an x64 ELF binary; x64 coverage is bytes-only by design. Check x64
  reasoning against the linux-arm64 container leg.

EVIDENCE (read these first)
- Full canary log, including every leg's report and both output streams:
  $logfile
- The full matrix as JSON, one object per platform (reasons, sizes, markers, per-site results):
  $MATRIX
- The sandbox was deliberately preserved so you can reproduce without touching anything real:
  $WORK
    $WORK/<platform>/      one directory per platform. A FAILING leg's binary is kept; a passing
                           one's was deleted to save ~300 MB each. Container legs also leave
                           out/patch.stdout, out/patch.stderr and out/docker.log.
    $WORK/clodex-home      the CLODEX_HOME every leg used
    $WORK/tweakcc          the pristine backup the host leg made
- The clodex build under test: $REPO_DIR (detached at origin/main)

REPRODUCE — ONE COMMAND, USE THIS ONE
  $WORK/repro.sh <platform>                    # exactly what the canary ran for that platform
  $WORK/repro.sh <platform> <your-worktree>    # the same leg, against your fix
It picks the right leg for the platform, seeds a fresh sandbox, and redirects HOME, CLODEX_HOME,
TWEAKCC_CONFIG_DIR and TWEAKCC_CC_INSTALLATION_PATH for you. With no arguments it runs this Mac's
leg against origin/main. Your worktree does not need to be built first. Read it before you run it;
if you need a variant, copy it and edit the copy.

Fix the ROOT CAUSE once. Several platforms failing together is almost always one defect — the
last time this happened, all four ELF builds broke on a single line in the restore sweep. Do not
open four PRs, and do not fix one platform in a way that only works for that platform. Verify the
fix by re-running the repro for EVERY platform in the matrix above, failing and passing alike:
a change to the binary handling can break a format that was fine.

HARD CONSTRAINTS
- **Never run a bare \`clodex patch\` or \`node dist/cli.js patch\`.** With no
  TWEAKCC_CC_INSTALLATION_PATH set, clodex resolves the target to ~/.local/bin/claude and would
  patch the human's REAL, IN-USE Claude Code install, writing real backups into ~/.tweakcc and real
  state into ~/.clodex. Your environment does NOT have those redirections set — only repro.sh does.
  Every patch invocation goes through $WORK/repro.sh or a copy of it.
- NEVER write to ~/.local/bin/claude, ~/.local/share/claude, ~/.clodex or ~/.tweakcc by any other
  means either — no --restore, no cp, no chmod.
- Do NOT work in the $CLODEX_WORKING_COPY working copy — it belongs to a human and may hold
  unrelated in-progress work. Create a git worktree off a freshly fetched origin/main
  (\`git -C $CLODEX_WORKING_COPY fetch origin\` then
  \`git -C $CLODEX_WORKING_COPY worktree add ../clodex-canary-$version -b fix/patch-cc-$version origin/main\`)
  and do all work there.

WHAT TO DO
1. Post a Slack message the moment you have a first read on the cause (see NOTIFY below).
2. Diagnose the root cause in the Claude Code $version bundle, not the symptom. Read
   .claude/docs/patcher.md and .claude/docs/claude-code-internals.md first; the transforms in
   src/patch-transforms.ts are hard-won and change only with byte-for-byte evidence on a real
   binary. scripts/extract-cc-bundles.mjs extracts a bundle for inspection.
3. Fix it, following CLAUDE.md and .claude/skills/pr-verification/SKILL.md in full — including
   bumping PATCH_TRANSFORMS_VERSION if the transform set changed materially, and a test that fails
   before the fix and passes after.
4. Verify: \`pnpm typecheck && pnpm test && pnpm build\`, then re-run every platform in the matrix —
   \`for p in $(jq -s -r 'map(.platform) | join(" ")' "$MATRIX"); do $WORK/repro.sh \$p <your-worktree>; done\` —
   and confirm each one comes out clean on a pristine $version copy.
5. Run an adversarial review panel over your own change before pushing, per the pr-verification
   skill. Fix what it finds; re-review after changes.
6. Open a PR against main with \`gh pr create\`. Write the summary line for a user who has never read
   the source, per the commit-message rules in CLAUDE.md.

NOTIFY (both of these are required)
Post to Slack with:
  $SLACK_PYTHON $SLACK_PY notify $CANARY_SLACK_TO "<message>"
- At the start: one line on what you think broke and that you are on it.
- At the end, whichever applies: the PR URL, or the obstacle that stopped you and what you need. If
  you cannot fix it, still report the diagnosis — a precise "here is why it broke and why the fix is
  not obvious" is a good outcome.
Do not finish without sending the concluding message.
EOF
}

launch_investigation() {
  local version="$1" reasons="$2" logfile="$3"
  local session_name prompt out session_id
  session_name="clodex-patch-canary $version $(date +%Y%m%d%H%M)"
  SESSION_NAME="$session_name"
  SESSION_ID=""
  prompt="$(investigation_prompt "$version" "$reasons" "$logfile")"

  if [ "$opt_launch" -ne 1 ]; then
    log "--no-launch: skipping the background Claude session. Prompt would have been:"
    printf '%s\n' "$prompt"
    return 1
  fi
  # One investigation at a time is the whole point of the deferral; --force must not break it by
  # starting a second one alongside a session that is still tracked.
  if [ "$(state_read | jq -r '.inflight // "null"')" != "null" ]; then
    log "WARN: an investigation is already tracked — not launching a second one"
    slack ":warning: clodex patch canary found that Claude Code $version breaks \`clodex patch\`, but an investigation of $(state_read | jq -r '.inflight.version') is already running, so no second session was started. Details: $logfile" || true
    return 1
  fi
  if [ ! -x "$CLAUDE_BIN" ]; then
    log "WARN: $CLAUDE_BIN not executable — cannot start the investigation"
    slack ":warning: clodex patch canary could not start an investigation for Claude Code $version — $CLAUDE_BIN is missing. Log: $logfile" || true
    return 1
  fi

  # The prompt must be non-empty AND must survive argument parsing. Both have failed:
  # `--add-dir <directories...>` is VARIADIC, so a prompt passed after it is silently swallowed
  # as one more directory and the session starts idle, doing nothing, until a human notices.
  # `--` terminates the variadic list. Do not remove it, and do not let --add-dir be the last
  # option before the prompt.
  if [ -z "${prompt//[[:space:]]/}" ]; then
    log "WARN: refusing to launch an investigation with an empty prompt"
    slack ":warning: clodex patch canary built an EMPTY investigation prompt for Claude Code $version, so no session was started. This is a canary bug. Log: $logfile" || true
    return 1
  fi

  log "launching background Claude session: $session_name"
  set +e
  out="$(cd "$CLODEX_WORKING_COPY" && "$CLAUDE_BIN" --bg --name "$session_name" \
        --dangerously-skip-permissions \
        --model opus --effort high \
        --add-dir "$HOME/dev/general" --add-dir "$STATE_DIR" --add-dir "$CACHE_DIR" \
        -- "$prompt" 2>&1)"
  local rc=$?
  set -e
  printf '%s\n' "$out"
  if [ $rc -ne 0 ]; then
    log "WARN: claude --bg failed (exit $rc)"
    slack ":warning: clodex patch canary could not start an investigation for Claude Code $version (claude --bg exit $rc). Log: $logfile" || true
    return 1
  fi
  # Claude Code prints this when it got no prompt. The session exists, is tracked as inflight,
  # and blocks every later investigation via the one-at-a-time guard — while doing nothing at all.
  # Treat it as a launch failure rather than a success.
  if printf '%s' "$out" | grep -q 'idle — send a prompt to start'; then
    log "WARN: the session started IDLE — the prompt did not reach Claude Code"
    slack ":warning: clodex patch canary started an investigation session for Claude Code $version that received NO PROMPT and is idle. This is a canary bug — the session is doing nothing. Log: $logfile" || true
    return 1
  fi
  session_id="$(printf '%s' "$out" | sed -n 's/^backgrounded · \([0-9a-f]\{6,\}\) · .*/\1/p' | head -1)"
  SESSION_ID="$session_id"
  log "investigation session id: ${session_id:-unknown}"

  state_update '.inflight = {version: $v, sessionName: $n, sessionId: $i, startedAt: $t, startedEpoch: $e, log: $l}' \
    --arg v "$version" --arg n "$session_name" --arg i "${session_id:-}" \
    --arg t "$(now_iso)" --argjson e "$(now_epoch)" --arg l "$logfile"
}

# Is the recorded investigation still working? Echoes one of:
#   working  — the session exists and is not in a terminal state
#   stopped  — the session was killed before it finished
#   finished — the session completed its turn
#   missing  — the query worked and the session is not there any more
#   unknown  — the query itself failed; we cannot tell
# "unknown" must never be collapsed into "missing": a daemon restarting after a reboot would then
# release the deferral and let a second investigation start alongside the first.
inflight_status() {
  local session_name="$1" session_id="$2" raw entry state
  [ -x "$CLAUDE_BIN" ] || { echo unknown; return 0; }
  raw="$("$CLAUDE_BIN" agents --json --all 2>/dev/null || true)"
  printf '%s' "$raw" | jq -e 'type == "array"' >/dev/null 2>&1 || { echo unknown; return 0; }
  entry="$(printf '%s' "$raw" |
    jq -c --arg n "$session_name" --arg i "$session_id" \
      'map(select((.name == $n) or ($i != "" and .id == $i))) | last' 2>/dev/null || echo null)"
  if [ -z "$entry" ] || [ "$entry" = "null" ]; then echo missing; return 0; fi
  state="$(printf '%s' "$entry" | jq -r '.state // ""')"
  [ "$state" = "stopped" ] && { echo stopped; return 0; }
  for s in $TERMINAL_AGENT_STATES; do
    [ "$state" = "$s" ] && { echo finished; return 0; }
  done
  echo working
}

# ------------------------------------------------------------------------ main

# Sourcing the script gives you the helpers above and nothing else — that is how the self-test
# drives the report parsing without running a patch.
if [ "${CANARY_SOURCE_ONLY:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

while [ $# -gt 0 ]; do
  case "$1" in
    --status) opt_status=1 ;;
    --force) opt_force=1 ;;
    --no-launch) opt_launch=0 ;;
    --no-slack) opt_slack=0 ;;
    --keep-work) opt_keep=1 ;;
    --platforms) shift; opt_platforms="${1:-}"; [ -n "$opt_platforms" ] || die "--platforms needs a value" ;;
    --no-container) opt_container=0 ;;
    --version) shift; opt_version="${1:-}"; [ -n "$opt_version" ] || die "--version needs a value" ;;
    --retriage) shift; opt_retriage="${1:-}"; [ -n "$opt_retriage" ] || die "--retriage needs a value" ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown option: $1" ;;
  esac
  shift
done

mkdir -p "$STATE_DIR" "$LOG_DIR" "$CACHE_DIR"

if [ "$opt_status" -eq 1 ]; then
  # Same guard the real run uses: without it a corrupt state.json surfaces as a raw jq parse error
  # rather than the "move the file aside to reset it" diagnosis.
  validate_state
  state_read | jq --argjson base "$(baseline_platforms)" \
    '{inflight,
      lastCompleteVersion,
      baseline: {version: (.baseline.version // null),
                 platforms: ($base | with_entries(.value |= (.version // "?")))},
      pending,
      versions: (.versions | to_entries | sort_by(.key)
                 | map(.value |= {status, at, platforms}) | from_entries)}'
  exit 0
fi

# The log is opened before anything else can decide to exit, so that lock contention and toolchain
# problems land in the run log too, not only on launchd's stdout.
RUN_LOG="$LOG_DIR/$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$RUN_LOG") 2>&1
log "$CANARY_NAME starting (pid $$, channel $CANARY_CHANNEL)"

trap cleanup EXIT
preflight
validate_platforms
acquire_lock
validate_state
clear_warning stuck-lock
housekeeping

# ---- 1. is a previous failure still being worked? --------------------------------------------
# Checked before --retriage does anything: forgetting a verdict and then exiting through the
# deferral would leave the version untested AND unrecorded.
INFLIGHT="$(state_read | jq -c '.inflight // null')"
if [ "$INFLIGHT" != "null" ] && [ -n "$opt_retriage" ] && [ "$opt_force" -ne 1 ]; then
  IF_STATE_PRE="$(inflight_status \
    "$(printf '%s' "$INFLIGHT" | jq -r '.sessionName')" \
    "$(printf '%s' "$INFLIGHT" | jq -r '.sessionId // ""')")"
  if [ "$IF_STATE_PRE" = "working" ] || [ "$IF_STATE_PRE" = "unknown" ]; then
    die "an investigation of $(printf '%s' "$INFLIGHT" | jq -r '.version') is still running — re-triaging now would run two at once. Wait for it, stop it, or pass --force."
  fi
fi

if [ "$INFLIGHT" != "null" ] && [ "$opt_force" -ne 1 ]; then
  IF_VER="$(printf '%s' "$INFLIGHT" | jq -r '.version')"
  IF_NAME="$(printf '%s' "$INFLIGHT" | jq -r '.sessionName')"
  IF_ID="$(printf '%s' "$INFLIGHT" | jq -r '.sessionId // ""')"
  IF_EPOCH="$(printf '%s' "$INFLIGHT" | jq -r '.startedEpoch // 0')"
  IF_AGE_H=$(( ( $(now_epoch) - IF_EPOCH ) / 3600 ))
  IF_STATE="$(inflight_status "$IF_NAME" "$IF_ID")"
  log "in-flight investigation for $IF_VER ($IF_NAME): $IF_STATE, ${IF_AGE_H}h old"

  IF_BUSY=0
  if [ "$IF_STATE" = "working" ] || [ "$IF_STATE" = "unknown" ]; then IF_BUSY=1; fi

  if [ "$IF_BUSY" -eq 1 ] && [ "$IF_AGE_H" -lt "$CANARY_MAX_INFLIGHT_HOURS" ]; then
    NEXT="$( { registry_doc "$CANARY_PKG" || true; } | jq -r --arg c "$CANARY_CHANNEL" '."dist-tags"[$c] // empty' 2>/dev/null || true)"
    if [ -n "$NEXT" ] && [ "$NEXT" != "$IF_VER" ] &&
       case "$(state_read | jq -r --arg v "$NEXT" '.versions[$v].status // "none"')" in
         none|retriage|partial) true ;; *) false ;;
       esac; then
      if [ "$(state_read | jq -r --arg v "$NEXT" '.deferred[$v] // "no"')" != "notified" ]; then
        # "whatever is newest then", not "$NEXT": if further releases land while the investigation
        # runs, only the newest is tested — that is the one the answer "is it safe to update?"
        # is about.
        if slack ":hourglass_flowing_sand: clodex patch canary is holding off on Claude Code *$NEXT* — the investigation of *$IF_VER* is still running (session \`$IF_NAME\`, ${IF_AGE_H}h so far). Whatever is newest when that finishes gets triaged then; releases in between are skipped.
Nothing is broken by this, you just will not hear whether *$NEXT* is safe until then."; then
          state_update '.deferred = ((.deferred // {}) + {($v): "notified"})' --arg v "$NEXT"
        fi
      fi
      log "deferring $NEXT until the $IF_VER investigation finishes"
    fi
    exit 0
  fi

  if [ "$IF_BUSY" -eq 1 ]; then
    # The escape hatch from a wedged session. Stop it rather than merely forgetting it: two live
    # investigations at once is exactly what the deferral exists to prevent.
    log "WARN: investigation for $IF_VER has run ${IF_AGE_H}h ($IF_STATE) — stopping it and moving on"
    if [ -n "$IF_ID" ] && [ -x "$CLAUDE_BIN" ]; then
      "$CLAUDE_BIN" stop "$IF_ID" >/dev/null 2>&1 || log "could not stop session $IF_ID"
    fi
    slack ":warning: clodex patch canary: the investigation of Claude Code *$IF_VER* has been running ${IF_AGE_H}h without finishing, so it has been stopped (session \`$IF_NAME\`) and triage of newer releases resumes. *$IF_VER* is still recorded as failing — re-check it with \`clodex-patch-canary.sh --retriage $IF_VER\` once it is fixed." || true
  elif [ "$IF_STATE" = "stopped" ]; then
    log "investigation for $IF_VER was stopped before finishing — clearing"
    slack ":black_square_for_stop: clodex patch canary: the investigation of Claude Code *$IF_VER* was stopped before it finished. *$IF_VER* stays recorded as failing and will not be re-tested on its own — run \`clodex-patch-canary.sh --retriage $IF_VER\` when you want another look." || true
  else
    log "investigation for $IF_VER has concluded ($IF_STATE) — clearing"
  fi

  # The investigation ran with --dangerously-skip-permissions and the real HOME. Its fence is the
  # prompt plus the ready-made sandbox repro, which is persuasion, not enforcement — so check
  # afterwards whether the real install actually moved while it was working.
  IF_FP_BEFORE="$(state_read | jq -r '.realStateAtInvestigation // ""')"
  IF_FP_NOW="$(real_state_fingerprint)"
  if [ -n "$IF_FP_BEFORE" ] && [ "$IF_FP_BEFORE" != "$IF_FP_NOW" ]; then
    log "WARN: real Claude Code / clodex / tweakcc state changed while the $IF_VER investigation ran"
    slack ":eyes: clodex patch canary: your installed Claude Code, ~/.clodex or ~/.tweakcc changed while the *$IF_VER* investigation session was running. If that was you (an update, or your own \`clodex patch\`), ignore this. If it was not, the session touched your real install despite being told not to — check \`clodex patch --restore\` and the session transcript." || true
  fi

  state_update '.versions[$v] = ((.versions[$v] // {}) + {investigationEndedAt: $t, investigationEndState: $s})
                | .inflight = null | del(.realStateAtInvestigation)' \
    --arg v "$IF_VER" --arg t "$(now_iso)" --arg s "$IF_STATE"
elif [ "$INFLIGHT" != "null" ]; then
  log "--force: ignoring the in-flight investigation record (it stays recorded; no second investigation will be launched)"
fi

if [ -n "$opt_retriage" ]; then
  # Mark it retestable rather than deleting it. A later exit that records nothing — the
  # not-every-platform-has-published path is one — would otherwise leave the version with no record
  # at all, taking the previous run's sandbox, reasons and log pointers with it.
  log "re-opening $opt_retriage for triage (previous verdict kept until a new one replaces it)"
  state_update '.versions[$v] = ((.versions[$v] // {}) + {status: "retriage",
                                                          previousStatus: (.versions[$v].status // "none")})
                | .deferred = ((.deferred // {}) | del(.[$v]))' --arg v "$opt_retriage"
  [ -n "$opt_version" ] || opt_version="$opt_retriage"
fi

# ---- 2. what is the newest release? ----------------------------------------------------------
if [ -n "$opt_version" ]; then
  VERSION="$opt_version"
  log "testing explicitly requested version $VERSION"
else
  TRANSIENT_STEP="asking the npm registry which Claude Code release is newest"
  VERSION="$(registry_doc "$CANARY_PKG" | jq -r --arg c "$CANARY_CHANNEL" '."dist-tags"[$c] // empty')"
  TRANSIENT_STEP=""
  # An empty dist-tag is the registry answering with something wrong, not failing to answer — that
  # is worth the loud alert, so it is reported after the transient marker is cleared.
  [ -n "$VERSION" ] || die "registry returned no '$CANARY_CHANNEL' dist-tag for $CANARY_PKG"
  log "$CANARY_PKG@$CANARY_CHANNEL is $VERSION"
fi

PREV="$(state_read | jq -r --arg v "$VERSION" '.versions[$v].status // "none"')"
if [ "$PREV" = "retriage" ]; then
  log "$VERSION was re-opened with --retriage — testing it"
elif [ "$PREV" = "partial" ] && [ "$opt_force" -ne 1 ]; then
  # A partial run established nothing about the platforms it could not reach, so it is not a
  # verdict and must not close the version off — but neither may it re-download 700 MB every hour
  # while Docker stays quit, so it settles onto a slower cadence until it can finish.
  PREV_AGE_H=$(( ( $(now_epoch) - $(state_read | jq -r --arg v "$VERSION" '.versions[$v].atEpoch // 0') ) / 3600 ))
  if [ "$PREV_AGE_H" -lt "$CANARY_PARTIAL_RETRY_HOURS" ]; then
    log "$VERSION was triaged with incomplete coverage ${PREV_AGE_H}h ago — retrying in $(( CANARY_PARTIAL_RETRY_HOURS - PREV_AGE_H ))h"
    exit 0
  fi
  log "$VERSION was only partly covered ${PREV_AGE_H}h ago — trying again for full coverage"
elif [ "$PREV" != "none" ] && [ "$opt_force" -ne 1 ]; then
  log "$VERSION already triaged ($PREV) — nothing to do"
  exit 0
fi

# ---- 3. clodex from a freshly fetched origin/main ---------------------------------------------
sync_repo
NODE_BIN_DIR="$(resolve_node_bin_dir)" || die "cannot find a node to build with"
export PATH="$NODE_BIN_DIR:$PATH"
log "node $("$NODE_BIN_DIR/node" -v) from $NODE_BIN_DIR"
build_repo

# ---- 4. sandbox + the platform matrix ---------------------------------------------------------
# The version is stamped the first time it is SEEN, not the first time it is fully testable, so
# that "have the other platform packages published yet?" is asked against a real elapsed time.
FIRST_SEEN="$(state_read | jq -r --arg v "$VERSION" '.pending[$v] // empty')"
if [ -z "$FIRST_SEEN" ]; then
  FIRST_SEEN="$(now_epoch)"
  # A --platforms run records no verdict, so it would never clear its own stamp either.
  [ -n "$opt_platforms" ] ||
    state_update '.pending = ((.pending // {}) + {($v): $e})' --arg v "$VERSION" --argjson e "$FIRST_SEEN"
fi

FINGERPRINT_BEFORE="$(real_state_fingerprint)"
prepare_sandbox
PLATFORMS_PENDING=0
run_platform_matrix "$VERSION" "$FIRST_SEEN"
FINGERPRINT_AFTER="$(real_state_fingerprint)"

if [ "$PLATFORMS_PENDING" -eq 1 ]; then
  # Some platform package has not published this version yet and the release is still young.
  # Nothing is recorded, so the next hourly run tests the whole matrix from scratch.
  log "not every platform has published $VERSION yet — nothing recorded, retrying next run"
  exit 0
fi

printf '%s\n' "--- platform matrix ---"
jq -s -r 'map("  \(.platform)\t[\(.mode)]\t\(.status)")[]' "$MATRIX"
for _p in $(matrix_platforms fail) $(matrix_platforms error); do
  printf '%s' "$(jq -s -r --arg p "$_p" 'map(select(.platform == $p) | .reasons)[]' "$MATRIX")"
done
printf '%s\n' "-----------------------"

# ---- 4b. what changed since the last clean run? -----------------------------------------------
# A site that used to apply and now silently does nothing is a regression, not a pass — but only
# worth asking of a leg that otherwise looks clean: an aborted patch leaves every later site
# unreported, which would bury the real cause under a list of sites that never got to run.
# Two different things can make a site stop applying, and they deserve different reactions:
#   attempted but SKIP/FAIL  -> the anchor is still there but the binary changed under it. That is
#                               exactly the silent breakage this canary exists to catch. Investigate.
#   never attempted at all   -> clodex chose not to run that site, because the config or the model
#                               registry no longer asks for it (no context windows, no effort
#                               defaults) or because main retired the site. Not Claude Code's doing:
#                               say so once, re-baseline, and let the release pass.
# Without that split, one favourites edit would fail every future release forever, because the
# baseline only refreshes on a pass.
SOFT_NOTES=""
add_soft() { SOFT_NOTES="$SOFT_NOTES- $1
"; }
EXTRA_REASONS=""

BASE_CONFIG_FP="$(state_read | jq -r '.baseline.configFingerprint // ""')"
BASE_VERSION="$(state_read | jq -r '.baseline.version // "none"')"
BASE_PLATFORMS="$(baseline_platforms)"

if [ "$BASE_PLATFORMS" != "{}" ]; then
  for PLATFORM in $(matrix_platforms pass); do
    BASE_SITES="$(printf '%s' "$BASE_PLATFORMS" | jq -c --arg p "$PLATFORM" '.[$p].sites // {}')"
    [ "$BASE_SITES" = "{}" ] && continue
    # Per platform, not per baseline. Because entries are merged, one baseline can hold platforms
    # recorded under two different favourites generations — the global fingerprint describes only
    # the most recent write, so a stale entry compared against it turns a config-driven site change
    # into a phantom release regression. An entry with no fingerprint predates this field.
    BASE_FP="$(printf '%s' "$BASE_PLATFORMS" | jq -r --arg p "$PLATFORM" '.[$p].configFingerprint // ""')"
    if [ -n "$BASE_FP" ] && [ "$BASE_FP" != "$CONFIG_FP" ]; then
      add_soft "your favourites/aliases changed since $PLATFORM was last recorded, so its checks were not compared; its baseline is re-taken from $VERSION"
      continue
    fi
    if [ -z "$BASE_FP" ] && [ -n "$BASE_CONFIG_FP" ] && [ "$BASE_CONFIG_FP" != "$CONFIG_FP" ]; then
      add_soft "your favourites/aliases changed since the $BASE_VERSION baseline, so $PLATFORM's checks were not compared; its baseline is re-taken from $VERSION"
      continue
    fi
    # A leg's checks are named per mode — patch sites for host/container, probe check names for a
    # probe. Comparing across modes reports every name in the other set as a lost site, so a single
    # Docker outage would produce a page of invented regressions on the run after it.
    # An entry recorded before this field existed carries no mode, so its names cannot be placed in
    # either set. Comparing it anyway does the exact damage the mode check exists to prevent — it
    # reported all 16 probe names as dropped on two consecutive container runs — so an entry with no
    # mode is re-taken rather than compared. Unlike a missing configFingerprint, which only leaves
    # the config unknown, a missing mode makes the comparison itself meaningless.
    BASE_MODE="$(printf '%s' "$BASE_PLATFORMS" | jq -r --arg p "$PLATFORM" '.[$p].mode // ""')"
    if [ -z "$BASE_MODE" ]; then
      add_soft "$PLATFORM's baseline predates the leg-mode record, so its checks were not compared; its baseline is re-taken from $VERSION"
      continue
    fi
    if [ "$BASE_MODE" != "$(matrix_mode_of "$PLATFORM")" ]; then
      add_soft "$PLATFORM was tested as a $(matrix_mode_of "$PLATFORM") leg this time and a $BASE_MODE leg on $BASE_VERSION, so its checks were not compared"
      continue
    fi
    NOW_SITES="$(jq -s -c --arg p "$PLATFORM" 'map(select(.platform == $p) | .sites) | last // {}' "$MATRIX")"
    NOW_MARKERS="$(jq -s -c --arg p "$PLATFORM" 'map(select(.platform == $p) | .markers) | last // []' "$MATRIX")"
    BASE_MARKERS="$(printf '%s' "$BASE_PLATFORMS" | jq -c --arg p "$PLATFORM" '.[$p].markers // []')"

    REGRESSED="$(jq -n --argjson base "$BASE_SITES" --argjson now "$NOW_SITES" -r '
      $base | to_entries | map(select(.value == "OK"))
      | map(select(($now[.key] // "") == "SKIP" or ($now[.key] // "") == "FAIL")
            | "\(.key) (was OK, now \($now[.key]))")
      | join("; ")')"
    [ -z "$REGRESSED" ] ||
      EXTRA_REASONS="$EXTRA_REASONS- on $PLATFORM, checks that passed on $BASE_VERSION now report differently: $REGRESSED
"

    DROPPED="$(jq -n --argjson base "$BASE_SITES" --argjson now "$NOW_SITES" -r '
      $base | to_entries | map(select(.value == "OK"))
      | map(select($now[.key] == null) | .key) | join("; ")')"
    [ -z "$DROPPED" ] ||
      add_soft "on $PLATFORM, checks that passed on $BASE_VERSION were not attempted at all this time (config, model registry, or a clodex change — not the release): $DROPPED"

    LOST_MARKERS="$(jq -r -n --argjson a "$BASE_MARKERS" --argjson b "$NOW_MARKERS" '$a - $b | join(", ")')"
    [ -z "$LOST_MARKERS" ] ||
      add_soft "on $PLATFORM, markers present on $BASE_VERSION are gone: $LOST_MARKERS"
  done
fi

# A leg that could not be run is not a verdict, but it IS a hole in the coverage this release was
# judged on, and staying quiet about it is how the canary went green through a real break before.
# Two assignments, not one interpolation: with both substitutions in a single assignment only the
# last one's failure is visible to errexit, so a jq fault in the first would silently drop the very
# notes that disclose reduced coverage.
ERROR_NOTES="$(matrix_error_notes)"
DOWNGRADE_NOTES="$(matrix_downgrade_notes)"
ERROR_NOTES="$ERROR_NOTES
$DOWNGRADE_NOTES"
while IFS= read -r _line; do
  [ -n "$_line" ] && add_soft "${_line#- }"
done <<EOF
$ERROR_NOTES
EOF

if [ "$FINGERPRINT_BEFORE" != "$FINGERPRINT_AFTER" ]; then
  log "WARN: real Claude Code / clodex / tweakcc state changed during the run"
  slack ":warning: clodex patch canary: your real ~/.clodex, ~/.tweakcc or installed Claude Code changed while the canary ran. Either you patched something concurrently, or the canary's isolation leaked. Log: $RUN_LOG" || true
fi

# ---- 5. record and act ------------------------------------------------------------------------
INSTALLED_VERSION="$(basename "$(readlink "$HOME/.local/bin/claude" 2>/dev/null || echo unknown)")"
HOST_PLATFORM="$(host_platform)"
HOST_STATUS="$(matrix_status_of "$HOST_PLATFORM")"
FAILED_PLATFORMS="$(matrix_platforms fail)"
PASSED_PLATFORMS="$(matrix_platforms pass)"
PASS_COUNT="$(matrix_count pass)"
TOTAL_COUNT="$(matrix_total)"
COVERAGE="$(matrix_coverage_line)"
BASELINE_JSON="$(jq -s -c --arg v "$VERSION" --arg fp "$CONFIG_FP" 'map(select(.status == "pass")
                               | {key: .platform,
                                  value: {mode, sites, markers, version: $v, configFingerprint: $fp}})
                             | from_entries' "$MATRIX")"
PLATFORM_STATUS_JSON="$(jq -s -c 'map({key: .platform, value: .status}) | from_entries' "$MATRIX")"

REASONS="$EXTRA_REASONS$(matrix_reason_groups)"
[ -n "$(matrix_reason_groups)" ] && REASONS="$REASONS
"
[ -n "$FAILED_PLATFORMS" ] || [ -n "$EXTRA_REASONS" ] || REASONS=""

ERROR_COUNT="$(matrix_count error)"
DOWNGRADED="$(jq -s -r 'map(select(.downgraded == true) | .platform) | join(", ")' "$MATRIX")"
# "Nothing proved it broken" is not "it is safe". A leg that could not run leaves a hole, and the
# incident this canary exists because of was exactly a hole reported as a clean pass — so anything
# short of full coverage gets a different, weaker message rather than the green tick.
COVERAGE_COMPLETE=0
coverage_is_complete "$HOST_PLATFORM" && COVERAGE_COMPLETE=1
log "coverage complete: $COVERAGE_COMPLETE (host $HOST_STATUS, $ERROR_COUNT error leg(s), downgraded: ${DOWNGRADED:-none})"

if [ -z "$REASONS" ]; then
  log "PASS: Claude Code $VERSION patches cleanly on $PASS_COUNT/$TOTAL_COUNT platforms with clodex origin/main ($MAIN_SHA)"
  [ -z "$SOFT_NOTES" ] || { log "with notes:"; printf '%s' "$SOFT_NOTES"; }
  # `--platforms` is a debugging flag: the run deliberately skipped most of the matrix, so it may
  # not speak for the release at all. Recording a verdict would stop the hourly run testing the
  # rest, and writing the baseline would shrink it to the subset and cost regression detection on
  # every platform left out — for this release AND the next one.
  if [ -n "$opt_platforms" ]; then
    log "--platforms was used, so no verdict and no baseline are recorded for $VERSION"
  else
    # Only a fully covered run may set the baseline or close the version. Anything less is
    # recorded as `partial`: honest in --status, and re-tried later rather than filed forever.
    # Two separate ideas, kept separate on purpose:
    #   .baseline           what each platform looked like the last time IT came out clean. Merged,
    #                       so a leg that could not run this time keeps its old entry instead of
    #                       being forgotten, and a leg that did run still advances. A permanently
    #                       unavailable platform can no longer freeze regression detection for the
    #                       seven that are fine.
    #   .lastCompleteVersion the last release that came out clean on EVERY build. That is the only
    #                       thing entitled to be quoted as "last known good", so it is the only
    #                       thing gated on complete coverage.
    state_update '.versions[$v] = {status: $st, at: $t, atEpoch: $te, clodexSha: $sha, log: $l,
                                   notes: $n, platforms: $pstatus}
                  | .baseline = {version: $v, at: $t, clodexSha: $sha, configFingerprint: $fp,
                                 platforms: (((.baseline.platforms // {}) * $base))}
                  | (if $st == "pass" then .lastCompleteVersion = $v else . end)
                  | .deferred = ((.deferred // {}) | del(.[$v]))
                  | .pending = ((.pending // {}) | del(.[$v]))' \
      --arg v "$VERSION" --arg t "$(now_iso)" --argjson te "$(now_epoch)" --arg sha "$MAIN_SHA" \
      --arg l "$RUN_LOG" --arg fp "$CONFIG_FP" --arg n "$SOFT_NOTES" \
      --arg st "$( [ "$COVERAGE_COMPLETE" -eq 1 ] && echo pass || echo partial )" \
      --argjson base "$BASELINE_JSON" --argjson pstatus "$PLATFORM_STATUS_JSON"
  fi
  KEEP_WORK="$opt_keep"

  # Only the host leg can license an update, so only a host leg that passed may recommend one.
  # Saying "nothing was established for you" and "the update is yours to take" in one message is
  # worse than saying neither.
  if [ "$HOST_STATUS" != "pass" ]; then
    UPDATE_LINE="Because this Mac's leg did not complete, whether $VERSION patches *here* is unknown — hold off until a run covers it."
  elif [ "$INSTALLED_VERSION" = "$VERSION" ]; then
    UPDATE_LINE="You are already on $VERSION — nothing to do."
  else
    UPDATE_LINE="You are on $INSTALLED_VERSION, so the update is yours to take whenever you like. Re-run \`clodex patch\` afterwards to re-apply your aliases."
  fi
  # What was actually established, in the words of what was actually run. A probe leg exercises no
  # patch site and never starts the binary, so it may not be described as "clodex patch applies
  # cleanly" — that phrase is only true of the host and container legs.
  FULL_LEGS="$(jq -s -r 'map(select(.status == "pass" and (.mode == "host" or .mode == "container")) | .platform) | join(", ")' "$MATRIX")"
  FULL_COUNT="$(jq -s -r 'map(select(.status == "pass" and (.mode == "host" or .mode == "container"))) | length' "$MATRIX")"
  PROBE_COUNT="$(jq -s -r 'map(select(.status == "pass" and .mode == "probe")) | length' "$MATRIX")"
  UNTESTED_COUNT="$(jq -s -r 'map(select(.status != "pass" and .status != "fail")) | length' "$MATRIX")"
  HOST_APPLIED="$(matrix_applied_sites "$HOST_PLATFORM")"
  HOST_TOTAL="$(matrix_total_sites "$HOST_PLATFORM")"
  # Only say the binary ran if the leg that runs it actually finished. This sentence asserted it
  # unconditionally and would state it after a host leg that errored before patching anything.
  if [ "$HOST_STATUS" = "pass" ]; then
    HOST_LINE="on this Mac $HOST_APPLIED of $HOST_TOTAL patch sites applied and the patched binary runs and reports $VERSION"
  else
    HOST_LINE="*this Mac was not among them* — its leg reported $HOST_STATUS, so nothing was established for you"
  fi
  UNTESTED_LINE=""
  [ "$UNTESTED_COUNT" -eq 0 ] ||
    UNTESTED_LINE="
$UNTESTED_COUNT build(s) could not be tested at all this run — they are marked below and are the reason this is not an all-clear."

  if [ "$COVERAGE_COMPLETE" -eq 1 ]; then
    PASS_HEAD=":white_check_mark: *Claude Code $VERSION — safe to update.*"
  else
    # Deliberately NOT a green tick. Nothing proved this release broken, but the coverage it was
    # judged on has a hole in it, and a hole reported as a clean pass is the original incident.
    PASS_HEAD=":warning: *Claude Code $VERSION — nothing broke, but this is not a full all-clear.*"
  fi
  # Only mention the bundle-level tier when something is actually in it. "0 got the bundle-level
  # check only" next to five untested builds reads as a contradiction.
  PROBE_LINE=""
  [ "$PROBE_COUNT" -eq 0 ] || PROBE_LINE="
$PROBE_COUNT got the bundle-level check only: every clodex patch site applied to their own bundle and the repack round-tripped, but no patched binary was started there."
  slack "$PASS_HEAD
The real \`clodex patch\` ran on $FULL_COUNT of $TOTAL_COUNT builds ($FULL_LEGS): $HOST_LINE.$PROBE_LINE$UNTESTED_LINE
Tested against clodex origin/main \`${MAIN_SHA:0:8}\` (not the published $(node -p "require('$REPO_DIR/package.json').version" 2>/dev/null || echo release)), so this is a verdict on main.
$UPDATE_LINE$( [ -n "$SOFT_NOTES" ] && printf '\n\n:information_source: Worth knowing:\n%s' "$SOFT_NOTES" )$( [ "$COVERAGE_COMPLETE" -eq 1 ] || printf '\n\n%s' "$COVERAGE" )" || true
else
  log "FAIL: Claude Code $VERSION did not patch cleanly:"
  printf '%s' "$REASONS"
  KEEP_WORK=1   # the investigation needs the sandbox
  write_repro_script

  # Launch BEFORE recording the verdict, for two reasons: the Slack message can then say what is
  # actually happening rather than what was intended, and a crash in between leaves the version
  # unrecorded — so the next run tests it again and gets another chance to start the investigation,
  # rather than filing it as "handled" with nobody working on it.
  INVESTIGATION_STATUS="not started"
  if launch_investigation "$VERSION" "$REASONS" "$RUN_LOG"; then
    INVESTIGATION_STATUS="started"
  fi

  # Only stamp the isolation baseline when THIS run started the session it belongs to: under
  # --force an earlier investigation may still be running, and overwriting its baseline would make
  # the after-the-fact check meaningless.
  # A failure found by a --platforms run IS real and worth alerting on, but it still did not test
  # the rest, so it may not close the version off either.
  state_update '.versions[$v] = {status: $st, at: $t, atEpoch: $te, clodexSha: $sha, log: $l,
                                 sandbox: $w, reasons: $r, platforms: $pstatus,
                                 investigation: $inv}
                | .deferred = ((.deferred // {}) | del(.[$v]))
                | .pending = ((.pending // {}) | del(.[$v]))
                | (if $inv == "started" then .realStateAtInvestigation = $fp else . end)' \
    --arg v "$VERSION" --arg t "$(now_iso)" --argjson te "$(now_epoch)" --arg sha "$MAIN_SHA" \
    --arg l "$RUN_LOG" --arg w "$WORK" --arg r "$REASONS" --arg fp "$FINGERPRINT_AFTER" \
    --arg st "$( [ -n "$opt_platforms" ] && echo partial || echo fail )" \
    --arg inv "$INVESTIGATION_STATUS" --argjson pstatus "$PLATFORM_STATUS_JSON"

  if [ "$INVESTIGATION_STATUS" = "started" ]; then
    NEXT_STEP=":mag: *A background Claude session is now investigating* — \`claude attach ${SESSION_ID:-<id>}\`.
*No action needed from you* unless it stops without a PR: it will Slack a diagnosis, then again with the PR or the obstacle. Until it finishes the canary holds off on any newer release."
  elif [ "$opt_launch" -ne 1 ]; then
    NEXT_STEP=":no_entry_sign: No investigation was started (--no-launch). Nothing else will happen unless you act."
  else
    NEXT_STEP=":bangbang: *The investigation could NOT be started* — see the log. Nobody is working on this; it is yours to pick up."
  fi

  # Which platforms broke changes what you should DO, so it leads. A break that spares this Mac is
  # still a break you ship to everyone else, and a break that includes this Mac is also a "do not
  # update" for you personally — those are different messages and must not be blurred together.
  # Note the ordering: "the host passed" is a stronger claim than "the host did not fail", and only
  # the first justifies telling someone their machine is fine.
  # Not $BASE_VERSION: the baseline advances per platform, so its version is the last release that
  # passed SOMETHING. Only .lastCompleteVersion means "clean on every build".
  LAST_COMPLETE="$(state_read | jq -r '.lastCompleteVersion // empty')"
  LAST_GOOD=""
  [ -z "$LAST_COMPLETE" ] || LAST_GOOD="
Last release that came out clean on every build: *$LAST_COMPLETE*."
  if [ "$HOST_STATUS" = "fail" ] && [ "$INSTALLED_VERSION" = "$VERSION" ]; then
    IMPACT="*You are already ON $VERSION and it cannot be patched* — your aliases and effort settings are off until this is fixed. Roll back, or wait for the fix.$LAST_GOOD"
  elif [ "$HOST_STATUS" = "fail" ]; then
    IMPACT="*Do not update Claude Code yet* — you are on $INSTALLED_VERSION and patching $VERSION fails on this Mac. Your current patched install keeps working; the risk is only at update time.$LAST_GOOD"
  elif [ "$HOST_STATUS" != "pass" ]; then
    IMPACT="*Your Mac was NOT tested this run* (its leg reported $HOST_STATUS), so treat $VERSION as unknown rather than safe for you.$LAST_GOOD"
  elif [ -n "$FAILED_PLATFORMS" ]; then
    IMPACT="*Your own Mac is fine* — $VERSION patches cleanly here, so you can update. But clodex is broken on $(printf '%s' "$FAILED_PLATFORMS" | tr ' ' ',' | sed 's/,/, /g'), and Claude Code auto-updates, so users there are being broken as they update.$LAST_GOOD"
  else
    HEADLINE=":warning: *Claude Code $VERSION patches, but not the way it used to*"
    IMPACT="*You can install it — but something clodex used to do no longer applies.* Patching succeeds; a check that passed on $BASE_VERSION now reports differently, which usually means an anchor drifted and a feature is quietly off. Stay on $INSTALLED_VERSION until this is diagnosed if you rely on it."
  fi
  [ -n "${HEADLINE:-}" ] ||
    HEADLINE=":rotating_light: *clodex patch canary: Claude Code $VERSION breaks \`clodex patch\`* on $(matrix_count fail) of $TOTAL_COUNT builds"

  # Reasons and the next step come before the matrix: with eight platforms the matrix alone pushes
  # everything actionable below the fold on a phone.
  slack "$HEADLINE
$IMPACT
Tested against clodex origin/main \`${MAIN_SHA:0:8}\` — $MAIN_SUBJECT

$REASONS
$NEXT_STEP

Nothing on your machine was patched or installed. Log: \`$RUN_LOG\` · sandbox: \`$WORK\` · reproduce any leg: \`$WORK/repro.sh <platform>\`

$(matrix_coverage_brief)$( [ -n "$SOFT_NOTES" ] && printf '\n\n:information_source: Also worth knowing:\n%s' "$SOFT_NOTES" )" || true
fi

log "done"
