#!/bin/bash
# 互換入口。接続処理はNodeが所有し、本人の束縛は親MCPが行う。
set -e
exec node "$(dirname "$0")/parent-prepare.mjs" "$@"
