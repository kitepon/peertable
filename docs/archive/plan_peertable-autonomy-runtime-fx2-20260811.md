# Peertable 自律性改修 companion fix campaign 2（peertable-autonomy-runtime-fx2-20260811）— 計画正本

本書は `peertable-autonomy-runtime-20260811` campaign 中に再現した独立欠陥のうち、companion plan
`peertable-autonomy-runtime-fx-20260811` の migrate 済み task（f1〜f3）は narrative_ref に行番号を
持つため `todo split` は使えるが、新規 task 追加には `todo revise`（desired_plan 全体・
source_cutover_batch を要求する重量級 API）が要るため、実装コストとのバランスから**別の
companion plan**として起票するものである（オーナー裁定[37]: 「companion fix plan へ ToDo 化」に
plan_key の同一性までは求められていないと判断）。本 campaign の Lattice plan key は
`peertable-autonomy-runtime-fx2-20260811` とする。各 f は main plan
`peertable-autonomy-runtime-20260811` の t4 の前提へ `lattice todo dependency connect` で接続する。

## 1. 目的

オーナー裁定[37]（手順漏れ・案内不足・手作業依存は個人の注意不足で閉じずPeertableの修理欠陥として
扱う）に従い、campaign 中にさらに再現した2件の欠陥を直す。

## 2. Lattice 工程

### f4 稼働中 plan へ欠陥を追加する正規手順の案内不足

所有: `skill/scripts/todo-extraction-from-plan.mjs`（新規）、`docs/plan_peertable-autonomy-runtime-20260811.md`
（§2.5 への追記のみ。他 task の所有 file は触らない）。

campaign §2.5 は「発見者自身が `todo split` / `todo revise` の適切な authoring transaction で新しい
ToDo を工程正本へ追加する」と案内するが、**main plan（`peertable-autonomy-runtime-20260811`）は
migrate 時に narrative_ref へ行番号（`#L<line>`）を持たせなかったため、`todo split` が
`predecessor_source_inventory_unavailable` で機構的に失敗する**（実測: nagi, 2026-08-11T07:29Z）。
`todo revise` は使えるが、desired_plan 全体・task_migration・source_inventory・
source_cutover_batch を要求する重量級 API で、案内無しに現場が選べる手段ではない。この案内不足に
より、実際に親裁定を要した（bell[20]）。

**主受入は文書追記ではなく仕組み修理（owner裁定[60]）**: `skill/scripts/todo-extraction-from-plan.mjs`
を新設する。計画 Markdown に `### <task_id> <title>` 見出しで独立欠陥 task を書くだけで、見出し階層
（`heading_path`）・行番号（`origin_line`）・本文（`design_memo`）・digest を自動抽出し
`lattice.todo_extraction.v3` を機械的に生成する。発見者は「Markdown に書く→ツール実行→
`lattice todo migrate` で companion plan として起票」の3手順だけで、重量級 revise や親裁定なしに
独立 task 化できる。`docs/plan_peertable-autonomy-runtime-20260811.md` §2.5 には、この正規入口への
案内（narrative_ref 行番号が無い plan では split が機構的に失敗しうること、その場合は本ツールで
companion plan を起票し `dependency connect` で前提へ接続すること）を追記する——文書はツールの
説明として従属する。

実測（メタ実害・nagi 2026-08-11T07:57Z）: 本ツールを実装している最中、まさにこのツールが解決しよう
としている問題（工程化入口の重さ）により、`lattice todo start` で claim する前に実装ファイルが
canonical へ現れる形で作業が先行してしまった（bell[63] 実測・指摘）。ツール未整備の状態では発見者が
「まず動く形を作ってから工程へ載せる」順に流れやすいこと自体が、f4 が修理する対象の実例である。

関連症例（担当は各 task の文脈保持者に委ねる。ここでは記載のみ）: suzune[42] が t1 の accept で
`RUNTIME_CONFLICT_HOLD`（`undeclared_write` 2件）に遭った件は、design_memo の散文で書いた所有範囲
（新規 harness・配布診断）が witness 宣言（`.lattice/todo/witness/<plan_key>.json`）へ機械的に反映
されておらず、accept で初めて hold になるという、同じ「散文の意図が装置の宣言境界に落ちていない」
系統の案内不足である。

### f5 seat-usage.mjs の pane 判定が process 停止状態を見ない

所有: `skill/scripts/seat-usage.mjs`。

`fg`/`bg` 等で子プロセスが stopped（`ps` stat `T`）状態でも、room の member 一覧が該当席を
`status: idle` と報告した（実測: bell, 2026-08-11T07:47Z。原因究明中に bell が `fg` のみで復帰）。
`classifyPaneTail`（`seat-usage.mjs` 149–153行目）は tmux pane 末尾の**画面文字列**
（`esc to interrupt` の有無、承認プロンプトのマーカー）だけを見て busy/blocked/idle を判定しており、
対象プロセスの実際の生存・フォアグラウンド状態（`ps` state）を一切見ない。tmux pane は子プロセスが
停止していても直前の画面内容をそのまま表示し続けるため、停止直前の画面が idle 風であれば
stopped 状態でも idle と誤判定される。`launch-seat.sh` の seated 誤判定（f3、companion fix plan 1）
と対象ファイル・発生局面（起動時 vs 継続監視）は異なるが、「画面文字列だけを見てプロセスの実際の
状態を確認しない」という設計欠陥のパターンは共通する。pane 文字列判定に加えて、対象 pid の実際の
`ps` state（`T` 等の異常状態）を組み合わせた判定へ直し、既存の busy/blocked/idle 判定・呼び出し元
（`seat-status-bridge.mjs` 等）を壊さないことを fixture で確認する。

### f6 receipt 未 accept でも ToDo done が先行し、着地しないまま完了に見える

所有: `skill/templates/done.sh`（と生成物 `.team/scripts/done.sh`）、対応する `experiments/` の新規 harness。
他 task の所有 file は触らない（`skill/templates/done.sh` は t2 の witness では read 宣言であり write ではない）。

実行層に載っている task では、成果の正本は Lattice が撮った observed diff（accepted receipt）である。
しかし現行 `done.sh <task_id>` は **receipt の accept 状態を一切見ずに `todo done` を打つ**。
landing-only mode（`done.sh --landing-run <run>`）は accept 済み receipt の未着地本数を警告するだけで、
**receipt がそもそも無い場合は 0 本＝警告なし**になる。

実測（suzune, 2026-08-11T07:45–07:49Z, room [42][45]）:

1. `lattice run intake accept --run <run> --task t1` が `RUNTIME_CONFLICT_HOLD`
   （`undeclared_write`: `experiments/seat-change-repro.mjs`, `room/client.mjs`）で失敗した。
2. それでも `.team/scripts/done.sh t1 --evidence-from <worktree>/...` は成功し、
   ToDo は `done`（journal seq3）になった。出力は `未push 4本` だけで、
   **accept されていない事実には触れない**。
3. 親の工程完了後照合で `run landing` が `landed:false` / `accepted_receipts: []` を返し、
   canonical main に commit が無いことが判明して t1 は reopen された（bell, room [45]）。

つまり「ToDo は完了、成果はどこにも着地していない」という状態を、卓も親も**事後照合まで検知できない**。
`done.sh` を次へ直す。

- 対象 plan の active な pull run に当該 task の intake が在るなら、**accept 済みでない限り
  `todo done` を打たずに落ちる**（次に打つべき command を名指しする）。
- intake が無い（実行層に載っていない）task は現行どおり done できる——実行層の利用は任意であり、
  載っていない卓を止めない。
- `--landing-run` は「accept 済みで未着地」に加えて「intake は在るが accept されていない」も区別して出す。
- 欠陥版（現行 done.sh）で落ち、修正版で通る harness を `experiments/` へ置く。

## 3. 完了条件

1. f4・f5・f6 が、実装者と別の文脈近接一席の peer audit を経て done であること。
2. 各 f が `dependency connect` で main plan t4 の前提へ接続されていること。
3. main campaign の t5 着手前に、本 companion plan が全 done であること。
