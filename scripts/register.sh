#!/usr/bin/env bash
# Automatically register android-mcp with OpenCode:
#  1. MCP server (global) so it works from any working directory
#  2. Skills (global) so they are always discovered
# Idempotent: safe to re-run; refreshes skill copies each time.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_SRC="$ROOT/skills"
SKILLS_DST="$HOME/.config/opencode/skills"
ok(){ echo "[register] OK    $*"; }
warn(){ echo "[register] WARN  $*"; }

# ---- 0. opencode presence ----
if ! command -v opencode >/dev/null 2>&1; then
  warn "opencode CLI not found. Install from https://opencode.ai then re-run: make register"
  exit 0
fi

# ---- 1. MCP server (global) ----
# Check the GLOBAL config files directly (NOT `opencode mcp list`, which also
# shows project-level registrations — a fresh clone has the project-level
# entry committed, which must not count as "registered globally").
# opencode's global config may be opencode.json or opencode.jsonc.
GLOBALLY_REGISTERED(){ [ -f "$1" ] && grep -q '"android-mcp"' "$1"; }
if [ -f "$ROOT/scripts/run-mcp.sh" ] && [ -f "$ROOT/dist/index.js" ]; then
  chmod +x "$ROOT/scripts/run-mcp.sh"
  if GLOBALLY_REGISTERED "$HOME/.config/opencode/opencode.jsonc" || GLOBALLY_REGISTERED "$HOME/.config/opencode/opencode.json"; then
    ok "MCP server android-mcp already registered (global)"
  else
    opencode mcp add android-mcp --global -- bash "$ROOT/scripts/run-mcp.sh" >/dev/null
    ok "MCP server android-mcp registered (global)"
  fi
else
  warn "MCP build not found; run 'npm run build' first"
fi

# ---- 2. Skills (global copies, refreshed every run) ----
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

# ---- 3. Verify ----
if GLOBALLY_REGISTERED "$HOME/.config/opencode/opencode.jsonc" || GLOBALLY_REGISTERED "$HOME/.config/opencode/opencode.json"; then
  ok "verified: android-mcp present in global opencode config"
else
  warn "verification failed: android-mcp not in global opencode config"
fi
echo "[register] done"
