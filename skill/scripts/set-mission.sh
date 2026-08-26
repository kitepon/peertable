#!/bin/bash
# 席の mission を更新する。再起動しない。
# usage: set-mission.sh <project_dir> <member> <text>
#
# chip（POST /members の mission 欄）と、他席へ届く `[mission] <name>: <text>` の1行が正本。
# 起動時の PEERTABLE_MISSION env は書き換えない。change-seat.sh には載せない。
set -eu

unset PEERTABLE_POST_TOKEN
script_dir=$(cd "$(dirname "$0")" && pwd -P)
credential_helper="${PEERTABLE_CREDENTIAL_HELPER:-$script_dir/seat-credential.mjs}"

proj="${1:-}"; name="${2:-}"
shift 2 2>/dev/null || true
text="${*:-}"
[ -n "$proj" ] && [ -n "$name" ] && [ -n "$text" ] || {
  echo "SET_MISSION_ARGS_INVALID: usage: set-mission.sh <project_dir> <member> <text>" >&2
  exit 2
}
case "$name" in
  *[!A-Za-z0-9._-]*) echo "SET_MISSION_ARGS_INVALID: member名に使えない文字がある" >&2; exit 2 ;;
esac

state="$proj/.team/setup-state.json"
[ -f "$state" ] || { echo "SET_MISSION_STATE_MISSING: $state" >&2; exit 1; }
read -r room url <<EOF
$(node -e 'const fs=require("fs"); const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!d.room||!d.server_url) process.exit(1); process.stdout.write(d.room+" "+d.server_url+"\n")' "$state")
EOF

members=$(curl -sf "$url/api/$room/members") || {
  echo "SET_MISSION_ROOM_UNREACHABLE: membersを読めない" >&2; exit 1
}
printf '%s' "$members" | node -e '
const fs=require("fs");
const name=process.argv[1];
let members;
try { members=JSON.parse(fs.readFileSync(0,"utf8")).members||[] } catch { process.exit(2) }
process.exit(members.some(m => m && m.name===name) ? 0 : 1)
' "$name" || {
  echo "SET_MISSION_MEMBER_MISSING: ${name} が room に居ない" >&2
  exit 1
}

credential_file=$(env -u PEERTABLE_POST_TOKEN node "$credential_helper" path "$proj" "$room" "$name") || {
  echo "SET_MISSION_CREDENTIAL_MISSING: ${name} のroom credentialを特定できない" >&2; exit 1
}

payload=$(node -e 'process.stdout.write(JSON.stringify({name:process.argv[1],mission:process.argv[2]})+"\n")' "$name" "$text")
env -u PEERTABLE_POST_TOKEN node "$credential_helper" request "$credential_file" POST \
  "$url/api/$room/members" "$payload" >/dev/null || {
  echo "SET_MISSION_METADATA_FAILED: ${name} の mission を room へ書けない" >&2; exit 1
}

members_after=$(curl -sf "$url/api/$room/members") || {
  echo "SET_MISSION_CHANGED_BUT_UNVERIFIED: mission を書いたが members を読めない" >&2; exit 1
}
printf '%s' "$members_after" | node -e '
const fs=require("fs");
const name=process.argv[1];
const want=process.argv[2];
let members;
try { members=JSON.parse(fs.readFileSync(0,"utf8")).members||[] } catch { process.exit(2) }
const m=members.find(x => x && x.name===name) || {};
process.exit(m.mission===want ? 0 : 1)
' "$name" "$text" || {
  echo "SET_MISSION_CHANGED_BUT_UNVERIFIED: members の mission が指定文と一致しない" >&2
  exit 1
}

body="[mission] ${name}: ${text}"
history=$(node "$script_dir/post-message.mjs" --build-only "$name" "all" "$body")
history_response=$(env -u PEERTABLE_POST_TOKEN node "$credential_helper" request "$credential_file" POST \
  "$url/api/$room/messages" "$history") || {
  echo "SET_MISSION_CHANGED_BUT_ANNOUNCE_FAILED: chip は更新済み、[mission] の投稿に失敗" >&2
  exit 1
}
history_seq=$(printf '%s' "$history_response" | node -e '
const fs=require("fs");
let seq;
try { seq=JSON.parse(fs.readFileSync(0,"utf8")).seq } catch { process.exit(1) }
if(!Number.isInteger(seq)) process.exit(1);
process.stdout.write(String(seq)+"\n");
') || {
  echo "SET_MISSION_CHANGED_BUT_ANNOUNCE_FAILED: chip は更新済み、[mission] POST 応答の seq を読めない" >&2
  exit 1
}

messages_after=$(env -u PEERTABLE_POST_TOKEN node "$credential_helper" request "$credential_file" GET \
  "$url/api/$room/messages") || {
  echo "SET_MISSION_CHANGED_BUT_ANNOUNCE_FAILED: chip は更新済み、room 履歴を読み返せない" >&2
  exit 1
}
printf '%s' "$messages_after" | node -e '
const fs=require("fs");
const seq=process.argv[1];
const name=process.argv[2];
const body=process.argv[3];
let messages;
try { messages=JSON.parse(fs.readFileSync(0,"utf8")).messages||[] } catch { process.exit(1) }
const matched=messages.find(m => String(m.seq)===seq);
process.exit(matched && matched.from===name && matched.to==="all" && matched.body===body ? 0 : 1)
' "$history_seq" "$name" "$body" || {
  echo "SET_MISSION_CHANGED_BUT_ANNOUNCE_FAILED: chip は更新済み、[mission] の読返しが一致しない" >&2
  exit 1
}

echo "SET_MISSION_OK: ${name} mission=${text}"
