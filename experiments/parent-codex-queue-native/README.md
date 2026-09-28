# Codex 公式queueと同期hookの独立probe

親が3 OSで実測したsourceを保存する。製品connect・通常CLI/Desktop/IDEの受入とは分ける。通常認証と利用枠を使う独立probeであり、通常CIから実行しない。

新しい一時directoryへ `.mjs` をコピーし、`.codex` directoryを作る。`PEERTABLE_PROBE_CODEX`へ公式の実行fileを指定する。Windowsは公式installed packageのnative `codex.exe`、`PEERTABLE_PROBE_PWSH`へPowerShell 7を指定する。Linuxは通常login環境のNode/CLI PATHが必要。

**この保存sourceのprepareはuser configへown hook信頼entryを書く。** 実行前に通常CODEX_HOMEのconfigをtar backupし、公式`config/batchWrite`で試験用canonical rootだけのproject trustを登録する。Session層の起動引数だけではProject層の無効化を解除できない。`node prepare.mjs <一時directory>`で2つのown currentHashを公式承認し、`node run.mjs <一時directory>`でBUSY/STOP/IDLEを検証する。runは実MCP threadId、queue受付ID、delete:true、同busy/stop turnと新idle turnのnonce返信を検査する。

このsourceだけではbackup・canonical trust登録・後片付けを自動化していない。実行責任者が`trust-edits.json`のown keyと試験rootだけを公式APIで削除し、他設定保持とchild停止を照合する。利用上限・受付欠落は成功にしない。製品connectの代替として使わない。投影証拠は[受信調査記録](../../rag/parent-delivery/receivers.md)を参照する。
