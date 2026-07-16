#!/usr/bin/env bash
#
# patch-custom-models.sh — back up (once) then inject custom model aliases into
# the installed Claude Code CLI via tweakcc.
#
#   Apply:   ./patch-custom-models.sh
#   Restore: ./patch-custom-models.sh restore
#
# - Injects your model-config.json into the patch script at apply time (the
#   tweakcc sandbox can't read files at runtime). Falls back to the example
#   MODEL_CONFIG baked into patch-custom-models.js if no config is found.
# - Resolves the REAL native binary itself, so it is immune to a `which claude`
#   that points at a wrapper/shim (e.g. cmux) which tweakcc cannot unpack.
# - Exports TWEAKCC_CC_INSTALLATION_PATH for the run (no ~/.zshrc entry needed).
# - Makes a pristine, version-tagged backup ONLY if one doesn't already exist,
#   and mirrors it to ~/.tweakcc/native-binary.backup so `tweakcc --restore`
#   works too. The patch itself is idempotent, so re-running is safe.
#
# Config resolution order (first that exists wins):
#   1. $RELAY_AI_PATCH_MODEL_CONFIG   (explicit path)
#   2. ./model-config.json            (next to this script)
#   3. the example baked into patch-custom-models.js
#
# Assumes it is run on a fresh (unpatched) binary the first time a given version
# is seen — i.e. this script is how you patch. Don't hand-patch first, or the
# version's pristine backup would capture already-patched bytes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- locate the real native binary (bypass any `which claude` wrapper/shim) ---
# Prefer an explicit override, then the stable native-install symlink, then PATH.
if [[ -n "${TWEAKCC_CC_INSTALLATION_PATH:-}" ]]; then
  BIN_SRC="$TWEAKCC_CC_INSTALLATION_PATH"
elif [[ -e "${HOME}/.local/bin/claude" ]]; then
  BIN_SRC="${HOME}/.local/bin/claude"
else
  BIN_SRC="$(command -v claude || true)"
fi
[[ -n "$BIN_SRC" ]] || { echo "ERROR: could not find claude — set TWEAKCC_CC_INSTALLATION_PATH to the real binary" >&2; exit 1; }
BIN="$(readlink -f "$BIN_SRC" 2>/dev/null || readlink "$BIN_SRC" 2>/dev/null || echo "$BIN_SRC")"
[[ -f "$BIN" ]] || { echo "ERROR: resolved binary is not a file: $BIN (source: $BIN_SRC)" >&2; exit 1; }
VER="$(basename "$BIN")"

# tweakcc: pin every command in this process to this exact binary.
export TWEAKCC_CC_INSTALLATION_PATH="$BIN"

BACKUP_DIR="${TWEAKCC_CONFIG_DIR:-$HOME/.tweakcc}"
ORIG="${BACKUP_DIR}/claude-${VER}.orig"           # pristine, version-tagged, never overwritten
TWEAKCC_BAK="${BACKUP_DIR}/native-binary.backup"  # what `tweakcc --restore` reads
TEMPLATE="${SCRIPT_DIR}/patch-custom-models.js"
mkdir -p "$BACKUP_DIR"

# --- restore mode ------------------------------------------------------------
if [[ "${1:-}" == "restore" ]]; then
  [[ -f "$ORIG" ]] || { echo "ERROR: no pristine backup for v$VER at $ORIG" >&2; exit 1; }
  cp -p "$ORIG" "$BIN"
  echo "✓ Restored v$VER from $ORIG"
  exit 0
fi

[[ "${1:-}" == "" ]] || { echo "Usage: $0 [restore]" >&2; exit 2; }
[[ -f "$TEMPLATE" ]] || { echo "ERROR: patch script not found: $TEMPLATE" >&2; exit 1; }

# --- resolve the model config ------------------------------------------------
CONFIG=""
if [[ -n "${RELAY_AI_PATCH_MODEL_CONFIG:-}" && -f "${RELAY_AI_PATCH_MODEL_CONFIG}" ]]; then
  CONFIG="$RELAY_AI_PATCH_MODEL_CONFIG"
elif [[ -f "${SCRIPT_DIR}/model-config.json" ]]; then
  CONFIG="${SCRIPT_DIR}/model-config.json"
fi

# --- build the patch script (inject config between the relay:config markers) --
# tweakcc's sandbox can't read files, so bake the config in now. Use node so the
# JSON is validated and re-emitted safely rather than string-spliced by hand.
PATCH="$TEMPLATE"
CLEANUP=""
if [[ -n "$CONFIG" ]]; then
  PATCH="$(mktemp "${TMPDIR:-/tmp}/patch-custom-models.XXXXXX.js")"
  CLEANUP="$PATCH"
  # shellcheck disable=SC2064
  trap "rm -f '$CLEANUP'" EXIT
  node - "$TEMPLATE" "$CONFIG" >"$PATCH" <<'NODE'
const fs = require('fs');
const [, , templatePath, configPath] = process.argv;
const template = fs.readFileSync(templatePath, 'utf8');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`patch-custom-models: invalid JSON in ${configPath}: ${err.message}`);
  process.exit(1);
}
const START = '// relay:config:start';
const END = '// relay:config:end';
const i = template.indexOf(START);
const j = template.indexOf(END);
if (i < 0 || j < 0 || j < i) {
  console.error('patch-custom-models: could not find relay:config markers in template');
  process.exit(1);
}
const block = `${START}\nconst MODEL_CONFIG = ${JSON.stringify(config, null, 2)};\n${END}`;
process.stdout.write(template.slice(0, i) + block + template.slice(j + END.length));
NODE
  echo "✓ Using model config: $CONFIG"
else
  echo "• No model-config.json found — using the example baked into patch-custom-models.js"
fi

# --- backup (only if not already backed up for this version) -----------------
if [[ -f "$ORIG" ]]; then
  echo "✓ Pristine backup already exists for v$VER: $ORIG"
else
  cp -p "$BIN" "$ORIG"
  echo "✓ Backed up pristine v$VER -> $ORIG ($(du -h "$ORIG" | cut -f1))"
fi
# Mirror the pristine copy to tweakcc's restore location (always from ORIG,
# never the live binary — so it stays pristine even after patching).
cp -pf "$ORIG" "$TWEAKCC_BAK"

# --- apply the patch ---------------------------------------------------------
echo "Applying custom-model patch to $BIN ..."
npx -y tweakcc adhoc-patch --path "$BIN" --script "@${PATCH}"

cat <<EOF

Done. Roll back with either:
  $0 restore
  TWEAKCC_CC_INSTALLATION_PATH="$BIN" npx tweakcc --restore
EOF
