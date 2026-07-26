# Native Codex compaction bridge

Status: experimental groundwork only. The default clodex request path is unchanged.

## Goal

Let Claude Code use Codex's native context-compaction runtime while continuing to
present an Anthropic-compatible endpoint to Claude Code.

## Important boundary

The native operation is a Codex app-server operation, not a public Responses API
parameter. The bridge must start an isolated `codex app-server --stdio` child and
speak its v2 JSON-RPC protocol:

1. `initialize`
2. `thread/start` for one Codex thread per Claude session/model/effort partition
3. `thread/inject_items` to mirror Claude's translated Responses history
4. `thread/compact/start`
5. wait for `thread/compacted`
6. continue using the compacted Codex thread

`src/codex-app-server.ts` implements only this transport/lifecycle slice. It is
deliberately not enabled by default and does not share the user's interactive
Codex process or Claude process.

## Integration plan

### Phase 1 — protocol and lifecycle (implemented)

- Spawn an isolated app-server child.
- Implement request/response correlation, timeouts, process failure handling,
  and compaction completion notifications.
- Test the complete lifecycle against a deterministic fake app-server.

### Phase 2 — history mirror

- Add a feature-gated session manager keyed by Claude session id, upstream model,
  effort, and OAuth account.
- Translate Anthropic messages/tool results into valid Responses items.
- Mirror only stable, model-visible history; preserve images and tool-call IDs.
- Bound memory and clean up sessions when Claude exits or the bridge times out.

### Phase 3 — native compaction handoff

- When Claude sends its compaction turn, stop forwarding that synthetic request
  through the current Claude-style compaction path.
- Ensure the mirrored Codex thread contains the same history, invoke native
  compaction, and wait for completion.
- Continue the Codex thread for the next real Claude request, so the OpenAI
  backend sees Codex's compacted history rather than Claude's full history.

### Phase 4 — compatibility and fallback

- If Codex is unavailable, the app-server protocol changes, history translation
  fails, or compaction times out, fall back to the existing clodex translator.
- Never make a failed native-compaction attempt terminate Claude Code.
- Keep native compaction opt-in until parity is proven on normal turns, tool
  loops, images, subagents, resume, model switching, and context rollover.

## Why this cannot be a one-line patch

`thread/compact/start` compacts Codex's durable thread; it does not return a
plain-text summary. A useful integration therefore has to mirror the Claude
conversation into that thread and route subsequent turns through the same
thread. Merely calling the endpoint for Claude's existing request would invoke
native compaction but would not reduce the context Claude sends on its next
request.
