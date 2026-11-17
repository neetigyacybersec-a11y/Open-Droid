# Execution policy and approvals

The MCP server enforces a configurable execution policy at the boundary, before
a tool handler runs. Prompt instructions are not part of the enforcement path:
an agent that ignores guidance still cannot run a gated operation without a
valid approval token.

This policy sits after the workspace check. Path arguments are validated first;
then the execution policy decides whether the call may run, needs approval, or
is refused.

## Modes

| Mode | Behavior |
|---|---|
| `balanced` (default) | Approval-free tools run. Every tool whose registry entry requires `confirmation` or `expert` approval is blocked until a bound token is supplied. Production-impacting Gradle tasks are also gated. |
| `restricted` | Read-only tools (`risk: read-only`, non-production impact) run. Other tools must be named in `ANDROID_MCP_ALLOW` by tool name or policy key, and the approval gate still applies. |
| `permissive` | Everything runs, including gated tools, but each high-impact result carries a `[android-mcp:policy]` warning. Intended for an expert who deliberately accepts the risk. |

Invalid configuration fails closed at startup. In particular, wildcard
allowlists, unknown modes, approval secrets shorter than 32 characters and
approval TTLs outside 30–3600 seconds are rejected.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ANDROID_MCP_POLICY` | `balanced` | `permissive`, `balanced` or `restricted`. |
| `ANDROID_MCP_ALLOW` | empty | Comma-separated tool names or policy keys allowed in `restricted` mode. Wildcards such as `*` are rejected. |
| `ANDROID_MCP_APPROVAL_SECRET` | unset | Shared HMAC secret, at least 32 characters. Required to approve gated work in `balanced` and `restricted` modes. |
| `ANDROID_MCP_APPROVAL_TTL_SEC` | `300` | Approval lifetime in seconds, integer 30–3600. |

Example restricted server configuration:

```bash
export ANDROID_MCP_POLICY=restricted
export ANDROID_MCP_ALLOW=device.shell,gradle.task
export ANDROID_MCP_APPROVAL_SECRET="$(openssl rand -hex 32)"
```

`ANDROID_MCP_ALLOW` accepts registry policy keys such as `device.shell`,
`device.file.delete`, `emulator.delete`, `gradle.task`, `network.capture` and
`network.serve`, or exact tool names such as `adb_shell`. Allowlisting does not
replace approval. `tool_catalog` returns the policy key for every tool.

## Impact classes

Every tool is classified from its registry risk. `tool_catalog` and the
generated [`tool-catalogue.md`](tool-catalogue.md) expose the result.

| Impact | Meaning | Examples |
|---|---|---|
| `read-only` | Inspects state without writing. | `android_env_check`, `adb_devices`, `secret_scan` |
| `local-reversible` | Writes recoverable local files or build output. | `apk_decompile`, `privacy_scan` |
| `device-state` | Changes an emulator or device in a recoverable way. | screenshot capture, app launch, logcat collection |
| `destructive` | Deletes data, uninstalls apps, clears app data, reboots or wipes state. | `adb_shell`, `adb_rm`, `adb_uninstall`, `adb_clear_data`, `adb_reboot`, `avd_delete`, `avd_wipe` |
| `network-exposure` | Starts a listener or interception service. | `net_capture`, `apk_serve` |
| `external-write` | Downloads or installs outside the workspace. | `sdkmanager_install` |
| `production` | Publishes, uploads, deploys, promotes, signs or releases. | `gradle_task` with a publish-like task, except `publishToMavenLocal` |

Gradle task classification is deliberately heuristic. A task name containing
`publish`, `upload`, `deploy`, `promote`, `play`, `sign` or `release` is treated
as production-impacting. Custom task names that do not match remain classified
by their base risk, so review unusual build logic yourself.

## Approval workflow

1. Call the tool normally. A gated call returns a structured block without
   running the handler:

   ```text
   status=blocked
   tool=adb_shell
   reason=approval-required
   mode=balanced
   impact=destructive
   target=device:emulator-5554
   preview=adb -s emulator-5554 shell rm -rf /sdcard/secret
   approval-request=eyJ2ZXJzaW9uIjoxLCJpZCI6...
   approval-fingerprint=...
   approval-expires=...
   ```

   `_meta.approval.request` contains the same encoded request and
   `_meta.approval.passAs` is `approvalToken`.

2. A human or host reviews the tool, target, impact, preview and expiry. The
   server does not display an interactive confirmation prompt.

3. The reviewer signs that exact request out of band:

   ```bash
   ANDROID_MCP_APPROVAL_SECRET="$(cat .approval-secret)" \
     npm run approve -- 'eyJ2ZXJzaW9uIjoxLCJpZCI6...'
   ```

   The command prints one token. Use `-- --json` to print the decoded request
   and token together.

4. Retry the same tool with the same arguments plus a top-level
   `approvalToken`. The token is stripped before the handler receives the
   arguments:

   ```json
   {
     "deviceId": "emulator-5554",
     "command": "rm -rf /sdcard/secret",
     "approvalToken": "<token from npm run approve>"
   }
   ```

A token is bound to all of the following:

- the server process instance (a restart invalidates outstanding tokens),
- the tool name and policy key,
- the resolved impact class,
- the canonical argument set, including target identifiers and paths,
- its issue and expiry timestamps.

Approval tokens are single-use. Replaying a consumed token returns
`reason=approval-replayed`. Altering an argument returns
`reason=approval-mismatch`. Forged or tampered signatures return
`reason=approval-invalid`. Expired tokens return `reason=approval-expired`.

In `balanced` or `restricted` mode without an approval secret, gated calls
return `reason=approval-unconfigured` and no request is issued. Set the secret
on both the server and the signing host, or deliberately choose `permissive`.

## What the policy does and does not do

The policy enforces decisions inside the MCP server:

- blocked calls never reach their handlers,
- successful results include `_meta.policy` with the mode, impact, decision,
  target and warnings,
- permissive-mode warnings are MCP-owned content blocks, separate from untrusted
  tool output,
- audit records include the mode, impact, decision, target, reason and approval
  ID, but not raw arguments, scripts or full output.

Limitations:

- There is no confirmation UI. `npm run approve` signs a request it is given;
  it does not verify that a human understood the preview.
- Approval state is process-local and bounded. A restart invalidates all tokens;
  the ledger does not survive restart. Under extreme approval volume, old
  consumed IDs may be evicted while still within their TTL.
- The token travels as a normal MCP argument and may appear in client-side
  request logs. It is single-use and short-lived, but treat it as a bearer
  credential until it expires.
- `permissive` mode removes the approval gate. Its warnings are advisory.
- The policy covers calls made through this MCP server. It does not constrain
  shell commands, editors or other tools that an agent can invoke directly.
- The approval secret must be available to the MCP server process and to the
  signer. If the agent can read that secret or invoke the signer with it, the
  approval gate becomes an audit trail rather than a security boundary. Keep
  approval material out of the agent's environment where possible.
- The workspace policy and this execution policy are guardrails, not an OS or
  container sandbox. See [SECURITY.md](../SECURITY.md).

## Migration from earlier versions

Earlier builds behaved like `permissive` mode. `balanced` is now the default so
gated tools need both a secret and an approval token. To keep the previous
behavior for a trusted local session, set:

```bash
export ANDROID_MCP_POLICY=permissive
```

The server logs its mode, approval configuration and allowlist size at startup:

```text
[android-mcp] execution policy: mode=balanced approvals=configured allow=none
```

## Related

- [`docs/tool-catalogue.md`](tool-catalogue.md) — per-tool impact, risk, approval
  and provenance metadata.
- [`docs/dependency-review.md`](dependency-review.md) — supply-chain review of
  build and dependency changes.
- [`SECURITY.md`](../SECURITY.md) — trust model and reporting.
