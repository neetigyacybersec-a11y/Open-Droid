# Windows entry points

Two Windows-specific problems are handled here:

- PowerShell's default execution policy can block `npm.ps1`. Running `npm test`
  or `npm run build` then fails before Node starts.
- `make` is not installed on Windows, so `make setup`, `make doctor` and
  `make new-app` are unavailable outside Git Bash/WSL2.

## Restricted PowerShell (no Git Bash needed)

Use the Node entry points directly. They never go through PowerShell scripts and
work with the default `RemoteSigned`/`Restricted` policy:

```powershell
npm.cmd ci
node scripts/build.mjs          # build dist/
node scripts/test.mjs           # full Node suite
node scripts/doctor.mjs         # native doctor (required tools, env, AVD geometry)
```

`npm.cmd` (not `npm`) installs dependencies without loading `npm.ps1`. If the
policy also blocks `npm.cmd`, install dependencies from an elevated PowerShell
with `Set-ExecutionPolicy -Scope Process Bypass`, or use Git Bash.

Typecheck only:

```powershell
node scripts/build.mjs --noEmit
```

`scripts/test.mjs` reads the file list from `package.json`, so it always matches
the npm suite.

## Shell commands and screenshots from an agent session

Some agent exec layers pass a multi-line script to PowerShell as a single
command. Two lines that work when pasted by hand can silently do nothing when
sent that way: the call returns "(no output)" and no command runs. There is no
error to diagnose. Keep agent-driven shell commands to **single-line pipelines**
(or `;`-chained commands on one line), and check for real output instead of
treating an empty result as success.

Do not redirect binary output with `>` in PowerShell. Redirection rewrites line
endings and corrupts PNG/video bytes, so a screenshot saved that way is
unusable. Capture on the device and pull one remote path per `adb pull` (a
single pull with several remote paths fails):

```powershell
adb shell screencap -p /sdcard/capture.png; adb pull /sdcard/capture.png .\capture.png; adb shell rm -f /sdcard/capture.png
```

The MCP `adb_screenshot` and `adb_screenrecord` tools already use this safe
screencap → `/sdcard` → pull → remote-cleanup flow, with one pull per capture,
and save the result to the persistent capture archive.

## Toolchain setup and scaffolding (Git Bash or WSL2)

`make setup`, `make doctor`, `make new-app`, and the `.sh` scripts require a
POSIX shell. On Windows:

1. Install [Git for Windows](https://gitforwindows.org/) (includes Git Bash), or
   enable WSL2.
2. From Git Bash at the repository root:

   ```bash
   bash scripts/setup.sh
   bash scripts/doctor.sh
   bash scripts/new-app.sh demo
   ```

   or with WSL2, run the normal `make setup` / `make doctor` / `make new-app demo`
   from the WSL checkout.

`node scripts/doctor.mjs` is the Windows-native alternative to
`bash scripts/doctor.sh` when Git Bash is not available. It reports missing
required tools, optional dynamic-analysis tools, environment variables, the MCP
build, AVD window geometry (ISSUE-12) and OpenCode registration.

## Notes

- The emulator needs Android Emulator Hypervisor Driver (AEHD) or Hyper-V; there
  is no `/dev/kvm` on Windows.
- The `python3` Windows Store alias stub exists on PATH but runs nothing. Install
  a real Python and verify `python3 -c "import sys"` succeeds before running
  dynamic-analysis setup.
- CI's `mcp-windows` job runs `node scripts/build.mjs` and
  `node scripts/test.mjs`, so the documented path is exercised on every push.
