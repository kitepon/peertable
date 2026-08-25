#!/bin/bash
# Peertable teardown の機械部分。席（tmux）も本 script が畳む。
# usage: teardown.sh <project_dir> [--purge]
#   既定（archive）: room のログを `docs/archive/` へ書き出し、`.lattice/` は残して畳む
#   --purge        : 何も残さず全部消す（従来の痕跡ゼロ・ゲスト project 向け）
# 書込トークンは環境変数 PEERTABLE_POST_TOKEN から取る（`~/.config/peertable.env` は export 付きで定義すること）。
#
# 撤去は「何が実施され、何が実施されなかったか」を1行ずつ出す。room 削除だけがトークンを要するので、
# そこが失敗しても残りの撤去は続行し、未実施を明示して非ゼロで終わる（黙って中断しない・決定58）。
#
# **既定が archive なのはオーナー裁定（2026-08-09・決定61）**。痕跡ゼロを既定にしていた時代は、
# 畳んだ瞬間に room の会話ログ（server 側の正本）と Lattice store が消えていた——**卓の議論と
# 工程の記録は、卓そのものより寿命が長い**。ゲスト project を汚さない不可侵原則は `--purge` が持つ。
set -e
proj="$1"
script_dir=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck disable=SC1091
. "$script_dir/tmux-at.bash"
peertable_repo=$(cd "$script_dir/../.." && pwd -P)
mode=archive
for arg in "${@:2}"; do
  case "$arg" in
    --purge) mode=purge ;;
    --archive) mode=archive ;;
    *) echo "ERROR: 未知の引数: ${arg}（受けるのは --purge / --archive だけ）" >&2; exit 1 ;;
  esac
done
state="$proj/.team/setup-state.json"
room=$(python3 -c "import json;print(json.load(open('$state'))['room'])")
url=$(python3 -c "import json;print(json.load(open('$state'))['server_url'])")
added=$(python3 -c "import json;print(json.load(open('$state'))['added_exclude'])")
lat_pre=$(python3 -c "import json;print(json.load(open('$state'))['lattice_preexisting'])")
runtime_pre=$(python3 -c "import json;d=json.load(open('$state'));print(d.get('runtime_preexisting', True))")
added_runtime_ex=$(python3 -c "import json;d=json.load(open('$state'));print(d.get('added_runtime_exclude', False))")
work_order_adapter=$(python3 -c "import json;d=json.load(open('$state'));print(d.get('work_order_adapter', False))")
work_order_spool_ref=$(python3 -c "import json;d=json.load(open('$state'));print(d.get('work_order_spool_ref', ''))")
# 旧 state（added_root_mcp 不在・手動フォールバック時代の root_mcp_json_fallback）も読む
added_mcp=$(python3 -c "import json;d=json.load(open('$state'));print(d.get('added_root_mcp', d.get('root_mcp_json_fallback', False)))")
added_mcp_ex=$(python3 -c "import json;d=json.load(open('$state'));print(d.get('added_mcp_exclude', d.get('root_mcp_json_fallback', False)))")

fail=0
did() { echo "teardown: [実施] $*"; }
skip() { echo "teardown: [スキップ] $*"; }
miss() { echo "teardown: [未実施] $*" >&2; fail=1; }
yes_() { [ "$1" = "True" ] || [ "$1" = "true" ]; }
platform=$(node -p 'process.platform')
normalize_read_line() {
  if [ "$platform" = win32 ]; then
    printf '%s' "$1" | node "$script_dir/platform/windows/normalize-read-line.mjs"
  else
    printf '%s' "$1"
  fi
}

mcp_remove_action=not-managed
if yes_ "$added_mcp"; then
  mcp_remove_result=$(node "$script_dir/remove-managed-room-mcp.mjs" "$proj") || exit "$?"
  mcp_remove_action=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["action"])' "$mcp_remove_result")
fi

echo "teardown: mode=${mode}（archive=ログとstoreを残す／purge=痕跡ゼロ）"

# ---- ログの控え（archive だけ）。room 自体は残るので、これは repo 側の写し ----
# 失敗しても撤去は続ける（room に原本があるため）。--purge の時だけ「消す前の最後の機会」になる
log_saved=skip
if [ "$mode" = archive ]; then
  arc="$proj/docs/archive"
  out="$arc/room-log_${room}_$(date +%Y%m%d-%H%M%S).md"
  mkdir -p "$arc"
  if python3 "$(dirname "$0")/archive-room-log.py" "$url" "$room" "$out"; then
    did "room ログの写しを ${out#"$proj/"} へ（原本は room に残る）"
    log_saved=yes
  else
    miss "room ログの写しに失敗（$url/api/$room が読めない）— **原本は room に残っている**ので撤去は続行する"
    log_saved=no
  fi
fi

# ---- 席（tmux）の終了。**`.team/` を消す前**に、この room の member だけを畳む ----
# `peer-*` を全部畳むと、同じマシンの別の卓を巻き込む（bridge が members 起点にしているのと同じ理由）
sock=$(node "$(dirname "$0")/tmux-socket.mjs")
members_json=$(python3 "$(dirname "$0")/archive-room-log.py" --members --json "$url" "$room" 2>/dev/null || true)
seat_names=$(python3 "$(dirname "$0")/archive-room-log.py" --members "$url" "$room" 2>/dev/null || true)
member_lines=$(python3 -c 'import json,sys; [print(json.dumps(x,separators=(",",":"))) for x in json.loads(sys.stdin.read())]' <<<"$members_json" 2>/dev/null || true)
if [ -z "$members_json" ]; then
  miss "席の終了 — member 一覧が取れず、畳む相手を特定できない。手で確認: tmux -S \"$sock\" list-sessions | grep peer-"
else
  closed=0
  while IFS= read -r member; do
    [ -n "$member" ] || continue
    name=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["name"])' "$member")
    target=$(python3 -c 'import json,sys; x=json.loads(sys.argv[1]); print((x.get("observe") or {}).get("tmux_target") or "peer-" + x["name"])' "$member")
    member_sock=$(python3 -c 'import json,sys; x=json.loads(sys.argv[1]); print((x.get("observe") or {}).get("tmux_socket") or sys.argv[2])' "$member" "$sock")
    if tmux_at has-session -t "$target" 2>/dev/null; then
      tmux_at kill-session -t "$target" && closed=$((closed + 1))
    fi
  done <<<"$member_lines"
  if [ "$closed" -gt 0 ]; then did "席の終了（${closed}席）"; else skip "席の終了（生きている席なし）"; fi
  left=$(tmux_at list-sessions 2>/dev/null | grep -c '^peer-' || true)
  [ "${left:-0}" -eq 0 ] || echo "teardown: [注記] 他の卓の peer-* が ${left}件 残っている（この卓のものではないので畳まない）"
fi

# Codex / Grok 席の TUI 配達（決定54）。常駐 process なので、`.team/` を消す前に確実に止める
if [ -f "$proj/.team/wakeup-bridge.json" ]; then
  # 停止に失敗しても **ここで止まらない**。`set -e` で落ちると、t6 の契約（各段の実施・未実施を
  # 1行ずつ出す／黙って中断しない）が丸ごと破れる——[未実施] も [手当] も要約も出ずに撤去が全部残る
  if node "$(dirname "$0")/wakeup-bridge.mjs" "$proj" --stop; then
    did "wakeup-bridge 停止"
  else
    miss "wakeup-bridge 停止に失敗（常駐が残る）— 上の _STOP_FAILED を見て手で止める"
  fi
else
  skip "wakeup-bridge（起動記録なし）"
fi

# 席の稼働状態ブリッジ。同じく常駐 process なので `.team/` を消す前に止める。
# ここで止めないと、pid 記録が `.team/` ごと消えて **`--stop` でも止められなくなる**——しかも
# 「起動記録が無い（既に停止）」と rc=0 で報告する＝**止めたと嘘をつく残骸**になる（実測）
if [ -f "$proj/.team/seat-status-bridge.json" ]; then
  # 停止に失敗しても **ここで止まらない**。`set -e` で落ちると、t6 の契約（各段の実施・未実施を
  # 1行ずつ出す／黙って中断しない）が丸ごと破れる——[未実施] も [手当] も要約も出ずに撤去が全部残る
  if node "$(dirname "$0")/seat-status-bridge.mjs" "$proj" --stop; then
    did "seat-status-bridge 停止"
  else
    miss "seat-status-bridge 停止に失敗（常駐が残る）— 上の _STOP_FAILED を見て手で止める"
  fi
else
  skip "seat-status-bridge（起動記録なし）"
fi

# run-bridge は退役済み（2026-08-22）。旧卓の常駐が残っていれば記録の pid を照合して止める。
if [ -f "$proj/.team/run-bridge.json" ]; then
  rb_pid=$(python3 -c "import json;print(json.load(open('$proj/.team/run-bridge.json')).get('pid',''))" 2>/dev/null || true)
  if [ -n "$rb_pid" ] && LC_ALL=C /bin/ps -o command= -p "$rb_pid" 2>/dev/null | grep -q "run-bridge.mjs"; then
    kill "$rb_pid" 2>/dev/null || true
    did "run-bridge（退役済み・旧常駐 pid ${rb_pid} を停止）"
  else
    skip "run-bridge（退役済み・生きた常駐なし）"
  fi
  rm -f "$proj/.team/run-bridge.json"
else
  skip "run-bridge（退役済み）"
fi

# run の close は成果が既定branchへ着地した証拠ではない。bridgeを止めてから、`run list`が挙げる
# **active run** の landing report を読む。**旧版は spool の work order から run を逆算していた**が、
# 配車が無くなって order が出ないので、装置に直接聞く形へ変えた（改・裁定1）。
# **`run list` は closed run を返さない**（実装で除外される）ので、ここで見えるのは未 close の分だけ
# である。closed 済み run の着地は `run close` の返値が landing report を含むので**その時点で読む**。
# `.lattice/runs` を直に走査して補わない——consumer contract 違反で、旧 orders の保持は配車の復活になる。
# 全 closed の再列挙が要るなら Lattice 側の公開面を足す別課題であって、ここで迂回実装しない。
# 未着地・未pushは判断結果なので `lattice run landing` 自体はexit 0を返し、teardownも止めない。
# **CLI の出力と exit code を先に単独で取る。** `cmd | python3` にすると pipeline の rc は
# python のものになり、**CLI が rc≠0 で typed error JSON を返しても parser が `active_runs` 欠落を
# 空配列として飲んで「active run なし」に化ける**（suzune の監査で実測・room [948]）。
# 沈黙する偽 green は、着地の見落としをそのまま「確認済み」に見せる——いちばん避けたい壊れ方である。
lattice_cli="${LATTICE_CLI:-$(command -v lattice 2>/dev/null || true)}"
run_list_json=""
run_list_rc=0
if [ -n "$lattice_cli" ] && [ -x "$lattice_cli" ]; then
  run_list_json=$(cd "$proj" && "$lattice_cli" run list --json 2>&1) || run_list_rc=$?
fi
if [ -z "$lattice_cli" ] || [ ! -x "$lattice_cli" ]; then
  miss "run landing — LATTICE_CLIが実行可能fileを指さず、着地状態を読めない: ${lattice_cli:-未設定}"
elif [ "$run_list_rc" != "0" ]; then
  miss "run landing — run list が rc=${run_list_rc} で失敗: $(printf '%s' "$run_list_json" | head -c 200)"
elif ! run_refs=$(printf '%s' "$run_list_json" | python3 -c '
import json, sys

# schema と active_runs を要求する。**typed error JSON も別 schema も黙って空扱いにしない。**
# f-string の中でバックスラッシュ付きの引用符を使わない——shell の single-quoted `python3 -c`
# へ `\"` がそのまま届き、**Python が SyntaxError で落ちる**（kanade の監査で実測・room [957]）。
# 値は先に変数へ取り出して、f-string には名前だけを置く。
raw = sys.stdin.read()
try:
    listed = json.loads(raw)
except json.JSONDecodeError as error:
    sys.exit(f"run list がJSONでない: {error}")
if not isinstance(listed, dict):
    sys.exit(f"run list がobjectでない: {type(listed).__name__}")
actual_schema = listed.get("schema")
if actual_schema != "lattice.run_list.v1":
    sys.exit(f"run list の schema が違う: {actual_schema}")
active = listed.get("active_runs")
if not isinstance(active, list):
    sys.exit(f"run list に active_runs 配列が無い: {type(active).__name__}")
# **entry を filter で捨てない。** 1件でも読めない entry があれば、active な run を落として
# 「なし」に見せることになる（suzune の監査で実測・room [956]）。全件を要求して、
# 満たさなければ非ゼロで落ちる。外部 versioned JSON の境界で fallback しない。
refs = []
for index, entry in enumerate(active):
    if not isinstance(entry, dict):
        sys.exit(f"active_runs[{index}] がobjectでない: {type(entry).__name__}")
    ref = entry.get("run_ref")
    if not isinstance(ref, str) or not ref:
        sys.exit(f"active_runs[{index}] に run_ref 文字列が無い")
    refs.append(ref)
print("\n".join(sorted(refs)))
' 2>&1); then
  miss "run landing — run listを解釈できない: $(printf '%s' "$run_refs" | head -c 200)"
elif [ -z "$run_refs" ]; then
  skip "run landing（active runなし）"
else
  while IFS= read -r run_ref; do
    run_ref=$(normalize_read_line "$run_ref")
    [ -n "$run_ref" ] || continue
    if landing_report=$(cd "$proj" && "$lattice_cli" run landing --run "$run_ref" 2>&1); then
      unlanded_count=""
      if unlanded_count=$(printf '%s' "$landing_report" | python3 -c '
import json, sys

raw = sys.stdin.read()
try:
    report = json.loads(raw)
except json.JSONDecodeError as error:
    sys.exit(f"run landing がJSONでない: {error}")
if not isinstance(report, dict):
    sys.exit(f"run landing がobjectでない: {type(report).__name__}")
actual_schema = report.get("schema")
if actual_schema != "lattice.run_landing_report.v1":
    sys.exit(f"run landing の schema が違う: {actual_schema}")
receipts = report.get("accepted_receipts")
if not isinstance(receipts, list):
    sys.exit("run landing に accepted_receipts 配列が無い")
for index, receipt in enumerate(receipts):
    if not isinstance(receipt, dict) or not isinstance(receipt.get("landed"), bool):
        sys.exit(f"accepted_receipts[{index}] の landed が真偽値でない")
print(sum(1 for receipt in receipts if not receipt["landed"]))
' 2>&1); then
        did "run landing ${landing_report}"
        if [ "$unlanded_count" != 0 ]; then
          echo "未着地 ${unlanded_count}本: run ${run_ref} の受理済み成果が canonical default branch へ着地していない" >&2
        fi
      else
        miss "run landing $run_ref — reportを解釈できない: ${unlanded_count}"
      fi
    else
      miss "run landing $run_ref — ${landing_report}"
    fi
  done <<EOF
$run_refs
EOF
fi

# setupが新しく作ったhost固有runtimeだけを撤去する。既存runtimeは他adapterや進行中runの
# 所有物を含み得るので触らない。runtimeを先に消してからexcludeを戻し、teardown後に
# untracked stateが露出する順序逆転を防ぐ。
# **配車を撤去した後の setup は `.lattice/runtime/` を作らない**ので、新しい卓ではここは常に
# skip になる。判定を残してあるのは、**配車時代に立てた卓を畳む時**にだけ効くからである
# （その卓の setup-state は `work_order_adapter: true` を持つ）。
if yes_ "$work_order_adapter" && ! yes_ "$runtime_pre"; then
  rm -rf "$proj/.lattice/runtime"
  did ".lattice/runtime/ 撤去（配車時代の setup が新規作成したhost固有state）"
elif yes_ "$work_order_adapter"; then
  skip ".lattice/runtime/（setup 以前から存在）"
else
  skip ".lattice/runtime/（setup は runtime state を作っていない）"
fi

# 外部ペイン（決定53）。`.team/` を消す前に戻す——退避先が `.team/` の中にある
ext=$(python3 -c "import json;print(json.load(open('$state')).get('external_pane', False))")
pj_pre=$(python3 -c "import json;print(json.load(open('$state')).get('project_json_preexisting', False))")

# ---- 解散（archive）: **部屋は残し、メンバー登録だけ外す** ----
# 円卓の解散は「部屋を畳む」ではなく「集まりが散る」。部屋は場所であって、次の campaign も
# 同じ部屋で続く——**過去ログが同じ部屋の履歴として繋がり、部屋は常に一つに見える**
# （オーナー裁定 2026-08-09・決定61）。参加者一覧だけ空にして、席が戻れば再登録される
if [ "$mode" = archive ]; then
  if [ -z "${PEERTABLE_POST_TOKEN:-}" ]; then
    miss "メンバー登録の解除 — TOKEN_MISSING: \`~/.config/peertable.env\` の定義が \`export\` 付きでないと子 process へ渡らない"
    echo "teardown: [手当] 参加者は次で外せる: curl -X DELETE \"$url/api/$room/members/<名前>\" -H \"X-Peertable-Token: \$PEERTABLE_POST_TOKEN\"" >&2
  elif [ -z "$seat_names" ]; then
    skip "メンバー登録の解除（一覧が取れていない）"
  else
    # 履歴に解散の区切りを残す。**部屋が続く以上、どこで卓が変わったかが読めないと
    # 過去ログが一続きの会話に見えてしまう**（次の campaign の発言と地続きになる）
    body="解散。この卓はここまで。参加者: ${seat_names}。部屋と過去ログはこのまま残り、次の卓も同じ部屋で続く。"
    python3 -c "
import json,sys,urllib.parse,urllib.request
room_path=urllib.parse.quote('$room', safe='')
req=urllib.request.Request('$url/api/' + room_path + '/messages', method='POST',
  data=json.dumps({'from':'system','to':'system','body':'''$body'''}).encode(),
  headers={'Content-Type':'application/json','X-Peertable-Token':'$PEERTABLE_POST_TOKEN'})
urllib.request.urlopen(req, timeout=10).read()
" 2>/dev/null && did "解散の区切りを履歴へ" || skip "解散の区切り（投稿できず・撤去は続行）"
    n=0
    while IFS= read -r member; do
      [ -n "$member" ] || continue
      name=$(python3 -c 'import json,sys,urllib.parse; print(urllib.parse.quote(json.loads(sys.argv[1])["name"], safe=""))' "$member")
      c=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$url/api/$room/members/$name" -H "X-Peertable-Token: $PEERTABLE_POST_TOKEN" || true)
      [ "$c" = 200 ] && n=$((n + 1))
    done <<<"$member_lines"
    did "メンバー登録の解除（${n}名）— **部屋と過去ログは残す**（${url}/${room}）"
  fi
# room 削除は --purge だけ。トークンを要する唯一の段で、ここだけが外部サービスへの依存境界
elif [ "$log_saved" = no ]; then
  miss "room 削除 $room — ログを保全できていないので消さない（保全より先に消すと会話は二度と戻らない）"
elif [ -z "${PEERTABLE_POST_TOKEN:-}" ]; then
  miss "room 削除 $room — TOKEN_MISSING: PEERTABLE_POST_TOKEN が空。\`~/.config/peertable.env\` の定義が \`export\` 付きでないと子 process へ渡らない"
else
  code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$url/api/$room" -H "X-Peertable-Token: $PEERTABLE_POST_TOKEN" || true)
  [ -n "$code" ] || code=000
  if [ "$code" = 200 ]; then
    did "room 削除 $room (HTTP 200)"
  else
    miss "room 削除 $room (HTTP $code) — 403/401 はトークン不一致、000 は server 不達"
  fi
fi
# 未実施なら `.team/` と一緒に room 名も消えるので、後から手で消せる形を先に出す
[ "$fail" -eq 0 ] || echo "teardown: [手当] room は次で消せる: curl -X DELETE \"$url/api/$room\" -H \"X-Peertable-Token: \$PEERTABLE_POST_TOKEN\"" >&2

if yes_ "$ext"; then
  if yes_ "$pj_pre"; then
    cp "$proj/.team/project.json.bak" "$proj/.lattice/project.json"
    did "外部ペイン復元（既存 project.json を書き戻し）"
  else
    rm -f "$proj/.lattice/project.json"
    did "外部ペイン撤去（project.json 削除）"
  fi
else
  skip "外部ペイン（登録なし）"
fi

if node "$script_dir/ensure-codex-room-mcp.mjs" remove "$proj" "$peertable_repo"; then
  did "Codex project設定からPeertable room MCPを撤去"
else
  miss "Codex project設定のPeertable room MCPを撤去できない"
fi

rm -rf "$proj/.team"
did ".team/ 削除"

if yes_ "$added_mcp"; then
  did ".mcp.json のPeertable room MCP撤去（${mcp_remove_action}）"
else
  skip ".mcp.json（setup が作っていない）"
fi

if yes_ "$added_mcp_ex"; then
  grep -vx '/\.mcp\.json' "$proj/.git/info/exclude" > "$proj/.git/info/exclude.tmp" || true
  mv "$proj/.git/info/exclude.tmp" "$proj/.git/info/exclude"
  did "exclude から /.mcp.json を撤去"
else
  skip "exclude の /.mcp.json（setup が足していない）"
fi

if yes_ "$added_runtime_ex"; then
  grep -vx '/\.lattice/runtime/' "$proj/.git/info/exclude" > "$proj/.git/info/exclude.tmp" || true
  mv "$proj/.git/info/exclude.tmp" "$proj/.git/info/exclude"
  did "exclude から /.lattice/runtime/ を撤去"
else
  skip "exclude の /.lattice/runtime/（setup が足していない）"
fi

if yes_ "$added"; then
  grep -vx '\.team/' "$proj/.git/info/exclude" > "$proj/.git/info/exclude.tmp" || true
  mv "$proj/.git/info/exclude.tmp" "$proj/.git/info/exclude"
  did "exclude から .team/ を撤去"
else
  skip "exclude の .team/（setup が足していない）"
fi

if [ "$lat_pre" = "True" ] || [ "$lat_pre" = "true" ]; then
  skip ".lattice/（setup 以前から存在）"
elif [ "$mode" = archive ]; then
  # 工程正本を残すのが archive の本体。**残すだけでは git が知らない**ので、追跡へ入れるのは人の判断
  did ".lattice/ を残す（工程正本・\`lattice todo status\` と \`gantt serve\` が読む）"
  echo "teardown: [注記] .lattice/ は git 追跡外のままなら次の clone に残らない。残すなら commit すること"
else
  rm -rf "$proj/.lattice"
  did ".lattice/ 削除（setup が作ったもの・--purge）"
fi

if [ "$fail" -ne 0 ]; then
  # 「再実行すればいい」と書かないこと。`.team/` は上で消えているので、2回目は setup-state.json が
  # 読めずに落ちる＝**再実行の経路は存在しない**。残っている道は上の [手当] の curl だけ（2026-08-08 実測）
  echo "teardown: 未完了 — 撤去は上のとおり済んでいる。残りは上の [手当] を手で叩くこと（.team/ は削除済みなので teardown.sh の再実行はできない）" >&2
  exit 1
fi
echo "teardown done: $proj"
