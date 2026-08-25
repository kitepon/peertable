#!/bin/bash
# Peertable setup の機械部分: .team/ scaffold と git 除外。
# usage: setup.sh <project_dir> <room> <server_url> <plan_key|-> <peertable_repo> [tasks_file] [--phase <id>]...
#   plan_key に `-` を渡すと単独円卓モード（工程正本を持たない。決定47）。
#   単独モードでは tasks_file（聞き取ったタスクを書いた本文）が必須で、議題表 .team/tasks.md になる。
#   --phase は複数指定可。指定すると卓の claim 範囲がその phase の task に限られる。
#   指定なしは plan 全体。他 campaign と同じ plan へ相乗りする時に、範囲外 phase の越境を止めるためのもの。
set -e
proj="$1"; room="$2"; url="$3"; plan="$4"; repo="$5"
[ $# -ge 5 ] && shift 5 || shift $#
# 第6引数の tasks_file は単独円卓モードだけが使う。`--` で始まるものはオプションなので
# 位置引数として食わない——食うと Lattice 併用モードの `… <repo> --phase p2` が
# 「未知の引数: p2」という原因を指さないエラーで落ちる（2026-08-08 実測・kotoha 監査）。
tasks=""
if [ $# -gt 0 ]; then
  case "$1" in
    -) shift ;;              # 明示的な「tasks_file 無し」
    -*) ;;                   # オプション（綴り誤りも含む）。下のループで typed に落とす
    *) tasks="$1"; shift ;;  # tasks_file
  esac
fi

phases=()
while [ $# -gt 0 ]; do
  case "$1" in
    --phase)
      shift
      [ -n "$1" ] || { echo "ERROR: --phase には phase id が要る" >&2; exit 1; }
      case "$1" in
        *[!A-Za-z0-9._-]*) echo "ERROR: phase id に使えない文字がある: $1" >&2; exit 1 ;;
      esac
      phases+=("$1")
      ;;
    *) echo "ERROR: 未知の引数: $1（受けるのは --phase <id> だけ。tasks_file は単独円卓モード専用で、オプションより前に置く）" >&2; exit 1 ;;
  esac
  shift
done
tpl="$repo/skill/templates"
tdir="$proj/.team"

if [ "$plan" = "-" ] || [ -z "$plan" ]; then
  mode=standalone; plan=""
  # 単独円卓モードに phase は無い（工程正本を持たないため）。黙って無視せず止める
  [ ${#phases[@]} -eq 0 ] || { echo "ERROR: 単独円卓モードに --phase は使えない（工程正本を持たないため）" >&2; exit 1; }
  # 引数の検証は project へ何か置く前に済ませる（不可侵原則: 半端な .team/ を残さない）
  if [ -z "$tasks" ] || [ ! -f "$tasks" ]; then
    echo "ERROR: 単独円卓モードは議題表の本文ファイル（第6引数）が必須: setup.sh ... - <peertable_repo> <tasks_file>" >&2
    exit 1
  fi
else
  mode=lattice
fi

# `.team/` は setup が所有する使い捨ての生成領域だが、既存 project の資産を
# その名前だけで所有物だと決めてはいけない。追跡済み file は project の意図した資産、
# 未追跡の残りは前卓の残骸か利用者の資産かを setup だけでは判定できない。
# どちらも write 前に typed conflict として止め、退避・削除・上書きはしない。
team_dir="$proj/.team"
team_existing=""
if [ -L "$team_dir" ] || { [ -e "$team_dir" ] && [ ! -d "$team_dir" ]; }; then
  team_existing="$team_dir"
elif [ -d "$team_dir" ]; then
  team_existing=$(find "$team_dir" -mindepth 1 -print | sort)
fi
team_tracked=""
if git -C "$proj" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  team_tracked=$(git -C "$proj" ls-files --cached -- .team)
fi
if [ -n "$team_existing" ] || [ -n "$team_tracked" ]; then
  echo "PEERTABLE_SETUP_TEAM_CONFLICT: .team/ に既存資産があるため、setup は書き込まない" >&2
  if [ -n "$team_tracked" ]; then
    echo "  tracked（project所有として扱い、上書きしない）:" >&2
    printf '    %s\n' "$team_tracked" >&2
  fi
  if [ -n "$team_existing" ]; then
    echo "  existing（前卓の残骸か利用者資産かを推測せず、触らない）:" >&2
    printf '    %s\n' "$team_existing" >&2
  fi
  exit 1
fi

# Lattice 併用モードは、公開CLIをprojectへ何か置く前に確定する。通常はglobal installされた
# lattice を使い、release前のsource treeを実測する時だけ `LATTICE_CLI` で同じtreeのbinを明示する。
# **work-order adapter binary はもう要らない**（配車を撤去したので登録しない）。ここで見るのは
# CLI の存在だけで、席が `todo status` / `run intake` を叩ける前提の確認である。
lattice_cli=""
if [ "$mode" = "lattice" ]; then
  lattice_cli="${LATTICE_CLI:-$(command -v lattice 2>/dev/null || true)}"
  [ -n "$lattice_cli" ] || { echo "ERROR: lattice CLI が見つからない" >&2; exit 1; }
  [ -x "$lattice_cli" ] || { echo "ERROR: lattice CLI が実行可能fileでない: $lattice_cli" >&2; exit 1; }
  lattice_cli=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$lattice_cli")

  # config_refはgit root相対の公開契約。subdirectoryをprojectとして受けると別の
  # `.lattice/` を作ってしまうので、黙って親repoへ登録せずtypedに止める。
  project_root=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$proj")
  git_root=$(git -C "$proj" rev-parse --show-toplevel 2>/dev/null || true)
  [ -n "$git_root" ] || { echo "ERROR: Lattice 併用モードのprojectはgit repositoryでなければならない: $proj" >&2; exit 1; }
  git_root=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$git_root")
  [ "$project_root" = "$git_root" ] || {
    echo "ERROR: project_dirはgit rootを指さなければならない: project=$project_root git_root=$git_root" >&2
    exit 1
  }
fi

mkdir -p "$tdir/roles" "$tdir/scripts"
cp "$tpl/charter.md" "$tdir/CLAUDE.md"
cp "$tpl/parent.md" "$tdir/roles/parent.md"
if [ "$mode" = "standalone" ]; then
  cp "$tpl/member-standalone.md" "$tdir/roles/member.md"
  cat "$tpl/tasks.md" "$tasks" > "$tdir/tasks.md"
else
  # claim 範囲は席へ渡す文書に焼き込む。範囲の出典を「誰かの記憶」でなく role 文書にする
  if [ ${#phases[@]} -eq 0 ]; then
    scope="この卓の claim 範囲は plan 全体（phase 指定なしで立っている）。"
  else
    scope="**この卓の claim 範囲は phase ${phases[*]} の task だけ**。範囲外の phase の task は、ready に見えていても取らない——同じ plan へ別 campaign が相乗りしている時、範囲外を取ると他卓の工程を横取りする（越境が2回実測されたことへの対処）。範囲外に手を入れる必要が出たら room へ出して裁定を仰ぐ。"
  fi
  sed -e "s|{{PLAN_KEY}}|$plan|g" -e "s|{{CLAIM_SCOPE}}|$scope|g" "$tpl/member.md" > "$tdir/roles/member.md"
  cp "$tpl/done.sh" "$tdir/scripts/done.sh" && chmod +x "$tdir/scripts/done.sh"
  cp "$tpl/independence-refresh.sh" "$tdir/scripts/independence-refresh.sh" && chmod +x "$tdir/scripts/independence-refresh.sh"
fi
# 目覚まし係の登録口は全モード共通で配る（member.md の待機作法が参照する）
cp "$repo/skill/scripts/alarm-set.sh" "$tdir/scripts/alarm-set.sh" && chmod +x "$tdir/scripts/alarm-set.sh"
# member.md が attach 手順で参照する。配り漏れると席が attach できず停止する（実被弾 2026-08-22）
cp "$repo/skill/scripts/pull-attach-input.mjs" "$tdir/scripts/pull-attach-input.mjs" && chmod +x "$tdir/scripts/pull-attach-input.mjs"
# room MCP 定義は project root の .mcp.json が正（channels は --mcp-config を解決しない。決定44）
added_root_mcp=false
if [ -f "$proj/.mcp.json" ]; then
  echo "WARN: $proj/.mcp.json が既に存在する。上書きしない。room の server 定義を手動 merge し、teardown で復元すること" >&2
else
  sed "s|{{PEERTABLE_REPO}}|$repo|g" "$tpl/mcp.json" > "$proj/.mcp.json"
  added_root_mcp=true
fi

added_exclude=false
if [ -d "$proj/.git" ] && ! grep -qx '\.team/' "$proj/.git/info/exclude" 2>/dev/null; then
  mkdir -p "$proj/.git/info"
  echo '.team/' >> "$proj/.git/info/exclude"
  added_exclude=true
fi
added_mcp_exclude=false
if [ "$added_root_mcp" = "true" ] && [ -d "$proj/.git" ] && ! grep -qx '/\.mcp\.json' "$proj/.git/info/exclude" 2>/dev/null; then
  mkdir -p "$proj/.git/info"
  echo '/.mcp.json' >> "$proj/.git/info/exclude"
  added_mcp_exclude=true
fi

lattice_preexisting=false
[ -d "$proj/.lattice" ] && lattice_preexisting=true
runtime_preexisting=false
[ -d "$proj/.lattice/runtime" ] && runtime_preexisting=true

# adapter registry/config/spool はhost固有のruntime stateであり、sourceとして追跡しない。
# `.lattice/`の一部を正本として追跡するprojectでもruntimeだけをroot相対で除外する。
added_runtime_exclude=false
if [ "$mode" = "lattice" ] && [ -d "$proj/.git" ] \
  && ! grep -qx '/\.lattice/runtime/' "$proj/.git/info/exclude" 2>/dev/null; then
  mkdir -p "$proj/.git/info"
  echo '/.lattice/runtime/' >> "$proj/.git/info/exclude"
  added_runtime_exclude=true
fi

# **機械配車の口はもう作らない。** 2026-08-09 のオーナー裁定（改・裁定1）で、Lattice が席へ
# 仕事を配る向きは撤回された。席は自分で `todo start` してから `run intake` するので、
# work-order adapter の登録も spool（orders/reports）も要らない。**setup がここで adapter を
# 必須化していると、adapter binary が無い環境で新しい卓が立たなくなる**（配車をしないのに）。
# 既存 project に前の卓が作った registry が残っていても触らない——他 adapter や進行中 run の
# 所有物を含みうるので、setup が消す対象ではない。
work_order_adapter=false
work_order_spool_ref=""

# Lattice 併用モードだけ、工程表の右ペインへ円卓を差す（決定53・明示的コネクタ）。
# 公開URL基底は `PEERTABLE_PUBLIC_URL`（クオ環境: https://peertable.kitepon.dev）。
# 未設定なら room サーバーの URL をそのまま使う——LAN URL は Lattice を外から見た時に開けないので、
# 書いた URL は必ず標準エラーへ出す。
external_pane=false
project_json_preexisting=false
public_url=""
if [ "$mode" = "lattice" ]; then
  public_url="${PEERTABLE_PUBLIC_URL:-$url}"
  project_json_preexisting=$(node "$repo/skill/scripts/external-pane.mjs" "$proj" "$room" "$public_url")
  external_pane=true
fi

# phases は追加キー（既存の読み手は .get で読むので壊れない）。空配列＝plan 全体
phases_json="[]"
if [ ${#phases[@]} -gt 0 ]; then
  phases_json=$(printf '"%s",' "${phases[@]}")
  phases_json="[${phases_json%,}]"
fi

# **解決した CLI の実 path を残す。** 残さないと、席も teardown も PATH の `lattice` へ逸れる。
# release 前の source tree を実測する卓では、それは**pull 系 command を持たない古い install**で、
# 手順どおり打っても届かない（suzune の監査で実測・room [1037]）。
if [ "$(node -p 'process.platform')" = win32 ]; then
  node "$repo/skill/scripts/platform/windows/write-setup-state.mjs" "$tdir/setup-state.json" \
    "$room" "$url" "$public_url" "$mode" "$plan" "$phases_json" "$added_exclude" \
    "$lattice_preexisting" "$runtime_preexisting" "$added_runtime_exclude" "$added_root_mcp" \
    "$added_mcp_exclude" "$external_pane" "$project_json_preexisting" "$work_order_adapter" \
    "$work_order_spool_ref" "$lattice_cli"
else
  printf '{"room":"%s","server_url":"%s","public_url":"%s","mode":"%s","plan_key":"%s","phases":%s,"added_exclude":%s,"lattice_preexisting":%s,"runtime_preexisting":%s,"added_runtime_exclude":%s,"added_root_mcp":%s,"added_mcp_exclude":%s,"external_pane":%s,"project_json_preexisting":%s,"work_order_adapter":%s,"work_order_spool_ref":"%s","lattice_cli":"%s"}\n' \
    "$room" "$url" "$public_url" "$mode" "$plan" "$phases_json" "$added_exclude" "$lattice_preexisting" "$runtime_preexisting" "$added_runtime_exclude" "$added_root_mcp" "$added_mcp_exclude" "$external_pane" "$project_json_preexisting" "$work_order_adapter" "$work_order_spool_ref" "$lattice_cli" > "$tdir/setup-state.json"
fi

# 稼働状態ブリッジを起こす。**teardown が止めるのと対称にする**——「起こすかは卓の任意」だった間、
# 手で `nohup` する経路が2つの失敗を招いた: 起こし忘れと、**トークンを持たないシェルで起こす**
# （2026-08-10 実測: `export` 欠落の設定ファイルを source した shell から起こした常駐が、
# 4時間 HTTP 403 を撃ち続け、参加者一覧には点が1つも出なかった＝起こしていないのと見分けがつかない）。
# AI は使わず席へも1バイト送らないので卓の作業を邪魔しない。**書けない時は常駐せずに死ぬ**ので、
# ここで壊れた常駐が黙って残ることは無い。setup-state.json を読むので、必ずその後で起こす。
"$repo/skill/scripts/ensure-bridge.sh" "$proj" alarm || echo "alarm-bridge の起動確認に失敗した（席は使える・目覚まし係だけ後で ensure-bridge.sh で立てる）" >&2
if "$repo/skill/scripts/ensure-bridge.sh" "$proj" seat-status; then
  echo "seat-status-bridge: ready_at を確認した（ログ $tdir/seat-status-bridge.log・停止は teardown が行う）"
else
  echo "seat-status-bridge: 起動を確認できなかった（ログ $tdir/seat-status-bridge.log）" >&2
fi

echo "scaffold done: $tdir"
