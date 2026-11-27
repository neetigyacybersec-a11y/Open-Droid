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
# Source/destination are overridable for isolated tests; defaults are the repo
# and the global OpenCode skills directory.
SKILLS_SRC="${ANDROID_MCP_SKILLS_SRC:-$ROOT/skills}"
SKILLS_DST="${ANDROID_MCP_SKILLS_DST:-$HOME/.config/opencode/skills}"
MCP_SCRIPT="$ROOT/scripts/run-mcp.sh"
ok(){ echo "[register] OK    $*"; }
warn(){ echo "[register] WARN  $*"; }

GLOBALLY_REGISTERED(){
  { [ -f "$HOME/.config/opencode/opencode.jsonc" ] && grep -Eq '"android-mcp"[[:space:]]*:' "$HOME/.config/opencode/opencode.jsonc"; } \
  || { [ -f "$HOME/.config/opencode/opencode.json" ] && grep -Eq '"android-mcp"[[:space:]]*:' "$HOME/.config/opencode/opencode.json"; }
}

# ---- 0. opencode presence (advisory only) ----
if ! command -v opencode >/dev/null 2>&1; then
  warn "opencode CLI not found. Install from https://opencode.ai then re-run: make register"
fi

# ---- 1. Skills (global copies, refreshed every run; independent of the CLI) ----
# Every skill is a directory: SKILL.md plus references, templates, examples and
# other local resources. Sync the whole tree so linked files exist globally.
skill_sync() {
  local src="$1" dst="$2"
  if [ "${ANDROID_MCP_SKILL_COPY:-auto}" != "copy" ] && command -v rsync >/dev/null 2>&1; then
    # --checksum: skill edits are usually small and can share an mtime second;
    # the default size+mtime quick check would then leave a stale global copy.
    if ! rsync -a --checksum --delete "$src/" "$dst/"; then
      return 1
    fi
    return 0
  fi

  # Fallback for hosts without rsync (e.g. Windows Git Bash): stage a full
  # copy, then replace only this owned skill directory. The staged copy means a
  # failed copy never damages the previously installed skill.
  local tmp backup
  tmp="$(mktemp -d "${dst}.tmp.XXXXXX")" || return 1
  if ! cp -a "$src/." "$tmp/"; then
    rm -rf "$tmp"
    return 1
  fi
  if [ -e "$dst" ]; then
    backup="${dst}.old.$$"
    rm -rf "$backup"
    if ! mv "$dst" "$backup"; then
      rm -rf "$tmp"
      return 1
    fi
    if ! mv "$tmp" "$dst"; then
      mv "$backup" "$dst" || true
      rm -rf "$tmp"
      return 1
    fi
    rm -rf "$backup"
  elif ! mv "$tmp" "$dst"; then
    rm -rf "$tmp"
    return 1
  fi
}

if [ -d "$SKILLS_SRC" ]; then
  if ! mkdir -p "$SKILLS_DST"; then
    echo "[register] FAILED cannot create $SKILLS_DST" >&2
    exit 1
  fi

  count=0
  failures=0
  for d in "$SKILLS_SRC"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    [ -f "$d/SKILL.md" ] || continue
    if skill_sync "$d" "$SKILLS_DST/$name"; then
      count=$((count+1))
    else
      echo "[register] FAILED could not install skill '$name' from $d" >&2
      failures=$((failures+1))
    fi
  done

  if [ "$failures" -gt 0 ]; then
    echo "[register] FAILED $failures skill(s) were not installed; manifest left unchanged" >&2
    exit 1
  fi
  ok "Installed/refreshed $count skills into $SKILLS_DST"

  # Prune only skills that were previously installed by THIS repo (tracked in a
  # manifest), so unrelated user skills in the global skills dir are never
  # deleted. The manifest is rewritten on every successful run.
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

# Tests and non-MCP installs can stop after skills; the default still registers
# the server below.
if [ "${ANDROID_MCP_SKIP_MCP_REGISTRATION:-0}" = "1" ]; then
  ok "skipped MCP registration (ANDROID_MCP_SKIP_MCP_REGISTRATION=1)"
  echo "[register] done"
  exit 0
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
        // Atomic replace: a crash or a second registration cannot leave a
        // half-written global config (audit 8).
        const tmp = cfgPath + "." + process.pid + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
        fs.renameSync(tmp, cfgPath);
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
