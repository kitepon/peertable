#!/bin/bash
# 席変更は共通の公開API実装へ渡す。
set -euo pipefail
exec node "$(dirname "$0")/legacy-entry.mjs" change-seat "$@"
