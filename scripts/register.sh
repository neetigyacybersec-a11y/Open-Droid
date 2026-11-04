#!/usr/bin/env bash
# Automatically register android-mcp with OpenCode:
#  1. Skills (global) so they are always discovered — runs regardless of the
#     OpenCode CLI state, so a broken/absent CLI never hides skill installs.
#  2. MCP server (global) so it works from any working directory.
#     Primary path: `opencode mcp add`. Fallback for CLI versions without the
#     `--global`/`--` registration flags (e.g. 1.19.x): rewrite the global
#     config file directly.
# Idempotent: safe to re-run; refreshes skill copies each time.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_SRC="$ROOT/skills"
SKILLS_DST="$HOME/.config/opencode/skills"
MCP_SCRIPT="$ROOT/scripts/run-mcp.sh"
ok(){ echo "[register] OK    $*"; }
warn(){ echo "[register] WARN  $*"; }

GLOBALLY_REGISTERED(){
  { [ -f "$HOME/.config/opencode/opencode.jsonc" ] && grep -q '"android-mcp"' "$HOME/.config/opencode/opencode.jsonc"; } \
  || { [ -f "$HOME/.config/opencode/opencode.json" ] && grep -q '"android-mcp"' "$HOME/.config/opencode/opencode.json"; }
}

# ---- 0. opencode presence (advisory only) ----
if ! command -v opencode >/dev/null 2>&1; then
  warn "opencode CLI not found. Install from https://opencode.ai then re-run: make register"
fi

# ---- 1. Skills (global copies, refreshed every run; independent of the CLI) ----
if [ -d "$SKILLS_SRC" ]; then
  count=0
  for d in "$SKILLS_SRC"/*/; do
    name="$(basename "$d")"
    [ -f "$d/SKILL.md" ] || continue
    mkdir -p "$SKILLS_DST/$name"
    cp -a "$d/SKILL.md" "$SKILLS_DST/$name/SKILL.md"
    count=$((count+1))
  done
  ok "Installed/refreshed $count skills into $SKILLS_DST"

  # Prune only skills that were previously installed by THIS repo (tracked in a
  # manifest), so unrelated user skills in the global skills dir are never
  # deleted. The manifest is rewritten on every run.
  MANIFEST="$SKILLS_DST/.android-mcp-manifest"
  pruned=0
  if [ -f "$MANIFEST" ]; then
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      if [ ! -d "$SKILLS_SRC/$name" ] && [ -d "$SKILLS_DST/$name" ]; then
        rm -rf "$SKILLS_DST/$name"
        pruned=$((pruned+1))
      fi
    done < "$MANIFEST"
  fi
  if [ "$pruned" -gt 0 ]; then
    ok "Pruned $pruned skill(s) no longer present in skills/"
  fi

  # One-time cleanup of skills removed/renamed by the 2026-10 consolidation.
  # (Safe: only the eight names this repo dropped; unrelated user skills untouched.)
  for legacy in android-design-tokens design-system-tokens compose-accessibility \
                android-accessibility-audit android-material3-design motion-design \
                uiux-design-foundations android-adaptive-layouts; do
    if [ -d "$SKILLS_DST/$legacy" ]; then
      rm -rf "$SKILLS_DST/$legacy"
      pruned=$((pruned+1))
    fi
  done
  # Write the current manifest (one skill name per line).
  : > "$MANIFEST"
  for d in "$SKILLS_SRC"/*/; do
    name="$(basename "$d")"
    [ -f "$d/SKILL.md" ] || continue
    printf '%s\n' "$name" >> "$MANIFEST"
  done
else
  warn "skills/ not found at $SKILLS_SRC"
fi

# ---- 2. MCP server (global) ----
# Check the GLOBAL config files directly (NOT `opencode mcp list`, which also
# shows project-level registrations — a fresh clone has the project-level
# entry committed historically, which must not count as "registered globally").
if [ -f "$MCP_SCRIPT" ] && [ -f "$ROOT/dist/index.js" ]; then
  chmod +x "$MCP_SCRIPT"
  if ! GLOBALLY_REGISTERED; then
    # Primary: the CLI (works on opencode >= 2.x with `--global` + `-- command`).
    if command -v opencode >/dev/null 2>&1; then
      opencode mcp add android-mcp --global -- bash "$MCP_SCRIPT" >/dev/null 2>&1 || true
    fi
  fi
  # Fallback: CLI failed or absent (e.g. v1.19.x has no --global/-- command
  # syntax). Write the global config directly, mirroring the exact JSON shape
  # `opencode mcp add --global` produces on 2.x:
  #   {"mcp":{"servers":{"<name>":{"type":"local","command":[...]}}}}
  if ! GLOBALLY_REGISTERED; then
    if command -v node >/dev/null 2>&1; then
      ANDROID_MCP_FILE="$MCP_SCRIPT" \
      GLOBAL_JSON="$HOME/.config/opencode/opencode.json" \
      GLOBAL_JSONC="$HOME/.config/opencode/opencode.jsonc" \
      ROOTDIR="$ROOT" \
      node -e '
        const fs = require("fs");
        const cfgPath = fs.existsSync(process.env.GLOBAL_JSON) ? process.env.GLOBAL_JSON
                      : (fs.existsSync(process.env.GLOBAL_JSONC) ? process.env.GLOBAL_JSONC
                      : process.env.GLOBAL_JSON);
        let cfg = {};
        if (fs.existsSync(cfgPath)) {
          try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); }
          catch {
            // Comments (JSONC) or malformed content: do not risk a lossy rewrite.
            console.error("[register] WARN  cannot merge: global config is not plain JSON (" + cfgPath + ")");
            process.exit(0);
          }
        }
        cfg.mcp ??= {}; cfg.mcp.servers ??= {};
        cfg.mcp.servers["android-mcp"] = {
          type: "local",
          command: ["bash", process.env.ANDROID_MCP_FILE],
        };
        fs.mkdirSync(require("path").dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
        console.log("[register] wrote " + cfgPath);
      '
    fi
  fi
  if GLOBALLY_REGISTERED; then
    ok "MCP server android-mcp registered (global)"
  else
    warn "MCP server android-mcp NOT registered (global). Add manually to ~/.config/opencode/opencode.json:"
    warn '   "mcp": { "servers": { "android-mcp": { "type": "local", "command": ["bash", "<repo>/scripts/run-mcp.sh"] } } }'
  fi
else
  warn "MCP build not found; run 'npm run build' first"
fi

# ---- 3. Verify ----
if GLOBALLY_REGISTERED; then
  ok "verified: android-mcp present in global opencode config"
else
  warn "verification failed: android-mcp not in global opencode config"
fi
echo "[register] done"
