# Peertable 自律性改修 companion fix campaign（peertable-autonomy-runtime-fx-20260811）— 計画正本

本書は `peertable-autonomy-runtime-20260811` campaign 中に再現した独立欠陥のうち、main plan の
source inventory 不足で `todo split` / `todo revise` が使えないものをまとめる companion plan の
計画正本である。本 campaign の Lattice plan key は `peertable-autonomy-runtime-fx-20260811` とし、
本書を commit した後に `lattice todo migrate` で起票する。各 f は main plan
`peertable-autonomy-runtime-20260811` の t4（新契約を実円卓のライフサイクルで統合実測する）の前提へ
`lattice todo dependency connect` で接続する。

## 1. 目的

campaign 本体 §2.5（campaign 中に発見した不具合を後回しにしない）に従い、立卓・pull run 実行時に
再現した3件の基盤欠陥を直す。オーナー裁定「campaign 中に見つけた不具合は即工程へ組み込み、直す」を
本 companion plan で満たす。

## 2. Lattice 工程

### f1 pull run 前提の `.lattice/runs/` gitignore 整備

所有: `.gitignore`。

`lattice run start --selection pull ...` が `.lattice/runs/` が git の追跡対象（gitignore 対象外）に
なっていることを理由に `RUN_STORE_NOT_IGNORED` で失敗する（実測: nagi, 2026-08-11T07:22Z）。
`.gitignore` へ `.lattice/runs/` を追加して解消する（対象限定 commit da11173 で実装済み。本 task で
正式に工程へ載せ、peer audit を通す）。

### f2 `ensure-bridge.sh` 再 arm 時の unbound variable

所有: `skill/scripts/ensure-bridge.sh`。

立卓時、3席すべてで `launch-seat.sh` 末尾の `ensure-bridge.sh` 再 arm が
`saved[@]: unbound variable` で失敗した（実測: bell, 2026-08-11T07:20Z）。record file
（`<project>/.team/<name>-bridge.json`）に `args` が空の場合、`saved=()` で初期化した空配列を
`set -- "${saved[@]}"` で展開する箇所が、macOS 標準 bash（3.2、`set -euo pipefail` 下）では
unbound variable エラーになる。setup 時に起動済みの bridge は ready のままなので席は稼働を続けるが、
bridge 消失後の席起動復帰契約が不成立のまま残る。空配列でも安全に展開できる書き方
（例: `"${saved[@]+"${saved[@]}"}"` や `((${#saved[@]}))` ガード）へ直し、record file の `args` が
空の場合の再 arm 経路を fixture で再現・検証する。

### f3 `launch-seat.sh` の live model unavailable 席を seated 成功と誤判定

所有: `skill/scripts/launch-seat.sh`。

fable-5 席で、Claude のバナー文字列が画面に出たため `seated=true` と判定されたが、その後の全入力が
model unavailable で 0 秒失敗した（実測: bell, 2026-08-11T07:23Z。suzune が opus/high で復旧済み）。
現行の seated 判定（`launch-seat.sh` 94–121 行目）は画面上の特定文字列出現だけを見ており、live model
が実際に応答可能かどうかの確認をしていない。着席後に軽い実応答確認を挟み、応答が無ければ seated
失敗として報告する形へ直す。既存の起動シーケンス・他 vendor（Codex 判定含む）を壊さないことを
fixture で確認する。

## 3. 完了条件

1. f1〜f3 が、実装者と別の文脈近接一席の peer audit を経て done であること。
2. 各 f が `dependency connect` で main plan t4 の前提へ接続されていること。
3. main campaign の t5（正典同期・回帰・配布面を閉じる）着手前に、本 companion plan が全 done で
   あること。
