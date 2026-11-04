# Quickstart

## Option A — Docker (no host toolchain)

No pre-built image is published yet, so build it locally first:

```bash
docker build -t open-droid:latest .
```

Configure OpenCode (`~/.config/opencode/opencode.jsonc`; same shape `opencode mcp add --global` writes):

```jsonc
"mcp": {
  "servers": {
    "android-mcp": {
      "type": "local",
      "command": ["docker", "run", "-i", "--rm", "open-droid:latest"]
    }
  }
}
```

> The container route cannot run the Android emulator (Docker Desktop does not
> expose `/dev/kvm`). Use a physical device (`adb_wifi { action: "connect",
> host: "<phone-ip>" }`) or a host/WSL2 emulator bridged with
> `-e ADB_SERVER_SOCKET=tcp:host.docker.internal:5037`.

## Option B — Clone + one-time setup (offline afterwards)

```bash
git clone https://github.com/neetigyacybersec-a11y/Open-Droid.git
cd android-mcp
make setup          # one-time ~3GB download into ./.toolchain
                    # + auto-registers MCP (global) + installs skills (global)
source .toolchain/env.sh
make doctor
make build-mcp
```

No manual config editing needed: `make setup` runs `scripts/register.sh`, which
adds the MCP server globally (`opencode mcp add android-mcp --global`) and copies
all skills into `~/.config/opencode/skills/`. Refresh anytime with `make register`.

## Create your first app

```bash
source .toolchain/env.sh
make new-app my-app
make build-app APP_DIR=my-app
```

## Live visual output

```bash
make emulator          # boot AVD
# install + launch via adb, then:
make screenshot        # captures screenshots/screen.png
```

## Dynamic analysis (optional)

`make setup` now also vendors Frida + mitmproxy for dynamic analysis. See `docs/dynamic-analysis.md`.
