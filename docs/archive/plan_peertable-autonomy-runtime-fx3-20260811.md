# Peertable 自律性改修 companion fix campaign 3（peertable-autonomy-runtime-fx3-20260811）— 計画正本

`peertable-autonomy-runtime-20260811` campaign 中に再現した独立欠陥のうち、bell [66] が指摘した
「未監査 WIP が公開枝の祖先として出る」合成欠陥を扱う。fx2 は migrate 済みで新規 task 追加が重いため、
f4 で着地した `skill/scripts/todo-extraction-from-plan.mjs` を使って**別 companion plan** として起票する
（オーナー裁定[37] の「companion fix plan へ ToDo 化」に plan_key の同一性は求められていない、という
fx2 と同じ読み）。Lattice plan key は `peertable-autonomy-runtime-fx3-20260811`。

## 1. 目的

task 単位で成果を着地させられるようにし、他 task の未監査 commit を公開枝へ道連れにしない。

## 2. Lattice 工程

### g1 companion plan でも実行層を使えるようにし、未監査WIPを公開枝へ運ばない

所有: `skill/scripts/` 配下の新規入口（または既存 setup/skill 文書への手順追記）と、対応する
`experiments/` の新規 harness、本 task の証跡。他 task の所有 file は触らない。

**負例（すべて 2026-08-11 の実測）**:

1. companion plan `peertable-autonomy-runtime-fx-20260811` は `coordination=conversation` で
   witness を作っていないため、`lattice run intake` が
   `intervention=hold / boundary_unverified / artifact_binding_mismatch`（`independence_result_digest=null`・
   lease withheld）で通らなかった（tsubaki, room [47]）。実行層（隔離 worktree）を使えないので、
   f2 は canonical 共有木で実装された。
2. 一方 main plan 側で t1 の宣言境界を直すために `lattice todo independence compile` が必要になったが、
   これは **repo 全体（未追跡ファイルを含む）が clean でないと `INDEPENDENCE_WORKTREE_DIRTY` で走らない**。
   そのため私（suzune）が他2席へ作業中変更の WIP commit を依頼した（room [48][55][57]）。
3. 結果、t1 の accept 済み成果を canonical main へ着地させて push した時、**未監査・未done の f2 WIP
   commit（478de1b / 49fb249）が同じ push の祖先として origin/main へ出た**（bell, room [66]）。
   誰の git 手順ミスでもなく、(1)(2)(3) の合成である。

**受入条件**:

- migrate 済みの companion plan に対して、witness 作成 → `independence compile` → `run intake` が
  通ることを**実測で示す**（最低1 task）。通らないなら、その原因を実測で切り分けて記録する。
- その手順が現場から**1本の入口**で辿れる（f4 のツールと同じ位置づけの script か、
  `skill/SKILL.md` へ落とした command 列のどちらか。実測して安い方を採る）。
- companion plan を `conversation` のままにするか `witness` へ移すかを、上の実測に基づいて決めて記録する。
- 欠陥版（witness 無しの companion plan）で intake が hold になることを、harness か再現手順として固定する。
- **task 単位で push できるかを実測して結論を書く**。できないなら「できない」と根拠付きで記録し、
  運用側の回避（当該 branch 上の未監査 commit を先に監査へ通してから push する）を正典へ落とす。
  推測で「できるはず」と書かない。

## 3. 完了条件

1. g1 が、実装者と別の文脈近接一席の peer audit を経て done であること。
2. g1 が `dependency connect` で main plan `peertable-autonomy-runtime-20260811` の t4 の前提へ
   接続されていること。
3. main campaign の t5 着手前に本 plan が done であること。
