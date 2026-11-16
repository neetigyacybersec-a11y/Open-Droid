# Security

- Never commit secrets; `.env` is gitignored.
- MCP server runs local shell commands; only run on trusted projects.
- Docker image should be run with least privilege; KVM access is required for emulator acceleration.
- Report vulnerabilities via GitHub Security Advisories.

## Workspace boundary

The MCP execution layer checks every filesystem argument before the handler
runs. Set `ANDROID_MCP_WORKSPACE` to the project root. Additional roots are
approved explicitly with `ANDROID_MCP_WORKSPACE_ROOTS` (a
`path.delimiter`-separated list). The operating-system temp directory is
approved only for tool-owned output. Without a workspace, path tools fail
closed.

Canonicalization resolves symlinks and checks a non-existent target through its
nearest existing parent. Traversal, symlinked parents, foreign drives, UNC
paths outside the approved share and case differences are handled per platform.
The boundary runs immediately before the handler and blocks unknown tools. It
does not eliminate time-of-check/time-of-use races inside the handler; treat the
policy as defense in depth.

Writes refuse to replace an existing target unless the caller passes
`overwrite: true`. Managed temporary directories are removed with
`fs.rm`, which unlinks symlinks instead of following them. Routine cleanup only
targets directories created by the operation.

## Tool-output provenance

Project, build, device, APK, Frida and network output is untrusted data. It is
framed, returned with `_meta.provenance`, stripped of terminal/control
sequences, scanned for common credentials and truncated with an explicit
marker. MCP policy/status fields are separate from the payload. These measures
reduce prompt-injection and log-forging risk; they do not prove that a model
will ignore hostile text, and they do not replace least privilege, approval
gates or an OS/container sandbox. This server cannot constrain an external
coding agent that edits files on its own.

## Diagnostic logs

Every invocation logs a start and end record to stderr with a unique
correlation ID and a truthful outcome. `isError` results and policy blocks are
never recorded as success; `partial` is not reported as total success. Logged
diagnostics are single, bounded, control-character-free lines. Secrets,
authorization headers, tokens, private keys, signing values and raw arguments,
scripts or full command output are not logged by default. Correlation IDs are
also returned in `_meta.correlationId`. Telemetry stays local and offline.
