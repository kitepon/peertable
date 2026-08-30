# Peertable 着手入口の既存卓配布修理 companion（peertable-task-announcements-fx-20260812）— 計画正本

日付: 2026-08-12

## 1. 発見した欠陥

main campaign の a2 は配布元 `skill/templates/start.sh` / `start-event.mjs` と
`skill/scripts/setup.sh` の新規卓向け生成を実装済みだが、既存の卓
`peertable-autonomy-runtime-20260811` には `.team/scripts/done.sh` しかなく、正規着手入口が欠落していた。
さらに現卓の `.team/scripts/done.sh` と配布元 `skill/templates/done.sh` に版差があり、a3 の完了通知も
現行実装へ到達しない。既存卓へ新規卓用の scaffold を無条件再実行すると、利用者資産・他工程資産の
上書き境界を壊す。

## 2. 契約

Peertable が所有して版を判定し同期してよい generated asset は、setup mode に応じた次の allowlist
だけとする。

- `.team/CLAUDE.md` ← `skill/templates/charter.md`
- `.team/roles/parent.md` ← `skill/templates/parent.md`
- lattice mode の `.team/roles/member.md` ← `skill/templates/member.md` の plan/phase 展開
- lattice mode の `.team/scripts/done.sh` ← `skill/templates/done.sh`
- `.team/scripts/start.sh`
- `.team/scripts/start-event.mjs`

standalone mode の `.team/roles/member.md` は template 本体の同期対象とするが、利用者の議題を含む
`.team/tasks.md` は対象外とする。入力は既存 `.team/setup-state.json` と同じ repo の配布元 templates。
upgrade は allowlist の target/template digest を比較し、欠落または版差なら Peertable管理資産として
現行 template へ同期し、一致なら no-op とする。allowlist 外の `.team` 資産、利用者ファイル、credential、
room設定、seat identity、Lattice store は変更しない。対象 path が symlink/非通常file、setup-state が
壊れている、template が欠落している場合は副作用前に typed reject する。

## 3. 工程

### u1 既存卓へ着手入口を安全に配布する

- [x] u1の実装・試験・証跡化を完了した。後続の現行実装方針を正とする。

入力は `.team/setup-state.json`、`skill/templates/` の管理対象 templates。正規 upgrade 入口は
`skill/scripts/upgrade-team-assets.sh` とし、mode別 generated asset allowlist の版と所有を検証する。
Lattice mode / standalone mode の setup-state を読み、setup-state が壊れている、管理対象 template が
欠落、管理対象以外へ書こうとする場合は副作用前に typed reject する。

正負 fixture は、a2既存卓の start 2本欠落、a3既存卓の stale done、現行templateへの同期、
一致時no-op、対象外ファイルと credential の不変、壊れたsetup-stateとunsafe pathの副作用ゼロを確認する。
適用後は同じ入口 `.team/scripts/start.sh` から a6 を claim し、successful start 後に started event が
全席へ一度だけ届くこと、a6完了後に `.team/scripts/done.sh` から completed event が一度だけ届くことを
実席で確認する。

修理対象は generated asset の配布だけであり、`room/client.mjs`、既存 `.team/scripts/done.sh`、role本文、credential、seat-status/wakeup bridge、Lattice本体の仕様は変更しない。

## 4. 構造データ

- 入力: `.team/setup-state.json` と配布元 `skill/templates/{charter,parent,member,done,start,start-event}`。
- 整理: `skill/scripts/upgrade-team-assets.sh` が mode別 allowlist と template digest を検証し、Peertable管理
  assetだけを同期する。
- 出力: `.team/CLAUDE.md`、`.team/roles/*`、`.team/scripts/{done,start,start-event}` と、正規入口からの
  started/completed event。
- 利用先: `.team/scripts/start.sh`、`.team/scripts/done.sh`、`start-event.mjs`、diagnostics、a6の実席統合。

## 5. 完了条件

1. u1 が実装者以外の正式席による peer audit を受け、正負 fixture green 後に done である。
2. a2/a3の既存卓負例を含む generated asset が現行templateへ同期され、対象外資産とcredentialは変更されない。
3. `lattice todo structure input/compile` が consistent になり、structure digest と所有境界を room に記録する。
4. 適用直後、`.team/scripts/start.sh a6` の成功一回に対応する started event が全席へ一度だけ届く。
5. a6完了後、現行 `.team/scripts/done.sh` の成功一回に対応する completed event が一度だけ届く。
6. a6 の Wave 2 deploy と production smoke は、この修理の成立後に owner が承認した実席統合線で行う。npm publish は行わない。
