#!/bin/bash
# 既存の引数を共通の製品入口へ渡す。
set -euo pipefail
exec node "$(dirname "$0")/legacy-entry.mjs" leave-seat "$@"
