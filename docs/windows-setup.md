# Using clodex with the Claude Code VS Code extension on Windows

This page covers running clodex alongside Claude Code's **VS Code extension** on Windows, so
`clodex:` models and aliases are usable from the extension's chat panel rather than only from a
terminal.

There are two levels of setup, and they solve different problems:

| Setup | What you get |
| --- | --- |
| [Proxy env vars](#1-route-the-extension-through-clodex) | clodex models **work** in the extension |
| [Launcher](#2-launch-the-extensions-claude-code-through-clodex) | the extension launches Claude Code **through `clodex-claude`**, which follows your running server on its own — no proxy values to copy into VS Code settings — and runs your **clodex-patched install** in place of the bundled binary, so clodex models appear in the extension's **model picker** |

Only the launcher level changes the picker. `clodex-claude` replaces the extension's bundled,
unpatched Claude Code with your verified clodex-patched install exactly as it does on macOS and
Linux (see the [VS Code setup in
background-agents.md](background-agents.md#vs-code-model-picker)): the bundled file's full SHA-256
must match the pristine hash `clodex patch` recorded, and the patched install must still match its
recorded output. With the step 1 settings alone the extension launches its own bundled binary and
the picker stays as it was.

## 1. Route the extension through clodex

The extension launches Claude Code itself, so there is no `clodex claude` step to hook into.
Instead, run a proxy-mode server and point the extension's environment at it.

**Start the server and leave it running** (a minimized terminal is fine):

```powershell
clodex server --proxy
```

It prints the values you need:

```
clodex proxy-mode server running
  HTTPS_PROXY=http://127.0.0.1:17645
  HTTP_PROXY=http://127.0.0.1:17645
  NODE_EXTRA_CA_CERTS=C:\Users\<you>\.clodex\http-proxy\clodex-ca.pem
```

**Put those in your VS Code settings** (`Ctrl+Shift+P` → `Preferences: Open User Settings (JSON)`),
using the values your server printed:

```json
"claudeCode.environmentVariables": [
  { "name": "HTTPS_PROXY",         "value": "http://127.0.0.1:17645" },
  { "name": "HTTP_PROXY",          "value": "http://127.0.0.1:17645" },
  { "name": "NODE_EXTRA_CA_CERTS", "value": "C:\\Users\\<you>\\.clodex\\http-proxy\\clodex-ca.pem" }
]
```

Reload the window (`Ctrl+Shift+P` → `Developer: Reload Window`). The extension reads these only when
it launches Claude, so editing them without reloading changes nothing.

Requests from the extension now route through clodex. Bridging only happens while the server is
running; stop it and the port goes dead, so every request fails until you start it again.

> [!NOTE]
> Do not set `claudeCode.claudeProcessWrapper` to `clodex-claude` here. On Windows npm installs that
> bin as three script shims — `clodex-claude` (a POSIX shell script), `clodex-claude.cmd` and
> `clodex-claude.ps1` — and no `.exe`. The extension spawns the wrapper without a shell, so pointing
> it at any of them fails with `spawn EINVAL`.
> [Step 2](#2-launch-the-extensions-claude-code-through-clodex) builds the `.exe` that setting needs.

### Selecting a clodex model

At this level the extension's model picker will **not** list clodex models (see
[why](#why-the-picker-is-empty-without-a-launcher)). Set one as your default from a terminal instead:

```powershell
clodex claude
```

then `/model`, pick the model, and press Enter to save it as the default for new sessions. That
writes a `model` key into `~/.claude/settings.json`, which the extension picks up on its next
launch — Claude Code reports it as `Using <model> (from .claude\settings.json)`.

Existing chat tabs keep whatever model they launched with; open a new chat to pick up the change.

## 2. Launch the extension's Claude Code through clodex

### Why the picker is empty without a launcher

`clodex patch` patches the Claude Code binary that npm installed. The VS Code extension does not
launch that binary — it ships and launches its own copy:

```
%USERPROFILE%\.vscode\extensions\anthropic.claude-code-<version>-win32-x64\resources\native-binary\claude.exe
```

On the machine this was first written from, that bundled copy was byte-identical (SHA-256) to the
pristine backup clodex took before patching, confirming it was unpatched. The model picker's entries
live inside the binary, so the dropdown shows whatever the *launched* binary offers — which is why
models routed correctly while remaining invisible in the picker.

Routing does not depend on the patch. Claude Code sends the model name it was given, and the proxy
maps it. The patch is what makes the binary itself aware of clodex models — listing them in the
picker, accepting them as known aliases, and reporting their context windows.

`clodex-claude` solves this itself: when the extension hands it the bundled binary, it substitutes
the install recorded in `patch-state.json` — only when the extension's full binary hash matches
that manifest's pristine hash and the install's full hash still matches the recorded patched
output (equal version labels or sizes are not enough); a mismatch runs the extension's own binary
and writes one line to its output channel. On Windows the only missing piece was an executable the
extension could spawn; the launcher below is that piece.

### What the launcher is

`claudeCode.claudeProcessWrapper` takes a single executable path. Claude Code invokes it as:

```
<wrapper> <path-to-claude-binary> <args...>
```

passing the binary it *would* have run as the first argument. clodex already ships a wrapper for
exactly this contract — `clodex-claude`, the one [background agents](background-agents.md) use —
but on Windows npm installs it as three script shims (extensionless, `.cmd`, `.ps1`) and no
executable, and the extension refuses those with `spawn EINVAL`.

`clodex install-vscode-launcher` builds the missing `.exe` on your machine. It compiles a small C#
program (`launcher\clodex-claude-launcher.cs` in the clodex package — a short, commented file you
can read) with the C# compiler that ships inside the .NET Framework on every Windows 10/11 install,
so there is nothing to download and no prebuilt binary to trust. The resulting
`clodex-claude.exe`:

- runs `node.exe` with clodex's `claude-wrapper.js`, passing the extension's arguments through
  with their **values preserved, Unicode included** (it forwards the raw command line rather than
  re-quoting each argument, and the wrapper spawns a native `claude.exe` directly rather than
  through `cmd.exe`, so JSON arguments, empty strings, `%NAMES%` and paths with spaces reach Claude
  Code as sent);
- ties Node and the Claude Code it launches to its own lifetime with a Windows job object, so that
  when the extension cancels a chat or the window reloads, no `node.exe` or `claude.exe` is left
  behind. If Windows refuses the job object the launcher prints one warning line and runs anyway;
- lets Ctrl+C reach Claude Code rather than swallowing it, waits, and exits with Claude Code's own
  exit code.

`clodex-claude` then does what it does for any Claude process: finds your running
`clodex server --proxy` and bridges the session to it. **The launcher does not choose the Claude
Code binary.** It hands `clodex-claude` the bundled `claude.exe` the extension named, exactly as the
extension would, and `clodex-claude` applies its usual rule: when that file's full SHA-256 equals
the pristine hash in `patch-state.json` and your patched `claude.exe` still hashes to the recorded
patched output, it runs the patched install; otherwise it runs the bundled `claude.exe` and, for
the chat itself, writes one line to the **Claude VSCode** output channel (helper commands the
extension runs fall back silently). On Windows both files must be `.exe` programs (a
`.cmd` launcher is never substituted for or into), and the bundled file (about 200 MB) is hashed on
every launch — `tests/wrapper-substitution.windows.test.ts` prints the measured time on the CI
runner; see that job's log for the current number.

### Build it

Run once, from any terminal, with the Node you normally use:

```powershell
clodex install-vscode-launcher
```

It prints where the launcher went and the setting to paste:

```
Built C:\Users\<you>\.clodex\bin\clodex-claude.exe
  compiler: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
  runs:     C:\nvm4w\nodejs\node.exe C:\nvm4w\nodejs\node_modules\@bman654\clodex\dist\claude-wrapper.js

Add this to your VS Code settings (Ctrl+Shift+P → Preferences: Open User Settings (JSON)):

  "claudeCode.claudeProcessWrapper": "C:\\Users\\<you>\\.clodex\\bin\\clodex-claude.exe"
```

The two paths on the `runs:` line are compiled into the executable. **Re-run the command after
switching Node versions or moving the clodex install** — it is idempotent and replaces the launcher.
If the wrapper script it was built against disappears, the launcher exits with code 127 and a
one-line message naming the command to re-run, which shows up in the extension's **Claude VSCode**
output channel.

If the command reports that it cannot find `csc.exe`, your Windows install is missing the .NET
Framework 4.x runtime it normally ships with; install .NET Framework 4.8 from Microsoft and re-run.

### Add the setting

Paste the printed line into your user settings and **remove** the `HTTPS_PROXY`, `HTTP_PROXY` and
`NODE_EXTRA_CA_CERTS` entries from step 1: `clodex-claude` injects the equivalent values itself
from the server it discovers, and static entries pointing at a fixed port would keep failing while
the server is down, whereas the wrapper leaves the environment alone and lets Claude Code start
unbridged.

```json
"claudeCode.claudeProcessWrapper": "C:\\Users\\<you>\\.clodex\\bin\\clodex-claude.exe"
```

Reload the window. `clodex server --proxy` still has to be running — the launcher does not start it.
Open a new chat: the model picker now lists your clodex favorites and aliases, provided the CLI you
patched and the extension ship the same Claude Code build. When they drift apart (the extension and
the CLI update separately), the picker falls back to the bundled list and the **Claude VSCode**
output channel shows a `From claude: clodex-claude: running ...` line; update the CLI to the
extension's version and re-run `clodex patch`.

If Claude fails to start, remove the `claudeCode.claudeProcessWrapper` line, save, and reload — that
returns you to the step 1 setup. The **Claude VSCode** output channel (View → Output) shows the
launcher's and wrapper's messages, prefixed `From claude:`.

> [!TIP]
> `clodex-claude` looks for the server in `%USERPROFILE%\.clodex`. If you set `CLODEX_HOME` in your
> shell only, VS Code will not see it; add it under `claudeCode.environmentVariables` as well.

### Consequences of setting a process wrapper

At least two extension behaviors relevant to this setup change when `claudeProcessWrapper` is set.
These were read from the extension's own code rather than observed in a running editor:

- **A post-update activation health/telemetry probe is skipped.** This is not the VS Code
  marketplace updater and does not show that extension auto-updates stop. The extension can still
  update separately from the CLI, so keep the CLI you patch aligned with the extension you run:

  ```powershell
  npm install -g @anthropic-ai/claude-code@latest
  clodex patch
  ```

- **The SDK supplies a permission mode.** With no explicit mode, wrapper launches add
  `--permission-mode default` instead of leaving default-mode resolution to the CLI. An explicitly
  configured mode still wins. If permission prompts behave unexpectedly under a wrapper, remove the
  wrapper setting while narrowing it down.

Re-running `clodex patch` after each Claude Code CLI update is required regardless of the wrapper —
the patch applies to specific bytes.

### Previous manual workaround

Earlier versions of this page carried a hand-built Go program to compile yourself. It ran the
patched npm `claude.exe` directly, bypassing `clodex-claude` entirely: it needed the step 1
environment variables, got no server discovery, and had none of `clodex-claude`'s full-hash
verification, so its target had to be kept aligned and re-patched by hand. It still works if you
built one, but `clodex install-vscode-launcher` is the supported path and the only one that verifies
what it runs.

## Troubleshooting

**`spawn EINVAL`** — `claudeProcessWrapper` points at a `.cmd`, `.ps1`, or `.bat`. It must be the
`.exe` from `clodex install-vscode-launcher`.

**`clodex-claude.exe: clodex's claude-wrapper.js is no longer at ...`** (output channel, exit 127)
— clodex moved or was reinstalled under a different Node. Re-run `clodex install-vscode-launcher`.

**`could not find the .NET Framework C# compiler`** — install .NET Framework 4.8 from Microsoft; the
command looks under `%WINDIR%\Microsoft.NET\Framework64\v4.*` and `Framework\v4.*`.

**Windows Defender or SmartScreen flags the launcher** — it is a freshly compiled unsigned
executable, so reputation-based checks have never seen it. The source is in the clodex package
(`launcher\clodex-claude-launcher.cs`); allow the file, or build it again after clearing the
warning.

**Every request fails** — check `clodex server --proxy` is still running. With the step 1 env vars
the extension's `HTTPS_PROXY` points at a fixed port and nothing falls back when the server is gone;
with the launcher, sessions started while the server is down run unbridged.

**Certificate errors** (step 1 setup) — `NODE_EXTRA_CA_CERTS` must match the path the server
printed, with backslashes escaped in JSON.

**Models route but the picker is empty** — with the step 1 settings alone that is expected: the
extension launches its own bundled binary. With the launcher, open View → Output → **Claude VSCode**
and look for a `From claude: clodex-claude: running ...` line: it names the reason (usually the
extension and the installed CLI are different Claude Code builds). Align them —
`npm install -g @anthropic-ai/claude-code@<extension version>` — and re-run `clodex patch`. No
line at all is not proof either way: a missing or unreadable patch manifest is deliberately silent.
Run `clodex patch`, and check that `CLODEX_HOME`, if you set it, is also set under
`claudeCode.environmentVariables` so the wrapper reads the same manifest.

**`CLODEX_CLAUDE_PATH` points at `clodex-claude` or `claude` without an extension, or at a `.ps1`** —
Node cannot spawn those on Windows at all. Point it at the `.cmd` or at the program's `.exe`.

**`clodex patch` reports it cannot detect the installation** — upgrade clodex; resolving npm
launchers to the underlying binary on Windows was fixed in 2.11.5.

## What was verified, and where

Step 1, and the *previous* Go workaround, were verified on Windows 11, NVM for Windows
(node v22.19.0), clodex 2.11.6, Claude Code 2.1.267, Claude Code VS Code extension 2.1.267, against
the ChatGPT/Codex-plan OAuth provider:

- Step 1 routes extension traffic through clodex, and a model set as default from `clodex claude` is
  used by the extension.
- A process wrapper that launches a patched binary makes clodex models appear in the extension's
  model picker and selectable from it.
- The extension's bundled binary was unpatched, matching clodex's pristine backup by SHA-256.

Not verified there: any Node version manager other than NVM for Windows, any provider other than
ChatGPT/Codex-plan OAuth, and the two wrapper consequences above, which were read from the
extension's code rather than reproduced.

`clodex install-vscode-launcher` is verified on every pull request by a Windows CI job
(`windows-latest`, `tests/vscode-launcher.windows.test.ts`): the command builds the launcher with the
runner's own .NET Framework `csc.exe`; the resulting `.exe` is spawned the way the extension spawns
it (no shell, arguments as a list) with `node.exe` plus a probe script standing in for the bundled
Claude Code; argument values with spaces, quotes, JSON, empty strings, `%PATH%`, `&|<>^` and
non-ASCII text arrive at the probe unchanged through Node and `clodex-claude`; stdin, stdout and the
exit code pass through; killing the launcher takes Node, the probe and the probe's own child process
down; re-running the install over a running launcher ends in a one-line message; and a launcher
whose baked wrapper script was removed exits 127 with the re-run hint. Off Windows the command's
compiler discovery, source rendering, scratch compile and install are exercised against a fake
`csc.exe`.

The patched-install substitution behind the launcher is verified on the same job by
`tests/wrapper-substitution.windows.test.ts`: a fake `claude.exe` compiled with the runner's
`csc.exe` is patched by the real `clodex patch` command, the launcher is handed a pristine copy of
it and runs the patched one (its output names which copy ran, and the proxy settings and arguments
reach it intact); a same-size copy with different bytes runs as handed in with exactly one line on
stderr, written before anything the binary prints; helper spawns (`auth status`,
`--no-session-persistence` queries) fall back silently; and a dead server disables substitution.
The same file records what Node reports about files on the runner's NTFS volume (file ids, volume
serial, change time on an in-place rewrite, the read-only attribute) and prints the time to hash a
200 MB file.

**Not covered by CI, please report on #245 if you can try it:** the real VS Code extension spawning
the launcher and showing clodex models in its picker (it is spawned by a test harness in CI, which
cannot open an editor), Windows Defender/SmartScreen behaviour on the freshly compiled `.exe`, and
Windows on ARM.

```powershell
# 1. Build, and note the three paths it prints.
clodex install-vscode-launcher

# 2. Paste the printed "claudeCode.claudeProcessWrapper" line into user settings, remove the
#    HTTPS_PROXY/HTTP_PROXY/NODE_EXTRA_CA_CERTS entries, keep `clodex server --proxy` running,
#    Developer: Reload Window. Then, with a chat open and a reply streaming:
Get-Process node, claude -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, StartTime
# Press the stop button in the chat, wait five seconds, run the same line again: the node/claude
# processes started when the chat began (their StartTime) must be gone. Paste both listings.

# 3. Output channel: View > Output > "Claude VSCode". Paste any line starting with
#    "From claude: clodex-claude.exe:" (job-object warnings) — there should be none.

# 4. Defender/SmartScreen: paste any prompt or quarantine notice about
#    $env:USERPROFILE\.clodex\bin\clodex-claude.exe, or say there was none.
```
