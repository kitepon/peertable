# Lattice試験結果項目への円卓完了フロー結線（lattice-test-result-bridge-20260813）— 計画正本

日付: 2026-08-13
状態: Lattice storeへbacklog登録し、外部成果物が届くまで着手しない
外部契約ID: `lattice.todo_test_result.v1`

## 目的

作業者が監査担当へ渡す最終試験結果を、既存の完了フローからLatticeの`test_result`へ薄く結線する。
後工程は`lattice todo show`の一回で試験結果とevidenceを読めるようにする。

## 前提

Latticeの対応releaseがglobal install済みで、一時projectの`todo show --json`から
`test_result`と既存evidenceを同時に読めること。project横断dependency機構は追加しない。

## 契約

- 作業者は従来どおり自己試験・自己監査を行い、最終試験結果を監査担当へ渡す。
- 監査担当は試験を再実行せず妥当性を判断し、`done.sh`から同じ文章を`test_result`へ記録してcloseする。
- store直書き、別台帳、room API変更、自動生成・採点、単独円卓モード変更は行わない。

## 工程

- Lattice管理: ptr1（実装・出荷・導入後smokeを一工程で行う）

`ptr1`は、member/charterの既存手順と`done.sh`を最小変更し、通常worktreeとpull型の既存evidence鎖を
維持する。focused fixtureと監査後、publishの明示承認を待って配布・導入まで行い、使い捨て卓一つで
「作業者提出 → 監査担当判断 → close → `todo show`読出し」を一往復する。既存卓で同じ試験を重ねない。

## 完了条件

配布・導入済みPeertableから立てた使い捨て卓で、最終試験結果とevidenceを`todo show`一回で読めること。
