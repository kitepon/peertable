# Claude lease 更新の独立probe

親が3 OSで実測したsourceを保存する。製品join・通常TUIの受入とは分ける。新しい一時directoryへ `.mjs` をコピーし、`node setup.mjs <一時directory>`、`node run.mjs <一時directory> <公式Claude実行file>`、`node verify.mjs <一時directory>`を順に実行する。Windowsは公式native executableを指定する。

実PreToolUseのsession/tool_use_idとMCP wireのtoolUseIdを照合し、初回join、期限control、同じendpointの再join、新しいPostToolUseによる本文受信を確認する。`verify.mjs`は異なる2つの実tool_use_id・同session/endpoint・hook exit2×2・回答符号を検査する。通常認証と利用枠が必要。設定は一時directoryの`settings.json`と`mcp.json`だけでglobal hookを登録しない。結果とnative hook eventを保管し、終了したchildが残っていないことを確認する。

投影証拠の不足と原本の所在は[受信調査記録](../../rag/parent-delivery/receivers.md)へ記録する。
