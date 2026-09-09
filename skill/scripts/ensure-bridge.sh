#!/bin/bash
# 全OS共通の公開API実装へ渡す旧入口。
set -euo pipefail
exec node "$(dirname "$0")/ensure-bridge.mjs" "$@"
