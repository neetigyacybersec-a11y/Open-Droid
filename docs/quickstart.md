# Quickstart

## Option A — Docker (zero downloads)

```bash
docker pull ghcr.io/<owner>/android-mcp:latest
```

Configure OpenCode (`~/.config/opencode/opencode.jsonc`):

```jsonc
"android-mcp": {
  "type": "local",
  "command": ["docker", "run", "-i", "--rm", "--device", "/dev/kvm", "ghcr.io/<owner>/android-mcp:latest"],
  "enabled": true
}
```

## Option B — Clone + one-time setup (offline afterwards)

```bash
git clone https://github.com/<owner>/android-mcp.git
cd android-mcp
make setup          # one-time ~3GB download into ./.toolchain
source .toolchain/env.sh
make doctor
make build-mcp
```

Then configure OpenCode to run `node /path/to/android-mcp/dist/index.js`.

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
