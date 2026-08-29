#!/bin/bash
# launchd（dev.kitepon.peertable-bridges）から2分周期で呼ばれ、稼働中の全円卓のbridgeを
# 生存保証する。ensure-bridge.sh は生きていれば何もしない冪等な入口なので、この巡回は
# 「死んだら次の周期で自動再起動」を意味する（オーナー裁定 2026-08-29「毎回手で復活させるな」）。
# 対象卓の発見は実物（.team/setup-state.json の存在）だけを根拠にする。登録簿は持たない。
set -u
# launchd環境にはTMPDIRが無く、tmux socketの既定解決（$TMPDIR/claude-tmux-sockets/…）が
# /tmp側へ落ちて全ensureが失敗する（実被弾 2026-08-29）。macOSの正規per-user tempを自前導出する。
if [ -z "${TMPDIR:-}" ] && command -v getconf >/dev/null; then
  TMPDIR="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"
  [ -n "$TMPDIR" ] && export TMPDIR
fi
scripts="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
for state in /Users/kite/Developer/*/.team/setup-state.json; do
  [ -f "$state" ] || continue
  proj="$(dirname "$(dirname "$state")")"
  bash "$scripts/ensure-bridge.sh" "$proj" seat-status >/dev/null 2>&1 \
    || echo "$(date -u +%FT%TZ) ensure失敗: seat-status $proj"
  bash "$scripts/ensure-bridge.sh" "$proj" alarm >/dev/null 2>&1 \
    || echo "$(date -u +%FT%TZ) ensure失敗: alarm $proj"
  # wakeup は配達先の席名一覧が要る。room 台帳から現行メンバーを実物で読む
  server="$(python3 -c "import json;print(json.load(open('$state'))['server_url'])" 2>/dev/null)"
  room="$(python3 -c "import json;print(json.load(open('$state'))['room'])" 2>/dev/null)"
  if [ -n "$server" ] && [ -n "$room" ]; then
    seats="$(curl -s --max-time 10 "$server/api/$room/members" | python3 -c "
import json,sys
try:
    ms=json.load(sys.stdin).get('members',[])
except Exception:
    ms=[]
print(' '.join(m['name'] for m in ms if m.get('observe') or m.get('harness')))" 2>/dev/null)"
    if [ -n "$seats" ]; then
      # shellcheck disable=SC2086
      bash "$scripts/ensure-bridge.sh" "$proj" wakeup $seats >/dev/null 2>&1 \
        || echo "$(date -u +%FT%TZ) ensure失敗: wakeup $proj ($seats)"
    fi
  fi
done
