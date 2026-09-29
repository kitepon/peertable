#!/bin/bash
# usage: .team/scripts/done.sh <task_id> [--plan <plan_key>] [--evidence-from <隔離worktreeの証跡の絶対path>]
#        .team/scripts/done.sh --landing-run <run_ref>
# evidence/<plan_key>/<task_id>.md（commit 済みであること）から記述子を作り、同じ本文を
# Latticeのtest_resultへ渡して lattice todo done を実行する。
# plan key は --plan を優先し、省略時だけ環境変数 PEERTABLE_PLAN から取る。
# 証跡を plan key で仕切るのは、task_id が campaign を跨いで再利用される（t1, t2, …）ため。
# 平置きだと次の campaign の t1 が前の campaign の t1 の監査証跡を上書きで消す（2026-08-08 実測）。
#
# **`--evidence-from` は pull 型の実行層で使う。** 席は隔離 worktree の中だけを触るので、
# 証跡もそこにしか無い。一方 `todo done` は **canonical の store** へ打たないと、run の accept が
# その done を見ない。cwd 1つで両方を兼ねると必ずどちらかが外れる（mio の監査で実測・room [1012]）:
#   canonical で打つ → worktree にしか無い証跡を読めない
#   worktree で打つ → worktree 側の `.lattice/todo` を書き、canonical の accept が見ない
# なので **証跡の blob/digest は worktree の file から、`todo done` は canonical の cwd/store へ**、と
# 明示的に分ける。**canonical へ証跡を別書きして通すのは禁止**——「worktree の中だけ」の契約を
# 破りながら green にする偽装になる。
#
# 成立する理由: linked worktree は canonical と object DB を共有するので、canonical の cwd から
# `git hash-object -w <worktree の絶対path>` で書いた blob はそのまま canonical で読める。
# evidence verifier は descriptor.path の working tree 実在を見ず、object DB の blob と digest、
# 読み出し時の `rev-list --all` 到達性を見る（mio が実 repo で確認・room [1016]）。
set -e
# LatticeのJSONをcommand substitutionで受けるため、親shellの色指定を持ち込まない。
unset FORCE_COLOR
export NO_COLOR=1

show_usage() {
  cat <<'USAGE'
usage: done.sh <task_id> [--plan <plan_key>] [--evidence-from <隔離worktreeの証跡の絶対path>]
       done.sh --landing-run <run_ref>

完了処理:
  --plan <plan_key> を指定する。省略時だけ PEERTABLE_PLAN を使う。
  evidence/<plan>/<task>.md を commit 済みにして done.sh <task_id> を実行する。
  wrapper が証跡から記述子を生成し、lattice todo doneで同じ本文を最終試験結果として canonical store へ記録する。
  pull run の worktree で作業した場合だけ --evidence-from に同じrepoの絶対pathを渡す。
  この script は監査担当が打つ。feat SHA が origin/main の祖先でなければ、
  この script が canonical main へ merge して push する。親は着地しない。
  accept は intake 席が todo done の後に打つ（engine 正順）。
  未accept と lattice run receipt の未着地は警告だけで、done を止めない。
USAGE
}

if [ "$#" = 0 ]; then
  show_usage >&2
  exit 2
fi
case "${1:-}" in
  --help|-h)
    [ "$#" = 1 ] || { echo "ERROR: helpには他の引数を付けないこと" >&2; exit 2; }
    show_usage
    exit 0
    ;;
esac

# `todo done` と run receipt の accept は別の正本を持つ。landing-only mode は accept の直後に
# 同じ run ref を受け取り、受理済み receipt の着地だけを表示する。accept 自体はここへ吸収しない。
if [ "${1:-}" = "--landing-run" ]; then
  [ "$#" = 2 ] || {
    echo "ERROR: --landing-run には run ref を1つ渡すこと（usage: done.sh --landing-run <run_ref>）" >&2
    exit 1
  }
  run_ref="$2"
  [ -n "$run_ref" ] || { echo "ERROR: --landing-run には run ref を渡すこと" >&2; exit 1; }
  lattice_cli="${LATTICE_CLI:-$(command -v lattice 2>/dev/null || true)}"
  if [ -z "$lattice_cli" ] || [ ! -x "$lattice_cli" ]; then
    echo "着地状態を読めない: LATTICE_CLIが実行可能fileを指さない（${lattice_cli:-未設定}）" >&2
    exit 1
  fi
  landing_report=""
  landing_rc=0
  landing_report=$("$lattice_cli" run landing --run "$run_ref" 2>&1) || landing_rc=$?
  if [ "$landing_rc" != 0 ]; then
    echo "着地状態を読めない: run landing が rc=${landing_rc} で失敗: ${landing_report}" >&2
    exit 1
  fi
  unlanded_count=""
  if ! unlanded_count=$(printf '%s' "$landing_report" | python3 -c '
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
if not isinstance(report.get("landed"), bool):
    sys.exit("run landing の landed が真偽値でない")
receipts = report.get("accepted_receipts")
if not isinstance(receipts, list):
    sys.exit("run landing に accepted_receipts 配列が無い")
for index, receipt in enumerate(receipts):
    if not isinstance(receipt, dict) or not isinstance(receipt.get("landed"), bool):
        sys.exit(f"accepted_receipts[{index}] の landed が真偽値でない")
print(sum(1 for receipt in receipts if not receipt["landed"]))
' 2>&1); then
    echo "着地状態を読めない: ${unlanded_count}" >&2
    exit 1
  fi
  if [ "$unlanded_count" != 0 ]; then
    echo "未着地 ${unlanded_count}本: run ${run_ref} の受理済み成果が canonical default branch へ着地していない" >&2
  fi
  # **「受理済みだが未着地」と「そもそも受理されていない」は別の完了軸である。**
  # landing report は accepted receipt しか持たないので、accept 前で止まっている intake は
  # ここでは 0 本＝無言になる（2026-08-11 実測）。observe を併せて読み、別の軸として出す。
  pending_report=""
  pending_rc=0
  pending_report=$("$lattice_cli" run observe --run "$run_ref" 2>&1) || pending_rc=$?
  if [ "$pending_rc" != 0 ]; then
    echo "未accept本数を読めない: run observe が rc=${pending_rc} で失敗: ${pending_report}" >&2
    exit 1
  fi
  pending_count=""
  if ! pending_count=$(printf '%s' "$pending_report" | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    report = json.loads(raw)
except Exception as error:
    sys.exit(f"run observe がJSONでない: {error}")
if not isinstance(report, dict):
    sys.exit(f"run observe がobjectでない: {type(report).__name__}")
if report.get("schema") != "lattice.pull_run_observation.v1":
    sys.exit(f"run observe の schema が違う: {report.get('schema')}")
intakes = report.get("intakes")
if not isinstance(intakes, list):
    sys.exit("run observe に intakes 配列が無い")
pending = []
seen = set()
for index, intake in enumerate(intakes):
    if not isinstance(intake, dict):
        sys.exit(f"intakes[{index}] がobjectでない")
    task_id = intake.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        sys.exit(f"intakes[{index}] の task_id が空または文字列でない")
    if task_id in seen:
        sys.exit(f"intakes[{index}] の task_id が重複している: {task_id}")
    seen.add(task_id)
    if "accepted_head_sha" not in intake:
        sys.exit(f"intakes[{index}] に accepted_head_sha が無い")
    accepted_head_sha = intake.get("accepted_head_sha")
    if accepted_head_sha is not None and not isinstance(accepted_head_sha, str):
        sys.exit(f"intakes[{index}] の accepted_head_sha が文字列またはnullでない")
    if not accepted_head_sha:
        pending.append(task_id)
print(",".join(sorted(pending)))
' 2>&1); then
    echo "未accept本数を読めない: ${pending_count}" >&2
    exit 1
  fi
  if [ -n "$pending_count" ]; then
    echo "未accept: run ${run_ref} に受理されていない intake が在る（${pending_count}）。着地以前に受理が済んでいない" >&2
  fi
  exit 0
fi
t="$1"
[ -n "$t" ] || { echo "ERROR: task_id が空" >&2; exit 1; }
shift
plan="${PEERTABLE_PLAN:-}"
evidence_from=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --plan)
      [ "$#" -ge 2 ] && [ -z "${plan_explicit:-}" ] || { echo "ERROR: --plan は一度だけ値付きで指定すること" >&2; exit 1; }
      plan="$2"
      plan_explicit=yes
      shift 2
      ;;
    --evidence-from)
      [ "$#" -ge 2 ] && [ -z "$evidence_from" ] || { echo "ERROR: --evidence-from は一度だけ値付きで指定すること" >&2; exit 1; }
      evidence_from="$2"
      shift 2
      ;;
    *) echo "ERROR: 未知のoption: $1（使えるのは --plan と --evidence-from だけ）" >&2; exit 1 ;;
  esac
done
[ -n "$plan" ] || { echo "ERROR: 完了処理を続けられない: --plan または PEERTABLE_PLAN が必要" >&2; exit 1; }
if [ -n "$evidence_from" ]; then
  if ! python3 -c 'import os,sys; sys.exit(0 if os.path.isabs(sys.argv[1]) else 1)' "$evidence_from"; then
    echo "ERROR: --evidence-from は絶対pathでなければならない: $evidence_from" >&2; exit 1
  fi
  # **黙って canonical の証跡へ落ちない。** 落ちると「worktree の成果を done した」と見えるのに
  # 実際は別の file を hash することになり、受理された内容と成果物が食い違う
  [ -f "$evidence_from" ] || { echo "ERROR: --evidence-from の証跡が存在しない: $evidence_from" >&2; exit 1; }
  # **object DB を共有していない木の file は hash-object できても意味が無い。** 別 repo の
  # 証跡を渡された時に「書けたから成立した」と読まないよう、common git dir の一致を要求する
  # （kanade の設計指摘・room [1018]）。linked worktree なら両者は同じ絶対 path を指す。
  here_common=$(git rev-parse --path-format=absolute --git-common-dir)
  from_common=$(git -C "$(dirname "$evidence_from")" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  [ -n "$from_common" ] && [ "$here_common" = "$from_common" ] || {
    echo "ERROR: --evidence-from が同じrepoのworktreeでない（object DBを共有していない）" >&2
    echo "  canonical: ${here_common}" >&2
    echo "  evidence : ${from_common:-（git worktree ではない）}" >&2
    exit 1
  }
fi

f="evidence/$plan/$t.md"
src="${evidence_from:-$f}"
[ -f "$src" ] || { echo "ERROR: 証跡が見つからない: $src" >&2; exit 1; }

done_gate_cli="${LATTICE_CLI:-lattice}"
# 再試行では既にdoneのToDoへtodo doneを重ねない。
task_state_json=""
task_state_json=$("$done_gate_cli" todo show --plan "$plan" --task "$t" --json 2>&1) || {
  echo "ERROR: 完了処理を続けられない: todo show が失敗: $task_state_json" >&2
  exit 1
}
task_field() {
  local field="$1"
  printf '%s' "$task_state_json" | python3 -c '
import json
import sys

report = json.load(sys.stdin)
state = report.get("state")
task = report.get("task")
if not isinstance(state, dict) or not isinstance(task, dict):
    raise SystemExit("todo show の state/task が不正")
field = sys.argv[1]
if field != "status":
    raise SystemExit(f"未知のtask field: {field}")
value = state.get("status")
if not isinstance(value, str):
    raise SystemExit(f"task fieldが文字列でない: {field}")
print(value)
' "$field"
}
task_status=""
task_status=$(task_field status 2>&1) || {
  echo "ERROR: 完了処理を続けられない: ToDo状態を読めない: $task_status" >&2
  exit 1
}
already_done=no
case "$task_status" in
  done) already_done=yes ;;
  in-progress) ;;
  *) echo "ERROR: 完了処理を続けられない: ToDoが完了可能状態でない: $task_status" >&2; exit 1 ;;
esac

# feat SHA が origin/main の祖先になるまで todo done を打たない。
# 未着地ならこの script が canonical main へ載せて push する。親は呼ばない。
# --evidence-from があるときは隔離 worktree の HEAD を feat とする。
feat_dir="."
if [ -n "$evidence_from" ]; then
  feat_dir=$(dirname "$evidence_from")
fi
feat_sha=$(git -C "$feat_dir" rev-parse HEAD) || {
  echo "ERROR: LANDING_HEAD_UNRESOLVED: feat HEAD を読めない" >&2
  exit 1
}
if ! git fetch -q origin; then
  echo "ERROR: LANDING_FETCH_FAILED: origin を fetch できない。done は打たない" >&2
  exit 1
fi
if ! git rev-parse --verify --quiet origin/main >/dev/null; then
  echo "ERROR: LANDING_ORIGIN_MISSING: origin/main が無い。done は打たない" >&2
  exit 1
fi
current_branch=$(git rev-parse --abbrev-ref HEAD) || {
  echo "ERROR: LANDING_HEAD_UNRESOLVED: canonical の branch を読めない" >&2
  exit 1
}
if [ "$current_branch" != main ]; then
  echo "ERROR: LANDING_NOT_ON_MAIN_BRANCH: canonical HEAD が main ではない（${current_branch}）。done は打たない" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$feat_sha" origin/main; then
  if [ "$(git rev-parse HEAD)" != "$feat_sha" ]; then
    if ! git merge --no-edit -m "着地: ${t} feat=${feat_sha}" "$feat_sha"; then
      echo "ERROR: LANDING_MERGE_FAILED: ${feat_sha} を main へ merge できない。done は打たない" >&2
      exit 1
    fi
  fi
  if ! git push -q origin main; then
    echo "ERROR: LANDING_PUSH_FAILED: origin/main へ push できない。done は打たない" >&2
    exit 1
  fi
  if ! git fetch -q origin; then
    echo "ERROR: LANDING_FETCH_FAILED: 着地後の origin を fetch できない。done は打たない" >&2
    exit 1
  fi
  if ! git merge-base --is-ancestor "$feat_sha" origin/main; then
    echo "ERROR: LANDING_NOT_ON_MAIN: ${feat_sha} を origin/main へ載せられなかった。done は打たない" >&2
    exit 1
  fi
  echo "着地: ${feat_sha} を origin/main の祖先にした" >&2
fi

# **done と accept は別軸。** engine は todo done の後にだけ accept できる。
# 監査担当が done.sh で閉じ、intake 席が accept する。未 accept を done の拒否条件にすると循環する。
# 読めない状態は成功へ倒さない。未accept・run receipt 未着地は警告。
# **実行層に載っていない task は素通しする**——pull run の利用は任意で、載っていない卓を止めない。
gate_runs=$("$done_gate_cli" run list --json 2>&1) || {
  echo "ERROR: receipt の状態を読めない（run list が失敗）: $gate_runs" >&2; exit 1;
}
gate_refs=$(printf '%s' "$gate_runs" | python3 -c '
import json, sys
plan = sys.argv[1]
raw = sys.stdin.read()
try:
    report = json.loads(raw)
except Exception as error:
    sys.exit(f"run list がJSONでない: {error}")
if not isinstance(report, dict):
    sys.exit(f"run list がobjectでない: {type(report).__name__}")
if report.get("schema") != "lattice.run_list.v1":
    sys.exit(f"run list の schema が違う: {report.get('schema')}")
runs = report.get("active_runs")
if not isinstance(runs, list):
    sys.exit("run list に active_runs 配列が無い")
for index, run in enumerate(runs):
    if not isinstance(run, dict):
        sys.exit(f"active_runs[{index}] がobjectでない")
    plan_key = run.get("plan_key")
    selection = run.get("selection")
    if not isinstance(plan_key, str) or not plan_key:
        sys.exit(f"active_runs[{index}] の plan_key が空または文字列でない")
    if not isinstance(selection, str) or not selection:
        sys.exit(f"active_runs[{index}] の selection が空または文字列でない")
    if plan_key == plan:
        if selection != "pull":
            sys.exit(f"active_runs[{index}] の対象planの selection がpullでない: {selection}")
        run_ref = run.get("run_ref")
        if not isinstance(run_ref, str) or not run_ref:
            sys.exit(f"active_runs[{index}] の run_ref が空または文字列でない")
        print(run_ref)
' "$plan") || {
  echo "ERROR: receipt の状態を読めない: $gate_refs" >&2; exit 1;
}
for gate_ref in $gate_refs; do
  gate_obs=$("$done_gate_cli" run observe --run "$gate_ref" 2>&1) || {
    echo "ERROR: receipt の状態を読めない（run observe が失敗）: $gate_ref: $gate_obs" >&2; exit 1;
  }
  gate_state=$(printf '%s' "$gate_obs" | python3 -c '
import json, sys
task = sys.argv[1]
raw = sys.stdin.read()
try:
    report = json.loads(raw)
except Exception as error:
    sys.exit(f"run observe がJSONでない: {error}")
if not isinstance(report, dict):
    sys.exit(f"run observe がobjectでない: {type(report).__name__}")
if report.get("schema") != "lattice.pull_run_observation.v1":
    sys.exit(f"run observe の schema が違う: {report.get('schema')}")
intakes = report.get("intakes")
if not isinstance(intakes, list):
    sys.exit("run observe に intakes 配列が無い")
entry = None
seen = set()
for index, intake in enumerate(intakes):
    if not isinstance(intake, dict):
        sys.exit(f"intakes[{index}] がobjectでない")
    task_id = intake.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        sys.exit(f"intakes[{index}] の task_id が空または文字列でない")
    if task_id in seen:
        sys.exit(f"intakes[{index}] の task_id が重複している: {task_id}")
    seen.add(task_id)
    if "accepted_head_sha" not in intake:
        sys.exit(f"intakes[{index}] に accepted_head_sha が無い")
    accepted_head_sha = intake.get("accepted_head_sha")
    if accepted_head_sha is not None and not isinstance(accepted_head_sha, str):
        sys.exit(f"intakes[{index}] の accepted_head_sha が文字列またはnullでない")
    if task_id == task:
        entry = intake
print("absent" if entry is None else ("accepted" if entry.get("accepted_head_sha") else "pending"))
' "$t") || { echo "ERROR: receipt の状態を読めない: $gate_state" >&2; exit 1; }
done

# descriptor の path は repo 内の相対（repo 外の絶対 path は --evidence が INVALID_ARGUMENTS で弾く）。
# worktree でも canonical でも同じ相対 path に置く規約なので、この値は両者で一致する。
if [ "$already_done" = no ]; then
  oid=$(git hash-object -w "$src")
  digest=$(shasum -a 256 "$src" | cut -d' ' -f1)
  tmp=".ev-$t.json"
  test_result_tmp=".test-result-$plan-$t.md"
  # **失敗しても記述子を残さない。** `set -e` の下で `todo done` が落ちると、後段の `rm` へ
  # 到達せず repo に `.ev-<task>.json` が残る（自分の負側 test で実測。TASK_NOT_FOUND の後に
  # untracked file が残った）。次に `git status` を撮った人が、それを誰かの作業中変更と読む。
  trap 'rm -f "$tmp" "$test_result_tmp"' EXIT
  printf '{"evidence_id":"ev-%s","repo_id":"self","path":"%s","git_blob_oid":"%s","content_digest":"%s","media_type":"text/markdown","anchor_digest":null}\n' "$t" "$f" "$oid" "$digest" > "$tmp"
  cp "$src" "$test_result_tmp"
  # **PATH の `lattice` へ黙って逸れない。** setup が解決した CLI を席 env の `LATTICE_CLI` で受け、
  # 無い時だけ PATH を使う（bridge の `--lattice` / teardown の `LATTICE_CLI` と同じ選択規律）。
  done_output=""
  done_rc=0
  done_output=$("$done_gate_cli" todo done --plan "$plan" --task "$t" --evidence "$tmp" --test-result "$test_result_tmp" --commit-store 2>&1) || done_rc=$?
  printf '%s\n' "$done_output"
  [ "$done_rc" -eq 0 ] || exit "$done_rc"
  rm -f "$tmp" "$test_result_tmp"
else
  echo "todo done は既に記録済み: $t" >&2
fi

# todo done の直後（または再試行時の既存done）に、工程正本が本当に done か再確認する。
task_state_json=$("$done_gate_cli" todo show --plan "$plan" --task "$t" --json 2>&1) || {
  echo "ERROR: 完了処理を続けられない: done後のToDo状態を読めない: $task_state_json" >&2
  exit 1
}
task_status=$(task_field status 2>&1) || {
  echo "ERROR: 完了処理を続けられない: done後の状態を読めない: $task_status" >&2
  exit 1
}
[ "$task_status" = done ] || {
  echo "ERROR: 完了処理を続けられない: todo done後も状態がdoneでない: $task_status" >&2
  exit 1
}

# remaining の並列記録をこの場で更新する。親は compile しない。
# 次の工程の start / intake より前に終わるので、記録書き換え中の hold を作らない。
witness=".lattice/todo/witness/${plan}.json"
if [ -f "$witness" ]; then
  compile_out=""
  compile_rc=0
  compile_out=$("$done_gate_cli" todo independence compile --plan "$plan" --input "$witness" 2>&1) || compile_rc=$?
  printf '%s\n' "$compile_out"
  if [ "$compile_rc" != 0 ]; then
    echo "ERROR: INDEPENDENCE_COMPILE_FAILED: remaining の並列記録を更新できない。次の工程を始めるな" >&2
    exit 1
  fi
  independence_ref=".lattice/todo/plans/${plan}/v1/independence.json"
  git add -- "$witness"
  [ -f "$independence_ref" ] && git add -- "$independence_ref"
  if ! git diff --cached --quiet -- "$witness" "$independence_ref" 2>/dev/null; then
    compile_msg=$(mktemp "${TMPDIR:-/tmp}/peertable-independence.XXXXXX")
    printf 'Lattice independence を再 compile する plan=%s\n' "$plan" > "$compile_msg"
    if ! git commit -q -F "$compile_msg" -- "$witness" "$independence_ref"; then
      rm -f "$compile_msg"
      echo "ERROR: INDEPENDENCE_COMPILE_FAILED: 更新した並列記録を commit できない。次の工程を始めるな" >&2
      exit 1
    fi
    rm -f "$compile_msg"
  fi
fi

# feat 着地と store / independence の commit を origin へ載せる。親は push しない。
upstream_ref=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
if [ -n "$upstream_ref" ]; then
  unpushed=$(git rev-list --count "${upstream_ref}..HEAD" 2>/dev/null || true)
  if [ -n "$unpushed" ] && [ "$unpushed" != 0 ]; then
    if ! git push -q origin HEAD; then
      echo "ERROR: LANDING_PUSH_FAILED: 未push ${unpushed}本を origin へ載せられない" >&2
      exit 1
    fi
  fi
fi

# pull run に載った task は、accept / 着地を警告として出す。done 自体は止めない。
for gate_ref in $gate_refs; do
  gate_obs=""
  gate_obs=$("$done_gate_cli" run observe --run "$gate_ref" 2>&1) || {
    echo "ERROR: 完了処理を続けられない: run observe が失敗: $gate_ref: $gate_obs" >&2
    exit 1
  }
  gate_state=$(printf '%s' "$gate_obs" | python3 -c '
import json, sys
task = sys.argv[1]
report = json.load(sys.stdin)
if report.get("schema") != "lattice.pull_run_observation.v1":
    raise SystemExit("run observe の schema が違う")
intakes = report.get("intakes")
if not isinstance(intakes, list):
    raise SystemExit("run observe に intakes 配列が無い")
seen = set()
found = None
for intake in intakes:
    if not isinstance(intake, dict) or not isinstance(intake.get("task_id"), str):
        raise SystemExit("run observe の intake が不正")
    task_id = intake["task_id"]
    if task_id in seen:
        raise SystemExit(f"run observe の intake が重複: {task_id}")
    seen.add(task_id)
    if "accepted_head_sha" not in intake:
        raise SystemExit(f"run observe に accepted_head_sha が無い: {task_id}")
    if task_id == task:
        found = intake
if found is None:
    print("absent")
elif found.get("accepted_head_sha"):
    print("accepted")
else:
    print("pending")
' "$t" 2>&1) || {
    echo "ERROR: 完了処理を続けられない: run observeのtask状態を読めない: $gate_ref: $gate_state" >&2
    exit 1
  }
  [ "$gate_state" = absent ] && continue
  if [ "$gate_state" != accepted ]; then
    echo "未accept: ${t} @ ${gate_ref}（intake 席が accept する。done は記録済み）" >&2
    continue
  fi
  landing_report=""
  landing_report=$("$done_gate_cli" run landing --run "$gate_ref" 2>&1) || {
    echo "着地状態を読めない: run landing が失敗: $gate_ref: $landing_report" >&2
    continue
  }
  landing_task=$(printf '%s' "$landing_report" | python3 -c '
import json, sys
task = sys.argv[1]
report = json.load(sys.stdin)
if report.get("schema") != "lattice.run_landing_report.v1":
    raise SystemExit("run landing の schema が違う")
if not isinstance(report.get("landed"), bool):
    raise SystemExit("run landing の landed が真偽値でない")
receipts = report.get("accepted_receipts")
if not isinstance(receipts, list):
    raise SystemExit("run landing に accepted_receipts 配列が無い")
found = None
for receipt in receipts:
    if not isinstance(receipt, dict):
        raise SystemExit("accepted receipt がobjectでない")
    if receipt.get("task_id") == task:
        if found is not None:
            raise SystemExit(f"accepted receipt が重複: {task}")
        found = receipt
if found is None:
    print("missing")
elif not isinstance(found.get("landed"), bool):
    raise SystemExit("task receipt の landed が真偽値でない")
else:
    print("landed" if found["landed"] else "unlanded")
' "$t" 2>&1) || {
    echo "ERROR: 完了処理を続けられない: task landing状態を読めない: $gate_ref: $landing_task" >&2
    exit 1
  }
  [ "$landing_task" = landed ] || {
    echo "未着地: ${t} @ ${gate_ref}（task receipt が canonical へ未着地）" >&2
  }
done

# 外部ペインの喪失検出。Lattice 併用モードの卓は、公開工程表の右ペインに円卓が出ているのが正常。
# 2026-08-08、受入検証が本番のコネクタを「外して痕跡ゼロ」まで確かめて終わり、差し直しが人の記憶
# 頼みで漏れて、公開工程表から円卓が消えたままになった（オーナー発見）。**外したことは誰も間違えて
# いない——戻し忘れを誰も見ていなかった**ので、全員が必ず通る done の一点で見る。
# 未push 警告と同じ作法: 出すだけで止めない・読めない時は黙って継続する（この警告のために done.sh を殺さない）。
pane_missing=$(python3 - <<'PY' 2>/dev/null || true
import json
try:
    state = json.load(open('.team/setup-state.json'))
except Exception:
    raise SystemExit          # 卓が無い/読めない＝判定しない
if state.get('mode') != 'lattice':
    raise SystemExit          # 単独円卓モードには工程表が無い
try:
    identity = json.load(open('.lattice/project.json'))
except Exception:
    identity = {}
if not identity.get('external_pane'):
    print('yes')
PY
)
if [ "$pane_missing" = yes ]; then
  echo "外部ペインが未設置か読めない: 公開工程表に円卓が出ていない（差し直す: node <skill>/scripts/external-pane.mjs . <room> <public_base>）" >&2
fi

# クローズ掲示は done の機械的な後段である。席の記憶に頼らせると掲示が抜ける（2026-09-04 実測:
# 監査担当が todo done を打った後 [クローズ] を room へ出さず、作業者が 2 分半後に代わりに掲示した）。
# 「done したら掲示する」に判断は要らないので、done.sh が自分で room へ投げる（オーナー裁定 2026-09-04）。
# 掲示に失敗した時は done が記録済みである事実を明示し、手で投稿すべき本文をそのまま出して非ゼロで終わる。
close_notice="[クローズ] ${t}。次の工程に着手可"
close_poster="$(npm root -g 2>/dev/null)/peertable/skill/scripts/post-message.mjs"
if [ ! -f "$close_poster" ]; then
  echo "ERROR: CLOSE_NOTICE_FAILED: post-message.mjs が見つからない（${close_poster}）。done は記録済み。手で room へ投稿すること: ${close_notice}" >&2
  exit 1
fi
if [ -z "${PEERTABLE_MEMBER:-}" ]; then
  echo "ERROR: CLOSE_NOTICE_FAILED: PEERTABLE_MEMBER が無く差出人を決められない。done は記録済み。手で room へ投稿すること: ${close_notice}" >&2
  exit 1
fi
if ! node "$close_poster" "$PEERTABLE_MEMBER" all "$close_notice"; then
  echo "ERROR: CLOSE_NOTICE_FAILED: room への掲示に失敗。done は記録済み。手で room へ投稿すること: ${close_notice}" >&2
  exit 1
fi
