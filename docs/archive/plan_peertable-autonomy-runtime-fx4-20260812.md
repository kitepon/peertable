# Peertable 自律性改修 companion fix（同名席置換・peertable-autonomy-runtime-fx4-20260812）— 計画正本

本書は `peertable-autonomy-runtime-20260811` の t4 実円卓測定で再現した、t1 の受入内にある
同名席置換の欠陥を修理する companion plan である。t4 はこの修理を前提へ接続し、修理完了後に
同じ使い捨て room / project / 実席のライフサイクルを再実測する。

## 1. 目的

自然文相当の target を親が確定して `change-seat.sh` を実行した時、旧席の room member が残ったまま
`launch-seat.sh` へ進み `SEAT_ROOM_MEMBER_CONFLICT` で停止する。旧席を手動 `leave-seat.sh` してから
`launch-seat.sh` を呼ぶ手順に逃がさず、共通操作自身が旧席の session・room member・seat identity・
credential を安全に撤去し、成功確認後だけ新設定で再着席させる。

## 2. Lattice 工程

### r1 change-seat 自身による同名席の安全な置換

所有: `skill/scripts/change-seat.sh`、t1 の席設定変更 focused harness。先行 task の product code は
触らない。

負例は、同名 room member が残る実席で `launch-seat.sh` を直接呼ぶと
`SEAT_ROOM_MEMBER_CONFLICT` で停止すること、および修理前の `change-seat.sh` が同じ境界で停止し
rollback もできないことを固定する。修正版は次を満たす。

- busy / catalog / 引数の拒否を先に行い、処理中の席を停止しない。
- target を確定した後、`leave-seat.sh` の正規境界で旧席を撤去する。撤去に失敗したら新席を起動しない。
- 新設定の起動失敗時は、既存契約どおり旧設定を一回だけ明示 rollback する。
- 新 member metadata と room 履歴を読み返し、target と一致しないものを成功扱いにしない。
- `change-effort.sh` の互換入口と、自然文相当の依頼（完全一致 DM なし）を維持する。

既存の `seat-change-repro.mjs` と `effort-change-repro.mjs` を focused test として実行し、t4 の実席
ハーネスを修理後に再実行する。実装者以外の peer audit を経て r1 を done にする。

## 3. 完了条件

1. r1 が peer audit 済みで done であること。
2. r1 が `peertable-autonomy-runtime-20260811/t4` の前提へ dependency connect されていること。
3. t4 が同じ実席 fixture で DM 読み取り、自律 progress / claim、自然文相当の席変更、再着任を再実測できること。
