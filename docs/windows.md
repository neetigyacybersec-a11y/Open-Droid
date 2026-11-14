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
