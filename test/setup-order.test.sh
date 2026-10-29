#!/usr/bin/env bash
# The bug this pins: SYSTEM_IMAGE referenced $IMG_ABI before it was defined.
set -euo pipefail
DEF=$(grep -n 'IMG_ABI=' scripts/setup.sh | head -1 | cut -d: -f1)
USE=$(grep -n 'SYSTEM_IMAGE=' scripts/setup.sh | head -1 | cut -d: -f1)
[ -n "$DEF" ] && [ -n "$USE" ]
if [ "$DEF" -gt "$USE" ]; then echo "FAIL: IMG_ABI defined (line $DEF) after first use (line $USE)"; exit 1; fi
PY=$(grep -cn 'python3' scripts/setup.sh)
[ "$PY" -ge 1 ] || { echo "FAIL: no python3 preflight in setup.sh"; exit 1; }
echo "setup-order test passed"
