#!/bin/bash
# 目覚まし係へ待機解放条件を登録する（席が待機に入る前に使う）。
# usage: alarm-set.sh <project_dir> <seat> <note> --lattice-task-ready <task_id> [--plan <plan_key>]
#        alarm-set.sh <project_dir> <seat> <note> <script...>  # 外部条件の後方互換
#   script は bash -c で実行され、exit 0 で条件成立とみなされる。
#   **script はシングルクォートで渡すこと**。ダブルクォートだと `$()` や変数が登録側の
#   shell で先に展開され、判定コマンドでなく展開結果が登録される（かえで実測 2026-08-22）。
#   成立すると席へ「[待機解放条件成立] <note>」が配達され、登録は自動で消える。
set -eu
proj="${1:?project_dir}"; seat="${2:?seat}"; note="${3:?note}"; shift 3
condition_kind=script
task_id=""; plan_key=""; script=""
if [ "${1:-}" = "--lattice-task-ready" ]; then
  condition_kind=lattice_task_ready
  task_id="${2:-}"; shift 2
  [ -n "$task_id" ] || { echo "ALARM_SET_TASK_REQUIRED: task_id が空" >&2; exit 2; }
  if [ "${1:-}" = "--plan" ]; then plan_key="${2:-}"; shift 2; fi
  [ "$#" -eq 0 ] || { echo "ALARM_SET_ARGS_INVALID: 余分な引数 $*" >&2; exit 2; }
else
  script="$*"
  [ -n "$script" ] || { echo "ALARM_SET_SCRIPT_REQUIRED: 条件スクリプトが空" >&2; exit 2; }
fi
# 誤った project path を mkdir -p が幻のツリーとして実体化し、誰も読まない場所へ exit 0 で
# 登録が「成功」する（実被弾 2026-08-28: worktree cwd からの相対 'poly' が poly/poly/.team/ を
# 生み、席は登録済みと思って15時間停滞）。目覚まし係が読むのは既存卓の .team だけなので、
# .team が既に在る場所しか受け付けず、path は絶対に解決して返す。
proj="$(cd -- "$proj" 2>/dev/null && pwd)" || { echo "ALARM_SET_PROJECT_INVALID: project_dir が存在しない" >&2; exit 2; }
[ -d "$proj/.team" ] || { echo "ALARM_SET_PROJECT_INVALID: ${proj}/.team が無い（卓の project root を渡すこと）" >&2; exit 2; }
dir="$proj/.team/alarms"
mkdir -p "$dir"
id="$(date +%s)-$$"
script_dir=$(cd "$(dirname "$0")" && pwd -P)
if [ "$condition_kind" = lattice_task_ready ]; then
  printf '%s\0%s\0%s\0%s\0%s' "$condition_kind" "$seat" "$note" "$task_id" "$plan_key" \
    | node "$script_dir/alarm-write.mjs" "$dir/$id.json"
else
  printf '%s\0%s\0%s\0%s' "$condition_kind" "$seat" "$note" "$script" \
    | node "$script_dir/alarm-write.mjs" "$dir/$id.json"
fi
echo "ALARM_SET_OK: ${dir}/${id}.json（seat=${seat} note=${note}）"
