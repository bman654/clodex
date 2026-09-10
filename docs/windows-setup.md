# Using clodex with the Claude Code VS Code extension on Windows

This page covers running clodex alongside Claude Code's **VS Code extension** on Windows, so
`clodex:` models and aliases are usable from the extension's chat panel rather than only from a
terminal.

There are two levels of setup, and they solve different problems:

| Setup | What you get |
| --- | --- |
| [Proxy env vars](#1-route-the-extension-through-clodex) | clodex models **work** in the extension |
| [+ process wrapper](#2-make-clodex-models-appear-in-the-model-picker) | clodex models also **appear in the model picker** |

The first is enough if you are happy selecting a model once and leaving it. Add the second if you
want to switch between clodex models from the extension's UI.

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
> bin as `clodex-claude`, `clodex-claude.cmd` and `clodex-claude.ps1` — there is no `.exe`. The
> extension spawns the wrapper without a shell, so pointing it at the `.cmd` fails with
> `spawn EINVAL`. The environment-variable approach above is the one that works.

### Selecting a clodex model

At this level the extension's model picker will **not** list clodex models (see
[why](#why-the-picker-is-empty-without-a-wrapper)). Set one as your default from a terminal instead:

```powershell
clodex claude
```

then `/model`, pick the model, and press Enter to save it as the default for new sessions. That
writes a `model` key into `~/.claude/settings.json`, which the extension picks up on its next
launch — Claude Code reports it as `Using <model> (from .claude\settings.json)`.

Existing chat tabs keep whatever model they launched with; open a new chat to pick up the change.

## 2. Make clodex models appear in the model picker

### Why the picker is empty without a wrapper

`clodex patch` patches the Claude Code binary that npm installed. The VS Code extension does not
launch that binary — it ships and launches its own copy:

```
%USERPROFILE%\.vscode\extensions\anthropic.claude-code-<version>-win32-x64\resources\native-binary\claude.exe
```

On the machine this was written from, that bundled copy was byte-identical (SHA-256) to the pristine
backup clodex took before patching, confirming it was unpatched. The model picker's entries live
inside the binary, so the dropdown shows whatever the *launched* binary offers — which is why models
routed correctly while remaining invisible in the picker.

Routing does not depend on the patch. Claude Code sends the model name it was given, and the proxy
maps it. The patch is what makes the binary itself aware of clodex models — listing them in the
picker, accepting them as known aliases, and reporting their context windows.

### Point the extension at the patched binary

`claudeCode.claudeProcessWrapper` takes an executable path. Claude Code invokes it as:

```
<wrapper> <path-to-claude-binary> <args...>
```

passing the binary it *would* have run as the first argument. A wrapper that drops that argument and
runs the clodex-patched binary instead gives the extension a patched Claude Code.

It must be a real `.exe`, for the `spawn EINVAL` reason above. Any language that produces one works;
this is a Go reference implementation. It asks clodex which binary it patched, so the same compiled
exe works on any machine without editing a path:

```go
// The extension invokes a claudeProcessWrapper as:
//     wrapper.exe <path-to-claude-binary> <args...>
// so the first argument is the binary it would otherwise have run.
//
// Target resolution, in order:
//  1. CLODEX_WRAPPER_TARGET, if set
//  2. binaryPath from clodex's patch manifest (patch-state.json)
//  3. the path the caller handed us — so claude always launches, just unpatched
package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// clodexHome mirrors getAppHome() in clodex's src/paths.ts: CLODEX_HOME is the
// app directory itself when set, otherwise <home>/.clodex.
func clodexHome() string {
	if override := strings.TrimSpace(os.Getenv("CLODEX_HOME")); override != "" {
		return override
	}
	for _, key := range []string{"HOME", "USERPROFILE"} {
		if value := os.Getenv(key); value != "" {
			return filepath.Join(value, ".clodex")
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".clodex")
	}
	return ""
}

// patchedBinary reads the binary clodex last patched, or "" if unavailable.
func patchedBinary() string {
	home := clodexHome()
	if home == "" {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(home, "patch-state.json"))
	if err != nil {
		return ""
	}
	var manifest struct {
		BinaryPath string `json:"binaryPath"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return ""
	}
	return manifest.BinaryPath
}

func isFile(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func main() {
	args := os.Args[1:]

	// The caller passes the binary it would have run; hold it as the fallback.
	handedIn := ""
	if len(args) > 0 {
		if base := strings.ToLower(filepath.Base(args[0])); base == "claude.exe" || base == "claude" {
			handedIn = args[0]
			args = args[1:]
		}
	}

	target := ""
	for _, candidate := range []string{
		strings.TrimSpace(os.Getenv("CLODEX_WRAPPER_TARGET")),
		patchedBinary(),
		handedIn,
	} {
		if isFile(candidate) {
			target = candidate
			break
		}
	}
	if target == "" {
		os.Stderr.WriteString("claude-wrapper: no Claude Code binary found\n")
		os.Exit(1)
	}

	cmd := exec.Command(target, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = os.Environ()

	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		os.Stderr.WriteString("claude-wrapper: " + err.Error() + "\n")
		os.Exit(1)
	}
}
```

Build it:

```powershell
go build -ldflags="-s -w" -o claude-wrapper.exe .
```

Then add the setting, keeping the environment variables from step 1 — they do the routing, the
wrapper only chooses the binary:

```json
"claudeCode.claudeProcessWrapper": "C:\\path\\to\\claude-wrapper.exe"
```

Reload the window. The picker should now list your clodex models alongside the built-in ones.

If Claude fails to start, remove the `claudeCode.claudeProcessWrapper` line, save, and reload — that
returns you to the step 1 setup.

> [!TIP]
> If you use a Node version manager, prefer a path that survives version switches. With NVM for
> Windows, `C:\nvm4w\nodejs` is a symlink to the active version, so a path through it stays valid
> across both Node upgrades and Claude Code updates.

### Consequences of setting a process wrapper

Claude Code changes two behaviors when `claudeProcessWrapper` is set. Both were read from the
extension's own code rather than observed failing:

- **Its update check is skipped.** Keeping Claude Code current becomes your job:

  ```powershell
  npm install -g @anthropic-ai/claude-code@latest
  clodex patch
  ```

- **Permission-mode resolution moves out of the CLI.** If permission prompts behave unexpectedly
  under a wrapper, this is the setting to remove first when narrowing it down.

Re-running `clodex patch` after each Claude Code update is required regardless of the wrapper — the
patch applies to a specific version of the binary.

## Troubleshooting

**`spawn EINVAL`** — `claudeProcessWrapper` points at a `.cmd`, `.ps1`, or `.bat`. It must be an
`.exe`.

**Every request fails** — check `clodex server --proxy` is still running. The extension's
`HTTPS_PROXY` points at a fixed port; nothing falls back when the server is gone.

**Certificate errors** — `NODE_EXTRA_CA_CERTS` must match the path the server printed, with
backslashes escaped in JSON.

**Models route but the picker is empty** — expected without the wrapper; see
[step 2](#2-make-clodex-models-appear-in-the-model-picker).

**`clodex patch` reports it cannot detect the installation** — upgrade clodex; resolving npm
launchers to the underlying binary on Windows was fixed in 2.11.5.

## What was verified, and where

Verified on Windows 11, NVM for Windows (node v22.19.0), clodex 2.11.6, Claude Code 2.1.267, Claude
Code VS Code extension 2.1.267, against the ChatGPT/Codex-plan OAuth provider:

- Step 1 routes extension traffic through clodex, and a model set as default from `clodex claude` is
  used by the extension.
- Step 2 makes clodex models appear in the extension's model picker and selectable from it.
- The extension's bundled binary was unpatched, matching clodex's pristine backup by SHA-256.
- The wrapper's target resolution, exercised in all four states: `patch-state.json` present (runs the
  recorded binary), manifest absent (falls back to the handed-in binary), manifest absent with an
  unreadable handed-in path (exits 1 with a message rather than hanging), and the normal case on this
  machine. The listing above was extracted from this page and compiled to confirm it builds as
  printed.

Not verified: any Node version manager other than NVM for Windows, any provider other than
ChatGPT/Codex-plan OAuth, and the two wrapper consequences above, which were read from the
extension's code rather than reproduced.
