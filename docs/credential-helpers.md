# Credential helpers

Clodex uses the operating system credential store by default. Headless Linux,
containers, and WSL installations can instead delegate opaque credential
storage to an external helper:

```bash
export CLODEX_CREDENTIAL_HELPER=/absolute/path/to/clodex-credential-helper
clodex providers auth openai
```

The value must be an absolute path to an executable file. Clodex invokes the
helper directly without a shell. Provider configuration records a versioned
`helper:v1:<helper-id>:<account>` reference. The helper ID is a SHA-256 digest
of the normalized executable path, so the path and username are not written to
`providers.json`. A helper-backed credential never silently falls back to the
OS keyring or an environment variable.

Changing `CLODEX_CREDENTIAL_HELPER` to a different path does not redirect old
references. Clodex refuses the operation before starting the new helper. Restore
the prior path to read or delete the old credential. Reauthentication creates a
reference owned by the new helper, but does not delete the credential from the
previous store; remove that credential with the previous backend's tooling.

Clodex verifies the selected store with a disposable write, read, and delete
before starting device authorization. It also reads back real credential
writes. OAuth refresh returns the new access token only after the rotated
credential has been stored and verified. An environment override rejected by
the upstream service remains bypassed until its value changes or the process
restarts, preventing the same stale value from causing a 401 on every request.
For stored OAuth credentials, a rejected-access marker is cleared when refresh
returns a different access token. If the identity provider keeps returning the
same rejected token, run `clodex providers auth <provider>` to reauthenticate.

Credential storage is fail-closed. If the selected credential store fails its
probe, Clodex stops before device authorization and includes the backend
diagnostic in the error instead of continuing with tokens that cannot be
durably stored. Set `CLODEX_CREDENTIAL_HELPER` to the absolute path of an
external helper, then run the authorization command again.

Provider creation, replacement, and removal use the durable cleanup journal at
`~/.clodex/credential-cleanup.json` (under `CLODEX_HOME` when set). Keeping the
journal separate from `providers.json` prevents registry writers that only know
schema 1 provider fields from dropping pending cleanup. A new unreferenced
credential is journaled before it is written, provider changes are saved before
superseded credentials are deleted, and uncertain deletion outcomes remain
queued. Per-credential cross-process locks serialize writes, activation,
removal, and reconciliation for the same reference. Reconciliation is
best-effort and sequential: a contended credential can delay later entries
until its lock attempt times out, but the timeout does not turn an already-saved
provider into a failed creation. The next `clodex providers` command retries
queued deletions idempotently and never deletes a credential that is referenced
by an active provider. If the registry cannot be read and validated, cleanup
stays queued instead of treating the registry as empty.

The cleanup journal accepts only credential accounts generated for Clodex
provider and OAuth records, including replacement, custom-provider, and scoped
credential instances. It rejects symbolic links, foreign ownership, broad
permissions on POSIX, files over 1 MiB, and more than 1,024 queued entries
before attempting any credential-store deletion.

## OS keyring layout and compatibility

The default OS credential-store backend uses five service namespaces:

- `clodex` stores a short credential directly or publishes the marker for a
  long credential;
- `clodex-chunks` stores the chunks for current long credentials;
- `clodex-journal` records crash recovery, the active chunk generation, and a
  deletion marker;
- `clodex-deleted` stores a redundant non-secret deletion guard;
- `clodex-state-key` stores a random per-account key that protects the
  filesystem recovery marker.

Clodex also keeps an authenticated encrypted per-account managed-state marker
under the native OS account home at `~/.clodex/keyring-state`. Before each
cleanup-journal write, the marker records the exact journal intent. A retry
decrypts, republishes, and verifies that intent before continuing, then marks
it managed. The encryption key remains only in the OS credential store, so a
copied filesystem marker does not expose credentials or an offline credential
confirmation value. If the OS keyring temporarily reports a managed journal as
absent, the marker makes reads, writes, and deletes fail closed instead of
replacing unknown chunk inventory. Malformed or unauthenticated local intent
also remains fail-closed.

If the filesystem marker outlives a complete OS credential-store reset,
Clodex allows direct reauthorization only after sentinel-backed service
enumeration proves that the main credential and chunk namespaces are empty.
The recovery first records durable deleted state, then follows the normal
journal-before-publication path for the replacement. A hidden, locked,
incomplete, or partially restored namespace cannot take this path and remains
fail-closed.

Credential mutation locks live beside that state under
`~/.clodex/credential-locks`. Neither path depends on `CLODEX_HOME`,
`XDG_RUNTIME_DIR`, or temporary-directory environment variables because the OS
keyring service and account namespaces are shared across those process-local
settings. The native account-home filesystem must support hard links so lock
publication remains atomic.

New provider credentials use a stable, versioned account instance owned by the
provider slot and selected credential backend. A retry derives the same
candidate, so an ambiguous result cannot make its reference unreachable.
Provisioning resumes well-formed candidate state, while unavailable or
malformed recovery metadata remains fail-closed. Refresh paths replace the
registry's current account only when its prior keyring state can be confirmed.
Reauthorization provisions the selected backend first, then updates the
registry after read-back verification. If the keyring hides both the main value
and its metadata, replacement and deletion stop without publishing new state
or reporting success.

The active-generation journal is live metadata, not stale debris. Clodex keeps
one generation after a successful long-credential write so a later release can
retire the chunks through a current provider-removal operation if an older
release removes or replaces only the main marker. Use the Clodex
provider-removal path instead of deleting one of these entries manually.

Long chunked credentials are not readable by older releases that do not
understand their marker format. If a downgrade removes the main marker while
leaving chunks behind, passive resolution preserves the recorded inventory
because a missing keyring value cannot be distinguished from a collapsed read
error on every platform. Remove the provider with a current Clodex release
before reauthorizing to retire the orphaned generation. A published marker that
does not match its recovery journal fails closed and leaves every recorded
generation intact.

Clodex does not implicitly import credentials from the legacy `relay-ai`
service. Existing legacy entries remain untouched. Reauthorize or explicitly
save the provider credential to publish it under the `clodex` service, verify
the new credential, and remove the old entry separately if it is no longer
needed. Provider removal deletes only the Clodex credential. Redundant
non-secret deletion guards keep ambiguous deleted state from becoming readable;
an explicit later credential save clears those guards. Unknown JSON-shaped
values in non-OAuth keyring and helper accounts remain opaque. Historical
`wellknown` token and OAuth access envelopes retain their existing decoding
behavior, while structured OAuth validation applies only to OAuth accounts.

## Protocol

The helper receives one of these invocations:

```text
helper get clodex <account>
helper set clodex <account>
helper delete clodex <account>
```

- `set` reads the complete opaque credential from standard input and produces
  no output.
- `get` writes the exact credential to standard output without adding a
  newline.
- `delete` removes the credential.
- Exit code `0` means success.
- Exit code `2` means not found for `get` or `delete`.
- Any other exit code means the credential operation failed.

The service and account arguments are identifiers, not secrets. Credential
contents are never passed in arguments or environment variables. Helper
standard error is drained and discarded rather than copied into Clodex
diagnostics. Captured standard output is capped at 1 MiB; exceeding it fails
the operation. Runtime is bounded for the process Clodex starts: at ten seconds
it is sent `SIGKILL` and the operation fails. Processes that helper starts are
outside both bounds, so a helper that forks has to bound them itself. See
[Process lifetime](#process-lifetime).

The helper protocol transports credential bytes without interpreting them.
For non-OAuth provider references, Clodex preserves valid opaque JSON secrets.
OAuth references accept only complete OAuth records or well-known token
records; malformed or unknown JSON is never used as a bearer token.

## Process lifetime

Clodex starts the helper directly, waits at most ten seconds, and enforces that
limit with `SIGKILL`. That is the only signal Clodex ever sends a helper, and it
reaches only the process Clodex started. A process that one forked may keep
running after the credential operation has already failed, usually reparented to
PID 1, still holding the standard output and standard error it inherited.

A wrapper script around `pass`, `gpg`, or `secret-tool` is the common shape for
a helper, and it is the shape that forks. Nothing Clodex can send will reach
what it leaves behind, so the wrapper has to take care of its own descendants:

- **Prefer `exec`.** `exec gpg --decrypt "$path"` replaces the wrapper, so the
  process Clodex kills is the one doing the work. This removes the wrapper as a
  layer; it does not constrain the program you exec, whose own children are
  still outside Clodex's bound.
- **Give anything you fork a hard deadline.** GNU coreutils `timeout` needs
  `--kill-after` to be a real bound: plain `timeout 5 cmd` sends `SIGTERM` and
  then waits forever if `cmd` ignores it, while `timeout --kill-after=1 5 cmd`
  escalates to `SIGKILL`. Note `timeout` ships with GNU coreutils and is absent
  from stock macOS and from minimal container images.
- **Clean up on interrupt by pid, never with `kill 0`.** Ctrl-C does reach the
  helper: Clodex does not detach it, so it shares Clodex's process group. A
  handler that
  signals the whole group also re-signals the wrapper and re-enters itself,
  which has been observed looping over a thousand times in five seconds. Track
  what you start and signal that:

  ```sh
  child=""
  trap 'kill "$child" 2>/dev/null; exit 143' INT TERM HUP
  gpg --decrypt "$path" & child=$!
  wait "$child"
  ```

  This is worth having, but it is not a substitute for the two points above:
  `SIGKILL` cannot be trapped, so no handler runs at the ten-second limit.

Prefer a non-interactive credential path. Clodex gives the helper pipes for
standard input, output, and error, but the controlling terminal is still
reachable through `/dev/tty`, so a program like `gpg` can still prompt through
`pinentry`. A helper waiting on a passphrase is a helper waiting out the ten
seconds.

## Security responsibilities

Clodex owns OAuth parsing, refresh decisions, replacement-token serialization,
and in-process refresh deduplication per provider and credential reference. The
helper owns storage and its security properties. A helper should:

- encrypt credentials at rest using a system or user trust root;
- serialize concurrent updates when its backend requires it;
- avoid logging standard input or standard output;
- make `set` replace the prior value atomically;
- treat `delete` of a missing entry as success or exit code `2`;
- return the stored bytes exactly from `get`.

Users who need helper arguments can point `CLODEX_CREDENTIAL_HELPER` at a small
executable wrapper. Clodex intentionally does not evaluate a shell command from
this setting.

Existing `keyring:` and `env:` provider references retain their original
behavior. Enabling a helper affects newly saved credentials. Reauthentication
stores future credentials in the helper-backed store while the previous store
remains unchanged until its credential is explicitly removed.
