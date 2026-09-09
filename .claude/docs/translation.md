# Translation layer

<!-- Read when changing src/sdk-adapter.ts, src/provider-factory.ts, or src/openai-adapter.ts. -->

## Translation layer

`src/sdk-adapter.ts` + `src/provider-factory.ts`: Anthropic `/v1/messages` ↔ Vercel AI SDK, one turn
per request (Claude Code owns the tool loop). This is the **single** translation path — no
hand-rolled per-provider translation. Preserved hard-won behavior:

- Inline `role:'system'` messages stay in their original conversation positions, so volatile
  reminders do not invalidate the stable prompt prefix.
- On public-API OpenAI GPT-5.6+ routes, Anthropic `cache_control` blocks become explicit OpenAI
  cache breakpoints. ChatGPT/Codex OAuth sends a hashed Claude session-derived `prompt_cache_key`
  and strips Claude Code's volatile billing-attribution header from instructions, but omits
  `prompt_cache_options` and explicit breakpoints — those produced successful-but-empty OAuth
  responses in testing.
- Cache reads and GPT-5.6 cache writes map to Anthropic
  `cache_read_input_tokens`/`cache_creation_input_tokens`.
- Consecutive OpenAI Responses reasoning summaries/items stream into **one Anthropic thinking
  block** until text, a tool, or successful completion closes it. A thinking-only WebSocket drop
  leaves that block open, so an earlier summary cannot disable Claude Code's mid-stream retry.
  `src/openai-thinking.ts` carries a versioned, self-contained signature envelope: original SDK
  item IDs, original summary text, and encrypted content. On the next request it restores separate
  SDK reasoning parts; the SDK rebuilds the original summary groups. Display-only paragraph breaks
  never enter the upstream summaries. Original text lives inside the opaque signature rather than
  being recovered from the display text, so client-side text edits or Unicode sanitization cannot
  change what goes back to OpenAI. This duplicates summary text in client requests and transcripts
  and retains any intermediate ciphertext the SDK exposes; only each item's final ciphertext goes
  upstream. The envelope itself is never sent upstream. No process-local registry or provider
  ciphertext rewriting is involved. Legacy raw signatures remain readable. An unknown or malformed
  envelope is omitted, never forwarded as ciphertext; switching a valid envelope to another
  translated provider retains only the display text. Older clodex builds cannot decode these new
  signatures and would forward the envelope as provider ciphertext, which can cause upstream errors.
  Resume such transcripts with an envelope-aware build rather than downgrading the bridge. This does not
  change non-streaming responses' existing omission of reasoning, or the transport's prohibition
  on replaying already-emitted model output. The guarantee covers SDK-visible summary text,
  grouping and encrypted content, not output-only fields the SDK omits (such as `status`).
- **A tool schema's regexes are dropped when they hit a known Python incompatibility**, on every
  route but Anthropic-format ones (`src/tool-schema-sanitize.ts`). OpenAI rejects the same
  constructs python-jsonschema does — its 400 reads `'<pattern>' is not a 'regex'`, that library's
  format-checker wording — while Claude Code's built-ins are written in ECMAScript. (That is
  behaviour observed from outside, not knowledge of what OpenAI runs.) Artifact's `field` constraint
  uses `\p{Cc}`, Python answers `bad escape \p`, and since Artifact ships on every request, every
  request 400d and the session was dead from `hello` onward (#194).
  Two positions are regex-valued and both are checked: the `pattern` keyword, and every **key** of
  `patternProperties` (the 2020-12 applicator vocabulary gives `patternProperties.propertyNames`
  `format: "regex"`; a bad key returns the same 400). An incompatible `patternProperties` key is
  dropped with its subschema, since the key *is* the constraint. What goes: `\p{}`/`\P{}`,
  `\u{}`/`\x{}`, JS named groups and `\k<>` backreferences.

  **What a dropped constraint costs depends on the tool.** Claude Code runs `inputSchema.safeParse`
  before executing, but only a built-in whose Zod schema carries the same constraint is still
  guarded — Artifact's `field` is. A registered tool's `inputSchema` is `c({}).passthrough()` with
  the real schema parked in `inputJSONSchema`, and the MCP path checks only that `required` keys are
  present. So for an MCP or plugin tool the regex is a genuinely lost guard, not a lost hint. It is
  still the better trade — the alternative is a 400 that kills the session — but it is why nothing
  is dropped that does not have to be. (Verified in the 2.1.266 bundle, not inferred.)

  **Sanitizing only ever loosens**, and `patternProperties` is the one place that needed care to
  keep it that way. A dropped entry was the only thing *admitting* its keys, so with a sibling
  `additionalProperties` or `unevaluatedProperties` the removal would turn those keys from permitted
  into forbidden and the tool would stop accepting input it used to — verified with Ajv, not
  reasoned about. So dropping an entry drops the sibling closure keyword too (`true` is already the
  permissive default and is left alone). Nothing else in the walk can narrow: removing `pattern`
  only widens, and no other keyword is edited.

  The walk follows only **declared schema positions**. `const`, `enum`, `default` and `examples`
  hold instance *data*, not rules, so they are opaque: inside `const` or `enum` a `pattern` member
  is a value the schema requires and deleting it changes which instances validate, while `default`
  and `examples` are annotations that simply must not be rewritten as schemas. This is also why a tool
  parameter *named* `pattern` (Grep has one) needs no special case: it lives under `properties`,
  whose keys the walk never inspects.

  The walked keyword set is the **union across every draft**, not one of them: OpenAI's validator
  compiled regexes under `$defs` (2019+), `prefixItems` (2020) and array-form `items` (<=2019) in
  the same session, so a keyword left out is a regex that reaches the far side and 400s. That is not
  hypothetical — an earlier revision of this walk omitted `dependencies` and `contentSchema`, and
  both were confirmed live as 400s.

  Known limits, all deliberate. **Variable-width lookbehind** — alternated (`(?<=a|bb)`) or
  quantified (`(?<=a+)`) — is legal in ECMAScript and rejected by Python (`look-behind requires
  fixed-width pattern`); recognising it needs a real regex parser, so it is not detected and would
  still 400. The scanner is narrower than Python in a few other spots too (`[\w-.]`, the JS `[^]`
  idiom, bare `\pL`, backreferences to a group that does not exist). Only 14 distinct `pattern`
  values reach a built-in tool schema in 2.1.266 and none hits any of these — Artifact's `field` is
  the sole Python-incompatible one — so they are reachable only from a hand-written MCP or plugin
  schema. And OpenAI **does** reject lookaround outright on its strict
  structured-output path (`vercel/ai#16021`, `SmartBear/smartbear-mcp#491` — reports, not verified
  here; the vercel maintainers could not reproduce it synthetically). clodex does not meet that
  path: `translateTools` sends `strict: false` on `@ai-sdk/openai`, covering both OpenAI routes, and
  `@ai-sdk/openai-compatible` (OpenCode Go) goes to Chat Completions, non-strict by default. The
  explicit opt-out is load-bearing for keeping Artifact's `collection` lookahead in the payload — if
  it is ever removed, lookaround must be stripped here too.
- **Images in `tool_result` are lifted out of the text-only function-output channel** and delivered
  as real image parts on the following user message. Inline, a JSON.stringify'd base64 screenshot
  tokenizes at ~1.5 chars/token — 200k+ tokens per screenshot, killing agents with "Prompt is too
  long" while the local bytes/4 estimate showed half the real count.
  `estimateAnthropicInputTokens` likewise counts each image block at a flat vision estimate.
- **A compaction turn is forced to plain text with `toolChoice: 'none'`.** Claude Code forks that
  turn — automatic and manual `/compact` alike — with the forking session's full tool list and
  relies only on the prompt to stop the model calling them, while denying tool *execution* and
  allowing one turn. So an emitted call buys nothing: it burns the turn and returns no summary. The
  reactive path gets no retry; the manual path retries once outside the fork with a reduced tool
  set, then gives up as well. Three consecutive failures open a circuit breaker that skips later
  automatic compaction with no API
  call, until a successful compaction or a fresh query invocation resets it — which never happens
  inside one headless or subagent run, so the context grows until "Prompt is too long".
  `isClaudeCodeCompactRequest` keys on the envelope text and nothing else. Two rules it must keep:
  **do not re-narrow it to a particular tool** (`StructuredOutput` was the old precondition and
  missed every session without a schema — 15 of 173 real translated compact requests in the local
  ledgers), and **keep the header match anchored to the start of a text block**, because clodex's
  own sources, agent reports and pasted prompts quote the envelope and an unanchored match strips
  their tools. Tool *definitions* stay in the request so the cached prompt prefix still matches.
  If the strict header changes, a deliberately bounded warning-only recognizer can report one
  subset of drift without changing tool choice: after an optional known severity label, the new
  header must still start with `respond`, `return`, `answer`, `output`, `write`, or `provide`, then
  say text only and prohibit tools on one short line; the rejected-tool/only-turn anchor must remain
  at line start. It is not a general drift detector. The reverse shape — strict header
  intact, reminder changed — is deliberately invisible at runtime because it is indistinguishable
  from a pasted header. The per-build probe checks both strict markers in every extracted bundle;
  that catches their removal or in-place rewording, not a new third builder that leaves both old
  strings present. A warning is diagnostic only: tools stay enabled and compaction can still fail
  until clodex updates its markers. Terminal notices are capped at three `cc_version` signatures per
  process (plus one suppression line), while every sighting remains in the trace log.
- Anthropic- and OpenAI-format `streamText` calls abort after the configured idle window without an
  event (120s by default) or the configured total provider-call window (10m by default). True
  `generateText` calls enforce only the total window because they expose no event that can reset an
  idle clock.
- `modelPrefersResponsesApi()` selects `provider.responses(id)` for models requiring the Responses
  API (GPT-5.4+, GPT-5.5, `*-codex`, o-series); `provider.chat(id)` otherwise. Originator string is
  `clodex`.

