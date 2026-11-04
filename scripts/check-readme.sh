#!/usr/bin/env bash
# Verify README.md counts match reality (skills dir count, MCP tool count).
# Exit non-zero on drift so CI fails before a stale README merges.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKILLS=$(ls -d skills/*/ 2>/dev/null | wc -l)
# Tool count: single source of truth is the EXPECTED Set literal in test/smoke.test.mjs.
# Counted with pure bash (awk range + grep/sort) — the earlier embedded python3
# heredoc failed cryptically on hosts without a real python (Windows Store stub).
TOOLS=$(awk '/const EXPECTED = new Set\(\[/,/^[ \t]*\]\);/' test/smoke.test.mjs \
        | grep -oE '"[a-z_]+"' | sort -u | wc -l)

fail=0
if ! grep -q "## Skills ($SKILLS)" README.md; then
  echo "README skills count drift: README says something else, actual $SKILLS" >&2
  grep -n "## Skills" README.md >&2
  fail=1
fi
if ! grep -q "## MCP tools ($TOOLS)" README.md; then
  echo "README tool count drift: expected $TOOLS" >&2
  grep -n "## MCP tools" README.md >&2
  fail=1
fi
if ! grep -q "smoke test ($TOOLS tools)" README.md; then
  echo "README smoke-test count drift: expected $TOOLS" >&2
  fail=1
fi
if ! grep -q "Skills ($SKILLS)" README.md; then
  echo "README TOC skills count drift" >&2
  fail=1
fi
if ! grep -q "MCP tools ($TOOLS)" README.md; then
  echo "README TOC tool count drift" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "README check FAILED" >&2
  exit 1
fi
echo "README check OK: $SKILLS skills, $TOOLS tools"
