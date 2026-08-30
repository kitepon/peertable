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
# launchd環境には書込tokenが無い。bridgeのreceipt書込とresumeの席起動に必要なので、
# 標準の置き場から読み込む（無ければ従来どおり進み、書込systemは自分で degrade を報告する）
[ -f "$HOME/.config/peertable.env" ] && . "$HOME/.config/peertable.env"
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

# ---- 席の自動蘇生（オーナー恒久裁定「死んだら自動で起こせ。毎回手で復活させるな」）----
# tmux server死で全席が消える事故が反復した（実被弾 2026-08-29〜30に3回・原因未特定）。
# 台帳に居るのにtmux sessionが無い席を検知し、**工程が残っている時だけ**resumeで再着席させる。
# 仕事ゼロの時は起こさない（quotaを浪費しない。SEAT_TUI_GONE通知が親へ届く経路は別に生きている）。
# 二重起動はresume側のlaunch-seatが同名席を処理するが、周期の重複実行はlockで抑止する。
for state in /Users/kite/Developer/*/.team/setup-state.json; do
  [ -f "$state" ] || continue
  proj="$(dirname "$(dirname "$state")")"
  lock="$proj/.team/seat-revive.lock"
  # 10分cooldown（前回の蘇生が走っていれば触らない）
  if [ -f "$lock" ] && [ -n "$(find "$lock" -mmin -10 2>/dev/null)" ]; then continue; fi
  server="$(python3 -c "import json;print(json.load(open('$state'))['server_url'])" 2>/dev/null)"
  room="$(python3 -c "import json;print(json.load(open('$state'))['room'])" 2>/dev/null)"
  [ -n "$server" ] && [ -n "$room" ] || continue
  sockprefix=$(node "$scripts/tmux-socket.mjs" --prefix 2>/dev/null) || continue
  # shellcheck disable=SC2206
  conn=($sockprefix)
  dead=""
  for seat in $(curl -s --max-time 10 "$server/api/$room/members" | python3 -c "
import json,sys
try: ms=json.load(sys.stdin).get('members',[])
except Exception: ms=[]
print(' '.join(m['name'] for m in ms if m.get('harness')))" 2>/dev/null); do
    tmux "${conn[@]}" has-session -t "peer-$seat" 2>/dev/null || dead="$dead $seat"
  done
  [ -n "$dead" ] || continue
  work=$(cd "$proj" && lattice todo status --json 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(0); raise SystemExit
print(len(d.get('next_ready',[]))+len(d.get('active_set',[]))+len(d.get('audit_pending',[])))" 2>/dev/null)
  if [ "${work:-0}" -gt 0 ]; then
    date -u +%FT%TZ > "$lock"
    echo "$(date -u +%FT%TZ) 席消失を検知（$proj:$dead / 残工程 $work）。resumeで自動蘇生する"
    (cd "$proj" && bash "$scripts/resume.sh" "$proj" >> "$proj/.team/seat-revive.log" 2>&1) \
      || echo "$(date -u +%FT%TZ) 自動蘇生に失敗: $proj（seat-revive.log参照）"
  else
    echo "$(date -u +%FT%TZ) 席消失を検知したが残工程ゼロのため起こさない（$proj:$dead）"
  fi
done
