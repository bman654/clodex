# Provider registry and the gateway server

<!-- Read when changing src/registry/, src/server/, provider templates, or model/alias resolution. -->

## Provider registry

`src/registry/`. The shipped registry has three provider templates in `src/provider-templates.ts`:
`openai` (API key), `openai-oauth`, and `opencode-go`. `provider-auth.ts` implements the OpenAI
OAuth sign-in (device code by default; browser PKCE via `--browser` for workspaces that disable
device codes); `refresh-models.ts` fetches the model list (3-tier fetch for OAuth).
Materialization (`materialize.ts`) turns registry providers into `LocalProvider`s with per-model
`npm`/`baseUrl`/`upstreamModelId`.

Provider templates can declare reusable controls for non-default behavior:

- **`verifyCredential`** runs an optional template-owned probe before a credential is persisted. It
  receives only the key: a caller-provided base URL must never redirect a live credential.
- **`staticModelPolicy` / `preserveModelPricing`** let a template restrict live discovery to its
  committed allowlist and retain provider-supplied prices. Read pricing preservation through
  `providerPreservesModelPricing()`, which falls back to the template when persisted state predates
  the flag.

`ModelRuntimeCompatibility` (`src/model-runtime-compatibility.ts`) holds provider-neutral per-model
wire quirks consumed by runtime adapters, including reasoning/request-shape controls and whether an
Anthropic-format upstream supports token counting. An explicit `supportsCountTokens: false` selects
clodex's local estimate; an unset value preserves forwarding for custom compatible endpoints.

Registry writes use atomic hard-link lock publication, so the filesystem containing `CLODEX_HOME`
must support hard links. **A parseable lock owned by a live PID is never reclaimed based on age;**
contenders wait a bounded interval and fail with the owner PID. Malformed locks and locks owned by
dead PIDs remain reclaimable. This live-owner rule is what makes the final ownership check before
`providers.json` publication meaningful — a concurrent process cannot invalidate a live writer
between its check and its rename.

**Named OAuth account slots:** `clodex providers auth openai --account <name>` stores an additional
ChatGPT account under a named slot with its own credential-store lineage; the default sign-in is
untouched. `CLODEX_OAUTH_ACCOUNT=<name>` selects a slot at launch — the swap happens once at
registry materialization (`applySelectedOAuthAccount`), so credential resolution, OAuth metadata,
and refresh-token rotation transparently use the selected account, and the WebSocket cache partition
(keyed on the token's account id) stays per-account. Naming a missing slot on a provider that has
slots is a hard error, never a silent fallback to the default identity. Removing the provider queues
every slot credential for deletion.

## Server

`src/server/`: `index.ts` loads models from the registry (`loadServerModels`); `router.ts` handles
`/anthropic` (passthrough for `modelFormat:'anthropic'` with `baseUrl`, SDK adapter for `'openai'`)
and `/openai/v1` (via `src/openai-adapter.ts`). Wizard/quick-start settings persist to config;
network mode requires a password; default port 17645 (`--port` overrides).

Endpoint-mode request model resolution (`createGatewayModelCatalog` in `server/models.ts`) accepts,
in precedence order: exact catalog id (and its gateway-discovery id) → unmasked gateway id when
`--mask-gateway-ids` is on (`vendor-mask.ts`) → canonical `clodex:{provider}:{model}` id → saved
short aliases from `clodex models --alias` — **the same alias table the proxy-mode MITM resolves**,
so endpoint and proxy routing must never evolve separate alias semantics → 400. Saved alias names
are canonicalized to lowercase, and **requests must use that stored spelling**: resolution is an
exact `Map.get`, so a wrong-case endpoint alias does not resolve.
Invalid, reserved, conflicting, unavailable, or catalog-colliding aliases remain preserved in config
but are reported and kept out of routing. **Aliases and canonical ids are accepted INPUT only** —
`/models` listings advertise exactly the canonical/masked ids. **Echo invariant:** an aliased
request's response `model` field echoes the alias verbatim (even under masking) so a patched Claude
Code's context-window lookup keys match (`aliasNames` in `ServerOptions`).

