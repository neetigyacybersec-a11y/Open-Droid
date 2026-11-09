#!/usr/bin/env bash
# FR-R20 repo hygiene guard.
# Fails when generated output, packaged artifacts or root clutter can leak
# into a scaffold, a commit or a release.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail=0
fail_msg() { echo "repo hygiene: $*" >&2; fail=1; }

for dir in templates examples; do
  [ -d "$dir" ] || fail_msg "missing source directory: $dir"
done

# 1. Templates and examples are source only. A build/ directory ships stale,
#    package-specific output into every app scaffolded from the template.
while IFS= read -r -d '' dir; do
  fail_msg "generated directory under source tree: ${dir#./}"
done < <(find templates examples -type d -name build -print0 2>/dev/null)

# 2. No packaged artifacts in source trees.
while IFS= read -r -d '' file; do
  fail_msg "packaged artifact under source tree: ${file#./}"
done < <(find templates examples -type f \( -name '*.apk' -o -name '*.aab' \) -print0 2>/dev/null)

# 3. Tracked files stay small outside the media directory.
#    git cat-file reads the indexed blob, so symlinks and spaces are safe.
while IFS= read -r -d '' file; do
  case "$file" in docs/media/*) continue ;; esac
  bytes=$(git cat-file -s ":$file")
  if [ "$bytes" -gt 1048576 ]; then
    fail_msg "tracked file exceeds 1 MB outside docs/media: $file ($bytes bytes)"
  fi
done < <(git ls-files -z)

# 4. Root layout is an explicit allowlist; unexpected entries are clutter.
#    The backlog's "<= 22 entries" count conflicts with its own target layout
#    (which lists ~29 required entries), so the allowlist enforces the same
#    intent without a brittle number.
allowed_root="AGENTS.md BACKLOG.md CHANGELOG.md CONTRIBUTING.md LICENSE README.md SECURITY.md THIRD-PARTY.md Makefile Dockerfile package.json package-lock.json tsconfig.json eslint.config.mjs versions.env src test scripts docker frida-scripts skills templates examples docs manifest libs knowledge .github .githooks .opencode .gitignore .gitattributes .dockerignore .prettierrc .firecrawl"
while IFS= read -r entry; do
  case "$entry" in
    .git|.toolchain|node_modules|dist|build|.gradle|.idea|local.properties|screenshots|my-app|.DS_Store) continue ;;
  esac
  case " $allowed_root " in
    *" $entry "*) ;;
    *) fail_msg "unexpected root entry: $entry" ;;
  esac
done < <(ls -A1)

# 5. .opencode holds the shared config and skills link, not session copies.
if [ -d .opencode ]; then
  while IFS= read -r entry; do
    case "$entry" in
      opencode.jsonc|skills) ;;
      *) fail_msg "unexpected .opencode entry: $entry" ;;
    esac
  done < <(ls -A1 .opencode)
fi

# 6. Ignore rules that keep the above true.
for path in "build/generated" ".gradle/cache" "local.properties" "app-debug.apk" "app-release.aab" ".opencode/session/SKILL.md"; do
  if ! git check-ignore -q "$path"; then
    fail_msg ".gitignore does not cover: $path"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "repo hygiene FAILED" >&2
  exit 1
fi
echo "repo hygiene OK: source trees clean, root layout declared, ignore rules complete"
