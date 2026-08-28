#!/bin/bash
# 目覚まし係へ待機解放条件を登録する（席が待機に入る前に使う）。
# usage: alarm-set.sh <project_dir> <seat> <note> <script...>
#   script は bash -c で実行され、exit 0 で条件成立とみなされる。
#   **script はシングルクォートで渡すこと**。ダブルクォートだと `$()` や変数が登録側の
#   shell で先に展開され、判定コマンドでなく展開結果が登録される（かえで実測 2026-08-22）。
#   成立すると席へ「[待機解放条件成立] <note>」が配達され、登録は自動で消える。
set -eu
proj="${1:?project_dir}"; seat="${2:?seat}"; note="${3:?note}"; shift 3
script="$*"
[ -n "$script" ] || { echo "ALARM_SET_SCRIPT_REQUIRED: 条件スクリプトが空" >&2; exit 2; }
# 誤った project path を mkdir -p が幻のツリーとして実体化し、誰も読まない場所へ exit 0 で
# 登録が「成功」する（実被弾 2026-08-28: worktree cwd からの相対 'poly' が poly/poly/.team/ を
# 生み、席は登録済みと思って15時間停滞）。目覚まし係が読むのは既存卓の .team だけなので、
# .team が既に在る場所しか受け付けず、path は絶対に解決して返す。
proj="$(cd -- "$proj" 2>/dev/null && pwd)" || { echo "ALARM_SET_PROJECT_INVALID: project_dir が存在しない" >&2; exit 2; }
[ -d "$proj/.team" ] || { echo "ALARM_SET_PROJECT_INVALID: ${proj}/.team が無い（卓の project root を渡すこと）" >&2; exit 2; }
dir="$proj/.team/alarms"
mkdir -p "$dir"
id="$(date +%s)-$$"
python3 - "$dir/$id.json" "$seat" "$note" "$script" <<'PY'
import json, sys
out, seat, note, script = sys.argv[1:5]
with open(out, 'w') as f:
    json.dump({'seat': seat, 'note': note, 'script': script, 'interval_s': 10,
               'created_at': __import__('datetime').datetime.utcnow().isoformat() + 'Z'}, f, ensure_ascii=False)
PY
echo "ALARM_SET_OK: ${dir}/${id}.json（seat=${seat} note=${note}）"
