#!/bin/bash
# bridge を tmux に常駐させ、最初の ready_at まで待つ薄い supervisor。
set -euo pipefail

proj="$1"; name="$2"; shift 2
case "$name" in seat-status) script="seat-status-bridge.mjs" ;; wakeup) script="wakeup-bridge.mjs" ;; alarm) script="alarm-bridge.mjs" ;; run) echo "ENSURE_BRIDGE_RETIRED: run-bridge は退役した（2026-08-22）。介入は席が自分の Lattice コマンド応答で受け取る" >&2; exit 1 ;; *) echo "usage: ensure-bridge.sh <project> <seat-status|wakeup|alarm> [args...]" >&2; exit 1 ;; esac
scripts_dir=$(cd "$(dirname "$0")" && pwd -P)
repo=$(cd "$scripts_dir/../.." && pwd -P)
peertable_version=$(node -p "require(process.argv[1]).version" "$repo/package.json")
peertable_runtime_digest=$(node "$scripts_dir/runtime-digest.mjs")
team="$proj/.team"; record="$team/$name-bridge.json"; log="$team/$name-bridge.log"
force=false
if [ "${1:-}" = "--force" ]; then force=true; shift; fi
if [ $# -eq 0 ] && [ -f "$record" ]; then
  saved=()
  while IFS= read -r arg; do saved+=("$arg"); done < <(node -e 'const x=require(process.argv[1]); for (const a of x.args||[]) console.log(a)' "$record")
  # macOS 標準 bash 3.2 の set -u では、空配列の展開が unbound variable になる。
  # args が空なら現在の「引数なし」を保ち、値がある時だけ復元する。
  if [ "${#saved[@]}" -gt 0 ]; then
    set -- "${saved[@]}"
  fi
fi
if [ -f "$record" ]; then
  if node "$scripts_dir/bridge-record-live.mjs" "$record"; then
    record_version=$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.peertable_version||"")' "$record")
    record_digest=$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.peertable_runtime_digest||"")' "$record")
    if [ "$record_version" = "$peertable_version" ] && [ "$record_digest" = "$peertable_runtime_digest" ]; then exit 0; fi
    echo "${name}-bridge: Peertable ${record_version:-unknown} → ${peertable_version} の現行runtimeへ自動更新する" >&2
    node "$scripts_dir/$script" "$proj" --stop || {
      echo "${name}-bridge: 旧版bridgeを停止できないため更新を中止する" >&2
      exit 1
    }
  fi
  if ! "$force" && grep -q 'WRITE_DENIED' "$log" 2>/dev/null; then echo "${name}-bridge: 前回はWRITE_DENIEDで終了。--forceを指定すること" >&2; exit 1; fi
fi
# shellcheck disable=SC1091
. "$(dirname "$0")/tmux-at.bash"
sock=$(node "$(dirname "$0")/tmux-socket.mjs")
room=$(node -e 'process.stdout.write(require(process.argv[1]).room)' "$team/setup-state.json")
session="peertable-${name}-${room}"
# **session が在るだけでは常駐が生きている証拠にならない**（中の node だけ死んで殻が残る）。
# pid/進捗の生存確認を通れずここへ来たsessionは、Windowsでlogを開いたままの可能性がある。
# log切詰めより先に畳み、EBUSYを発生させない。
tmux_at kill-session -t "$session" 2>/dev/null || true
# **死んだ記録をここで消す。** 残すと下の loop が前回の `ready_at` を読んで、
# 新しい bridge が1バイトも動いていない段階で success を返す——「起動していないのに
# 起動したと言う」＝この supervisor が塞ぐはずの穴そのものになる。
rm -f "$record"
if ! node -e 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], "")' "$log"; then
  echo "${name}-bridge: log を切り詰められないので追記する" >&2
  : >> "$log" || true
fi
# **手渡された env を常駐へ渡す。** 新しい session が継ぐのは tmux *server* の環境であって
# 呼び出し元 client の環境ではないので、素で起こすと `PEERTABLE_TMUX_SOCKET` の手渡しが黙って消え、
# 常駐が別の socket（本番の既定）を観測しにいく（2026-08-11 実測）。決定73 と同じ形の裏返しである。
# **秘密値はコマンドラインへ載せない。** `env PEERTABLE_POST_TOKEN=… node …` の形は
# tmux のsession起動コマンドと ps の両方に平文で残る（2026-08-30 実測）。トークンは
# 0600 の credential file へ落とし、常駐へはそのパスだけを渡す（bridge 側の
# resolvePostToken が PEERTABLE_CREDENTIAL_FILE → ~/.config/peertable.env の順で読む）
if [ -n "${PEERTABLE_POST_TOKEN:-}" ] && [ -z "${PEERTABLE_CREDENTIAL_FILE:-}" ]; then
  cred_dir="$proj/.team/credentials"
  mkdir -p "$cred_dir" && chmod 700 "$cred_dir"
  ( umask 177; printf '%s\n' "$PEERTABLE_POST_TOKEN" > "$cred_dir/bridge.token" )
  PEERTABLE_CREDENTIAL_FILE="$cred_dir/bridge.token"
  export PEERTABLE_CREDENTIAL_FILE
fi
env_prefix=""
for v in PEERTABLE_TMUX_SOCKET PEERTABLE_CREDENTIAL_FILE PEERTABLE_URL PEERTABLE_PARENT_NAME; do
  eval "val=\${$v:-}"
  [ -n "$val" ] && env_prefix="$env_prefix $v=$(printf '%q' "$val")"
done
if [ "$(node -p 'process.platform')" = "win32" ]; then
  # psmuxが起動する正規shellはPowerShell 7。POSIXの`env`とMSYS pathを文字列のまま
  # 渡すとnodeへ到達する前に終了するため、Windows nodeに各pathをargvとして変換させ、
  # PowerShell EncodedCommandを一箇所で組み立てる。
  win_command=$(node "$scripts_dir/platform/windows/build-bridge-command.mjs" \
    "$scripts_dir/$script" "$proj" "$log" "$@")
  tmux_at new-session -d -s "$session" "$win_command"
else
  tmux_at new-session -d -s "$session" "env${env_prefix} node $(dirname "$0")/$script $(printf '%q ' "$proj" "$@") >> $(printf '%q' "$log") 2>&1"
fi
for _ in $(seq 1 30); do
  if [ -f "$record" ] && node -e 'process.exit(require(process.argv[1]).ready_at?0:1)' "$record"; then
    # **末尾は本物の改行にする。** `"\\n"` と書くと JS がリテラルの `\`+`n` を足し、
    # record が JSON として壊れる——`--stop` も次回起動も `JSON.parse` で落ちて、
    # 「止められない・建て直せない常駐」ができる（2026-08-11 実測）。一時 file→rename で原子的に。
    node -e 'const fs=require("fs");const p=process.argv[1],version=process.argv[2],digest=process.argv[3],a=process.argv.slice(4);
      const t=`${p}.${process.pid}.tmp`;
      fs.writeFileSync(t,JSON.stringify({...JSON.parse(fs.readFileSync(p,"utf8")),peertable_version:version,peertable_runtime_digest:digest,args:a})+"\n");
      fs.renameSync(t,p)' "$record" "$peertable_version" "$peertable_runtime_digest" "$@"
    exit 0
  fi
  sleep .5
done
echo "${name}-bridge: ready_at を待てなかった。ログ末尾:" >&2
tail -n 20 "$log" >&2 || true
exit 1
