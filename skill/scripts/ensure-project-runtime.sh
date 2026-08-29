#!/bin/bash
# 円卓runtimeを一回の呼出しで現行Peertable版へ収束させる。
set -euo pipefail

proj="${1:-}"
[ -n "$proj" ] || { echo "usage: ensure-project-runtime.sh <project_dir>" >&2; exit 2; }
scripts=$(cd "$(dirname "$0")" && pwd -P)

for kind in alarm seat-status wakeup; do
  "$scripts/ensure-bridge.sh" "$proj" "$kind"
done

echo "peertable runtime ready: alarm / seat-status / wakeup"
