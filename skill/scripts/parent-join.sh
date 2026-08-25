#!/bin/bash
# 親（ベル等）が room へ着卓する。
# usage: parent-join.sh <project_dir> [name] [model] [effort] [harness]
#   name 既定は bell。broadcast廃止に伴いkickoff投稿は行わない。
#   model / effort / harness は任意。親はオーナーの対話セッション（決定40）なので、席と違って
#   起動時に確定した値を script が知らない——**渡された時だけ**参加者一覧の素性として登録する。
#   渡さなければ欄ごと出ない（「不明」ではなく「素性を名乗っていない」）。
#   harness は claude（既定）、codex、または grok。model だけ渡して harness を渡さない場合は
#   claude とみなす（後方互換）。
# 親は MCP を後付けできないので room へは HTTP API 直で入る（決定40 の operating notes）。
set -e
proj="$1"; name="${2:-bell}"; model="$3"; effort="$4"; harness="$5"
mission=""
if [ "${6:-}" = "--mission" ]; then mission="${7:-}"; fi
state="$proj/.team/setup-state.json"
room=$(python3 -c "import json;print(json.load(open('$state'))['room'])")
url=$(python3 -c "import json;print(json.load(open('$state'))['server_url'])")
mode=$(python3 -c "import json;print(json.load(open('$state')).get('mode',''))")

if [ -z "${PEERTABLE_POST_TOKEN:-}" ] && [ -f "$HOME/.config/peertable.env" ]; then
  . "$HOME/.config/peertable.env"
fi

# 親はAiterm席ではない。Claude/Codex/Grokとも、親自身が所有するparent-watchを配送先にする。
# tmux observeやCodex thread IDを登録すると、通常席bridge／外部resumeへ誤配送される。
parent_harness="$harness"
if [ -z "$parent_harness" ] && [ -n "$model" ]; then
  case "$model" in
    gpt-*|o[0-9]*) parent_harness=codex ;;
    grok*) parent_harness=grok ;;
    claude*|opus*|sonnet*|haiku*|fable*) parent_harness=claude ;;
  esac
fi
if [ "$(node -p 'process.platform')" = win32 ]; then
  member=$(node "$(dirname "$0")/platform/windows/parent-member-json.mjs" "$name" "$model" "$effort" "$parent_harness" "$mission")
else
member=$(python3 - "$name" "$model" "$effort" "$parent_harness" "$mission" <<'PY'
import json, sys
name, model, effort, harness, mission = sys.argv[1:6]
# 台帳には canonical 欄だけを登録する（settings / role 単数の重複欄は 2026-08-22 廃止）
body = {'name': name, 'roles': ['統括']}
if harness:
    body['harness'] = harness
    body['vendor'] = harness  # 旧版 room server 互換
if model:
    body['model'] = model
if effort:
    body['effort'] = effort
if mission:
    body['mission'] = mission
body['observe'] = None
body['delivery'] = {'kind': 'parent_watch', 'host': harness or ''}
print(json.dumps(body, ensure_ascii=False))
PY
)
fi
curl -sf -X POST "$url/api/$room/members" \
  -H "X-Peertable-Token: $PEERTABLE_POST_TOKEN" -H 'content-type: application/json' \
  -d "$member" > /dev/null
echo "joined: ${name}（room=${room}）"

here="$(cd "$(dirname "$0")" && pwd)"

# owner裁定[46]④: 子processのexportは親shellへ伝播しないため、Lattice mutation
# （todo reopen 等）に要る actor 環境変数は親自身が source する持続ファイルとして配る。
if [ "$mode" = "lattice" ]; then
  env_file="$proj/.team/parent-env.sh"
  cat > "$env_file" <<EOF
export LATTICE_TODO_ACTOR_HOST=mac
export LATTICE_TODO_ACTOR_SESSION=${name}
export LATTICE_TODO_ACTOR_AGENT=${name}
EOF
  echo "Lattice mutation（todo reopen 等）を打つ前に: source ${env_file}"
fi

if [ -f "$proj/.team/roles/parent.md" ]; then
  echo "親役割は $proj/.team/roles/parent.md を読むこと"
fi
echo "親の権限境界: 各ToDoのクローズは監査担当が行い、親は裁定しない。親の仕事はオーナー窓口・環境修理・終端監査だけ（オーナー裁定 2026-08-22。詳細は skill/SKILL.md「親の operating notes」冒頭）"

# parent-watchが初回headを固定する。以後のDMはwatcher不在時間を含め
# 永続cursorからcatch-upされる。host内のbackground task自体は親セッションだけが所有できる。
if PEERTABLE_PARENT_HOST="$parent_harness" node "$here/parent-watch.mjs" "$proj" "$name" --prime; then
  echo "parent-watch cursor ready: ${name}（host=${parent_harness}）"
  if [ "$parent_harness" = "codex" ]; then
    echo "PARENT_WATCH_START_REQUIRED: Codex親のbackground taskで1秒ごとに ${here}/codex-parent-watch.sh ${proj} ${name} を都度実行し、空でないstdoutだけを親turnへnotifyすること。background taskはloopを続けるが、Node processや端末sessionは常駐させない"
  elif [ "$parent_harness" = "grok" ]; then
    echo "PARENT_WATCH_START_REQUIRED: Grok Monitor（persistent）で ${here}/parent-watch.mjs ${proj} ${name} --follow を1回だけ起動し、通知後も同じMonitorで待機を続けること。通常席用wakeup-bridgeに親を載せない"
  else
    echo "PARENT_WATCH_START_REQUIRED: Claude Monitor（persistent）で ${here}/parent-watch.mjs ${proj} ${name} --follow を1回だけ起動し、通知後も同じMonitorで待機を続けること"
  fi
  # 耳の疎通probe: 番犬が生きていても、その出力を受け取る監視（Monitor等）が現在の
  # 親セッションに繋がっている保証はない（番犬が前セッションの耳へ吠え続け、親宛DMが
  # 全損する実被弾 2026-08-22）。cursor確定後に親宛のprobe DMを1通置き、
  # 「監視イベントとしてこのnonceを受信した」ことを着卓完了の条件にする。
  probe_nonce="$(date +%s)-$$"
  probe_body=$(python3 - "$name" "$probe_nonce" <<'PY'
import json, sys
name, nonce = sys.argv[1:3]
print(json.dumps({'from': 'ear-probe', 'to': name,
  'body': f'[耳疎通probe {nonce}] この通知を監視イベントとして受信できていれば耳は接続済み。受信するまで着卓完了と言わないこと。'}, ensure_ascii=False))
PY
)
  if curl -sf -X POST "$url/api/$room/messages" \
    -H "X-Peertable-Token: $PEERTABLE_POST_TOKEN" -H 'content-type: application/json' \
    -d "$probe_body" > /dev/null; then
    echo "EAR_PROBE_SENT: nonce=${probe_nonce}。着卓完了の条件は、上記の監視経由でこのnonceを受信すること。受信できないなら耳は繋がっていない＝着卓失敗として扱い、監視を張り直す"
  else
    echo "WARN: EAR_PROBE_POST_FAILED: 耳疎通probeを投稿できない（監視の受信確認ができないまま）" >&2
  fi
else
  echo "WARN: PARENT_WATCH_PRIME_FAILED: 親（${name}）のDM cursorを準備できない" >&2
fi

curl -sf "$url/api/$room/members" | python3 -c "import json,sys;print('members:', ', '.join(m['name'] for m in json.load(sys.stdin)['members']))"
