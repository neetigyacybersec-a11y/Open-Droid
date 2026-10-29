#!/usr/bin/env bash
# Verify README.md counts match reality (skills dir count, MCP tool count).
# Exit non-zero on drift so CI fails before a stale README merges.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKILLS=$(ls -d skills/*/ 2>/dev/null | wc -l)
# Tool count: parse the EXPECTED set size from test/smoke.test.mjs (single source of truth).
TOOLS=$(grep -oE '"[a-z_]+"' test/smoke.test.mjs | sort -u | wc -l)
# The smoke EXPECTED set uses one entry per line-ish; fall back to a direct count of the registered tools via build if needed.
# Simpler: count the entries inside the EXPECTED Set literal.
TOOLS=$(python3 - <<'PY'
import re
s=open('test/smoke.test.mjs').read()
m=re.search(r'const EXPECTED = new Set\(\[(.*?)\]\);', s, re.S)
items=re.findall(r'"([a-z_]+)"', m.group(1))
print(len(set(items)))
PY
)

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
