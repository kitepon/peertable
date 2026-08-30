# Peertable task-event transport 検査器修理 companion plan

## 目的

`peertable-task-announcements-20260811/a5` の実動で判明した、依存未導入時の検査器ハングを修理する。対象は検査器だけであり、Wave 1 の本番配備済み product code、a2、k1、h9 は変更しない。

## 工程

### c1 検査器の子client終了を pending RPC へ伝播する

所有範囲は `experiments/task-event-transport-repro.mjs` と本planの証跡だけとする。client子プロセスが起動直後に終了したとき、未解決のRPCを bounded に reject し、検査器が無期限待ちせず失敗して終了する。正常な19/19のtask-event transport検証は維持する。

受入条件:

1. 子clientの `exit`／`error` が未解決pending RPCへ伝播する。
2. 依存未導入または子client起動失敗の負例が、無期限待ちではなく明示的な失敗として有限時間内に終了する。
3. 通常依存環境の既存task-event transport検証は19/19 greenのままである。
4. 実装者以外の文脈近接席による実物監査後に、証跡を固定してdoneにする。

非目標: `room/server.mjs`、`room/client.mjs`、MS-A2、本番image、npm publish、a2/k1/h9の変更。
