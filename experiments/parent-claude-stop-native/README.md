# Claude Stop 継続の独立probe

親が3 OSで実測したsourceを保存する。製品MCP・通常TUIの受入とは分ける。原本のprivate HOME transcriptは配布しない。投影証拠は[受信調査記録](../../rag/parent-delivery/receivers.md)から参照する。

新しい一時directoryへこのdirectoryの `.mjs` をコピーし、`node setup.mjs <一時directory>`、`node capture-run.mjs <一時directory> <公式Claude実行file>`を順に実行する。WindowsはnpmのPowerShell shimをstdin中継に使わず、そのshimが呼ぶ公式native executableを指定する。通常の認証と利用枠が必要。利用上限・timeout・nonce欠落は成功にしない。

`capture-run.mjs`は全tool無効の同sessionでStop exit2を2回、後続assistantの2符号を照合し、`latest-stop-evidence.json`へ保存する。`portable-run.mjs`は初期のnative hook event観測runner。設定は一時directoryの`settings.json`だけで、global hookを登録しない。終了後はprobe child停止を確認し、一時directoryを保管または削除する。
