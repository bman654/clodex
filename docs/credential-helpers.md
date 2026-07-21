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

Credential storage is fail-closed. If the selected credential store fails its
probe, Clodex stops before device authorization and includes the backend
diagnostic in the error instead of continuing with tokens that cannot be
durably stored. Set `CLODEX_CREDENTIAL_HELPER` to the absolute path of an
external helper, then run the authorization command again.

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
standard error is not copied into Clodex diagnostics, and output and runtime
are bounded.

## Security responsibilities

Clodex owns OAuth parsing, refresh decisions, replacement-token serialization,
and in-process refresh deduplication. The helper owns storage and its security
properties. A helper should:

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
