#!/bin/bash
# 旧入口互換。処理の正本はOS共通のNode実装。
exec node "$(dirname "$0")/upgrade-team-assets.mjs" "$@"
