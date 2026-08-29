# sourced by launch-seat / leave-seat / teardown / ensure-bridge / change-seat
# POSIX は tmux -S <sock>。Windows psmux は -L <aiterm-ns>（-S は既定 namespace へ落ちる）。
_peertable_tmux_scripts=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tmux_at() {
  local prefix
  prefix=$(node "$_peertable_tmux_scripts/tmux-socket.mjs" --prefix) || return 1
  # shellcheck disable=SC2206
  local -a conn=($prefix)
  # tmux server は最初に立てた process の locale を一生使い、C/POSIX/未設定だと UTF-8 の
  # send-keys/paste を破壊する（実被弾 2026-08-29: launchd の bridge 巡回が LANG 無しで
  # server を立て、以後の日本語込み席起動コマンドが全て化けて Codex 席が着席不能になった）。
  # launchd/cron 由来の呼び出しでも server が UTF-8 で立つよう、壊れた既定の時だけ注入する。
  # 利用者が C/POSIX 以外を明示設定している場合はその選択を尊重して触らない（aiterm と同じ判定）。
  local effective="${LC_ALL:-${LC_CTYPE:-${LANG:-}}}"
  if [ -z "$effective" ] || [[ "$effective" =~ ^(C|POSIX)$ ]]; then
    local ctype="C.UTF-8"
    [ "$(uname)" = "Darwin" ] && ctype="UTF-8"
    env -u LC_ALL LC_CTYPE="$ctype" tmux "${conn[@]}" "$@"
  else
    command tmux "${conn[@]}" "$@"
  fi
}
