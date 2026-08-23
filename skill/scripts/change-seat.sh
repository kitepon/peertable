#!/bin/bash
# 席の harness / model / effort を変更する。
# usage: change-seat.sh <project_dir> <member> [--harness <harness>] [--model <model>] [--effort <effort>] [--parent <name>] [--reason <text>]
#
# **自然文の依頼を再解釈しない。** 依頼の意味・本人の意図・変更してよい局面を判断するのは親である AI で、
# この script が受け取るのは親が確定した target だけである（旧 change-effort.sh の
# 「本人→親の単独DMが `[effort変更依頼] <level>` と完全一致すること」という機械判定は廃止した。
# 明確な自然文の依頼を、同じ文面の再送を求めて拒否していたため）。
# この script が持つのは、親には出来ない外部境界の仕事だけである:
#   現在の素性の取得 / target の live catalog 検証 / 同値no-op / busy保護 / 再起動 /
#   metadata の読み返し / room 履歴 / 失敗時の旧設定への1回だけの明示rollback。
#
# 会話contextは引き継がない。作業状態はroomログ・工程正本・gitから再着任で回収する。
set -eu

# token値はこの制御processや再起動する席へ継承しない。launch後のroom記録も席別file経由で行う。
unset PEERTABLE_POST_TOKEN
script_dir=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck disable=SC1091
. "$script_dir/tmux-at.bash"
credential_helper="${PEERTABLE_CREDENTIAL_HELPER:-$script_dir/seat-credential.mjs}"

proj="${1:-}"; name="${2:-}"
shift 2 2>/dev/null || true
opt_harness=""; opt_model=""; opt_effort=""; parent="bell"; reason=""
while [ $# -gt 0 ]; do
  case "$1" in
    --harness|--vendor) opt_harness="${2:-}"; shift 2 || true ;;  # --vendor は旧名互換
    --model)  opt_model="${2:-}";  shift 2 || true ;;
    --effort) opt_effort="${2:-}"; shift 2 || true ;;
    --parent) parent="${2:-}";     shift 2 || true ;;
    --reason) reason="${2:-}";     shift 2 || true ;;
    *) echo "SEAT_CHANGE_ARGS_INVALID: 不明な引数 $1" >&2; exit 2 ;;
  esac
done
[ -n "$proj" ] && [ -n "$name" ] || {
  echo "SEAT_CHANGE_ARGS_INVALID: usage: change-seat.sh <project_dir> <member> [--harness <harness>] [--model <model>] [--effort <effort>] [--parent <name>] [--reason <text>]" >&2
  exit 2
}
[ -n "$opt_model" ] || [ -n "$opt_effort" ] || {
  echo "SEAT_CHANGE_ARGS_INVALID: --model と --effort の少なくとも一方が要る" >&2; exit 2
}
case "$name:$parent" in
  *[!A-Za-z0-9._:-]*) echo "SEAT_CHANGE_ARGS_INVALID: member/parent名に使えない文字がある" >&2; exit 2 ;;
esac

state="$proj/.team/setup-state.json"
[ -f "$state" ] || { echo "SEAT_CHANGE_STATE_MISSING: $state" >&2; exit 1; }
read -r room url <<EOF
$(python3 -c "import json;d=json.load(open('$state'));print(d['room'],d['server_url'])")
EOF

members=$(curl -sf "$url/api/$room/members") || {
  echo "SEAT_CHANGE_ROOM_UNREACHABLE: membersを読めない" >&2; exit 1;
}
meta=$(printf '%s' "$members" | python3 -c '
import json,sys
name=sys.argv[1]
member=next((m for m in json.load(sys.stdin).get("members",[]) if m.get("name")==name),None)
if not member or (member.get("harness") or member.get("vendor")) not in ("claude","codex","grok") or not member.get("model"):
    raise SystemExit(1)
roles=member.get("roles") or []
print("\t".join(((member.get("harness") or member.get("vendor")),member["model"],member.get("effort") or "",member.get("aiterm_session_id") or "",",".join(roles))))
' "$name") || { echo "SEAT_CHANGE_MEMBER_METADATA_MISSING: ${name} のharness/modelが要る" >&2; exit 1; }
IFS=$'\t' read -r old_harness old_model old_effort aiterm_session_id old_role <<EOF
$meta
EOF

harness="${opt_harness:-$old_harness}"
case "$harness" in
  claude|codex|grok) ;;
  *) echo "SEAT_CHANGE_HARNESS_UNSUPPORTED: harness=${harness}（claude / codex / grok のみ）" >&2; exit 2 ;;
esac
if [ "$harness" != "$old_harness" ] && { [ -z "$opt_model" ] || [ -z "$opt_effort" ]; }; then
  echo "SEAT_CHANGE_ARGS_INVALID: harness変更には --model と --effort の明示指定が要る" >&2
  exit 2
fi
model="${opt_model:-$old_model}"
effort="${opt_effort:-$old_effort}"
# effort を持たない席（CLI 既定で走っている席）へ model だけ渡すと、再起動で effort が確定してしまう。
# 既定値をここへ埋めない——launch-seat.sh と同じく「席を立てる時に決める」（オーナー裁定）。
[ -n "$effort" ] || {
  echo "SEAT_CHANGE_EFFORT_UNKNOWN: ${name} の現在effortがmetadataに無い。--effort を明示する" >&2; exit 1
}

if [ "$model" = "$old_model" ] && [ "$effort" = "$old_effort" ] && [ "$harness" = "$old_harness" ]; then
  echo "SEAT_CHANGE_NOOP: ${name} は既に model=${model} / effort=${effort}（再起動しない）"
  exit 0
fi

sock="${PEERTABLE_TMUX_SOCKET:-${TMPDIR:-/tmp/}claude-tmux-sockets/claude.sock}"
sess="peer-$name"
tmux_at has-session -t "$sess" 2>/dev/null || {
  echo "SEAT_CHANGE_SEAT_MISSING: ${sess}" >&2; exit 1;
}
screen=$(tmux_at capture-pane -t "$sess" -p -S -25 2>/dev/null) || {
  echo "SEAT_CHANGE_SEAT_UNREADABLE: $sess" >&2; exit 1;
}
# busy の判定文字列は seat-status-bridge と同じ（Claude のステータス行にも Codex の `Working (…)` にも出る）
case "$screen" in
  *"esc to interrupt"*) echo "SEAT_CHANGE_SEAT_BUSY: ${sess} は処理中。本人がidleになってから再実行する" >&2; exit 1 ;;
esac

# target の検証は live 面だけを使い、古くなる hardcode を足さない。
case "$harness" in
  claude)
    # Claude には非破壊で引ける model catalog が無い（`--help` の alias 例は catalog ではなく、
    # 実際 2026-08-11 に `fable` は例に載ったまま live では unavailable だった）。
    # よって **model 名は事前検証しない**——実 CLI の起動失敗と rollback が正式な検証境界である。
    # effort は `--help` が live に列挙するので、そこから取る。
    help_text=$(claude --help 2>/dev/null) || {
      echo "SEAT_CHANGE_EFFORT_CATALOG_UNAVAILABLE: claude --help を読めない" >&2; exit 1;
    }
    levels=$(printf '%s' "$help_text" | python3 -c '
import re,sys
text=sys.stdin.read()
i=text.find("--effort")
m=re.search(r"\(([a-z0-9, ]+)\)", text[i:i+400]) if i>=0 else None
if not m: raise SystemExit(1)
print(" ".join(x.strip() for x in m.group(1).split(",") if x.strip()))
') || {
      echo "SEAT_CHANGE_EFFORT_CATALOG_UNAVAILABLE: claude --help が effort の水準を列挙しない" >&2; exit 1;
    }
    case " $levels " in
      *" $effort "*) ;;
      *) echo "SEAT_CHANGE_EFFORT_UNSUPPORTED: claude は effort=${effort} を提供していない（live: ${levels}）" >&2; exit 1 ;;
    esac
    ;;
  codex)
    catalog=$(codex debug models 2>/dev/null) || {
      echo "SEAT_CHANGE_MODEL_CATALOG_UNAVAILABLE: codex debug models" >&2; exit 1;
    }
    verdict=$(printf '%s' "$catalog" | python3 -c '
import json,sys
model,effort=sys.argv[1:3]
entry=next((m for m in json.load(sys.stdin).get("models",[]) if m.get("slug")==model),None)
if entry is None:
    print("model"); raise SystemExit(0)
levels=[x.get("effort") for x in entry.get("supported_reasoning_levels",[])]
print("ok" if effort in levels else "effort")
' "$model" "$effort") || {
      echo "SEAT_CHANGE_MODEL_CATALOG_UNAVAILABLE: codex debug models の出力を読めない" >&2; exit 1;
    }
    case "$verdict" in
      model)  echo "SEAT_CHANGE_MODEL_UNSUPPORTED: codex catalog に model=${model} が無い" >&2; exit 1 ;;
      effort) echo "SEAT_CHANGE_EFFORT_UNSUPPORTED: codex/${model} は effort=${effort} をcatalogで提供していない" >&2; exit 1 ;;
    esac
    ;;
  grok)
    catalog=$(grok models 2>/dev/null) || {
      echo "SEAT_CHANGE_MODEL_CATALOG_UNAVAILABLE: grok models" >&2; exit 1;
    }
    if ! printf '%s' "$catalog" | python3 -c '
import re,sys
model=sys.argv[1]
models=[]
for line in sys.stdin:
    match=re.match(r"^\s*[-*]\s+(\S+)", line)
    if match: models.append(match.group(1))
raise SystemExit(0 if model in models else 1)
' "$model"; then
      echo "SEAT_CHANGE_MODEL_UNSUPPORTED: grok catalog に model=${model} が無い" >&2
      exit 1
    fi
    ;;
esac

changes=""
[ "$harness" = "$old_harness" ] || changes="harness ${old_harness} → ${harness}"
[ "$model" = "$old_model" ] || {
  [ -z "$changes" ] || changes="$changes / "
  changes="${changes}model ${old_model} → ${model}"
}
if [ "$effort" != "$old_effort" ]; then
  [ -z "$changes" ] || changes="$changes / "
  changes="${changes}effort ${old_effort:-default} → ${effort}"
fi

credential_file=$(env -u PEERTABLE_POST_TOKEN node "$credential_helper" path "$proj" "$room" "$name") || {
  echo "SEAT_CHANGE_CREDENTIAL_MISSING: ${name} のroom credentialを特定できない" >&2; exit 1
}

if [ "$harness" = "$old_harness" ]; then
  [ -n "$aiterm_session_id" ] || {
    echo "SEAT_CHANGE_AITERM_SESSION_MISSING: ${name} にAiterm managed session_idが無い" >&2; exit 1
  }
  configure_args=("$aiterm_session_id")
  [ -z "$opt_model" ] || configure_args+=(--model "$model")
  [ -z "$opt_effort" ] || configure_args+=(--effort "$effort")
  node "$script_dir/aiterm-configure.mjs" "${configure_args[@]}" >/dev/null || {
    echo "SEAT_CHANGE_AITERM_CONFIGURE_FAILED: ${name} の設定は変更していない" >&2; exit 1
  }
  identity=$(python3 -c 'import json,sys;print(json.dumps({"name":sys.argv[1],"harness":sys.argv[2],"vendor":sys.argv[2],"model":sys.argv[3],"effort":sys.argv[4],"aiterm_session_id":sys.argv[5]}))' "$name" "$harness" "$model" "$effort" "$aiterm_session_id")
  env -u PEERTABLE_POST_TOKEN node "$credential_helper" request "$credential_file" POST \
    "$url/api/$room/members" "$identity" >/dev/null || {
    echo "SEAT_CHANGE_CHANGED_BUT_METADATA_FAILED: ${name} は設定済み、room metadataを同期できない" >&2; exit 1
  }
  change_method="同一sessionを維持"
else
  leave="$script_dir/leave-seat.sh"
  if ! "$leave" "$proj" "$name"; then
    echo "SEAT_CHANGE_RESTART_PREPARE_FAILED: ${name} の旧席を安全に撤去できないため再起動しない" >&2
    exit 1
  fi
  launch="$script_dir/launch-seat.sh"
  [ -n "$old_role" ] || {
    echo "SEAT_CHANGE_ROLE_MISSING: ${name} の role が無い（02_models の役割名が要る）" >&2
    exit 1
  }
  brief="席設定が変更され（${changes}）、席を再起動しました。.team/roles/member.mdと工程正本・roomログから再着任し、進行中taskを続けてください。"
  if ! "$launch" "$proj" "$name" --roles "$old_role" --model "$model" --effort "$effort" "$brief"; then
    echo "SEAT_CHANGE_RESTART_FAILED: ${changes}。旧設定（harness=${old_harness} / model=${old_model} / effort=${old_effort:-default}）へrollbackする" >&2
    rollback_brief="席設定の変更に失敗して旧設定へrollbackしました。.team/roles/member.mdと工程正本・roomログから再着任してください。"
    if "$launch" "$proj" "$name" --roles "$old_role" --model "$old_model" --effort "$old_effort" "$rollback_brief"; then
      echo "SEAT_CHANGE_ROLLED_BACK: ${name} は harness=${old_harness} / model=${old_model} / effort=${old_effort:-default} で再着席" >&2
    else
      echo "SEAT_CHANGE_ROLLBACK_FAILED: ${name} の席を手動で復旧する必要がある" >&2
    fi
    exit 1
  fi
  change_method="席を再起動"
fi

members_after=$(curl -sf "$url/api/$room/members") || {
  echo "SEAT_CHANGE_CHANGED_BUT_UNVERIFIED: 席は再起動済み、membersを読めない" >&2; exit 1;
}
if ! printf '%s' "$members_after" | python3 -c '
import json,sys
name,harness,model,effort=sys.argv[1:5]
m=next((m for m in json.load(sys.stdin).get("members",[]) if m.get("name")==name),{})
raise SystemExit(0 if (m.get("harness") or m.get("vendor"))==harness and m.get("model")==model and m.get("effort")==effort else 1)
' "$name" "$harness" "$model" "$effort"; then
  echo "SEAT_CHANGE_CHANGED_BUT_UNVERIFIED: 席は再起動済み、member metadataが harness=${harness} / model=${model} / effort=${effort} でない" >&2
  exit 1
fi

body="[席設定変更] ${parent} が ${name} の ${changes} に変更（${change_method}）"
[ -z "$reason" ] || body="${body}。理由: ${reason}"
history=$(node "$(dirname "$0")/post-message.mjs" "$parent" "$name" "$body")
history_response=$(env -u PEERTABLE_POST_TOKEN node "$credential_helper" request "$credential_file" POST \
  "$url/api/$room/messages" "$history") || {
  echo "SEAT_CHANGE_CHANGED_BUT_HISTORY_FAILED: ${name} は ${changes} で再着席済み、room履歴の記録に失敗" >&2
  exit 1
}
history_seq=$(printf '%s' "$history_response" | python3 -c '
import json,sys
try:
    seq=json.load(sys.stdin).get("seq")
except (ValueError, TypeError):
    raise SystemExit(1)
print(seq)
raise SystemExit(0 if isinstance(seq, int) else 1)
') || {
  echo "SEAT_CHANGE_CHANGED_BUT_HISTORY_FAILED: ${name} は ${changes} で再着席済み、room履歴POST応答のseqを読めない" >&2
  exit 1
}

messages_after=$(env -u PEERTABLE_POST_TOKEN node "$credential_helper" request "$credential_file" GET \
  "$url/api/$room/messages") || {
  echo "SEAT_CHANGE_CHANGED_BUT_HISTORY_FAILED: ${name} は ${changes} で再着席済み、room履歴を読み返せない" >&2
  exit 1
}
if ! printf '%s' "$messages_after" | python3 -c '
import json,sys
seq,parent,name,body=sys.argv[1:5]
try:
    messages=json.load(sys.stdin).get("messages",[])
except (ValueError, TypeError):
    raise SystemExit(1)
matched=next((m for m in messages if str(m.get("seq")) == seq), None)
raise SystemExit(0 if matched and matched.get("from") == parent and matched.get("to") == name and matched.get("body") == body else 1)
' "$history_seq" "$parent" "$name" "$body"; then
  echo "SEAT_CHANGE_CHANGED_BUT_HISTORY_FAILED: ${name} は ${changes} で再着席済み、room履歴の読返しがtargetと一致しない" >&2
  exit 1
fi

echo "SEAT_CHANGE_OK: ${name} ${changes}（parent=${parent}）"
