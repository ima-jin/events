#!/usr/bin/env bash
# Operator-only. Never trace: subprocess output and environment may contain secrets.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
exec node "$root/scripts/soak/rollback.mjs" "$@"
