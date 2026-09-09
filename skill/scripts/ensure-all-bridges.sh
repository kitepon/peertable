#!/bin/bash
# 既存projectの任意巡回。npm導入からは呼ばない。
set -euo pipefail
exec node "$(dirname "$0")/ensure-all-bridges.mjs" "$@"
