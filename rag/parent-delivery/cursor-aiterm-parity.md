# Cursor受信とAitermの対照

出典: Aiterm `8cfe1da43a28606ccb53acd1dbfcc0607436add0` の `src/cursor-parent-receiver.ts`、`src/cursor-parent-receive.ts`、`src/setup-integrations.ts`、`src/core.ts`。確認日: 2026-09-29。確度: 実sourceの静的照合。Peertableの実機受信の証明とは分ける。

| 責務 | Aiterm | Peertable |
| --- | --- | --- |
| 会話相関 | MCP結果の配送IDをafterMCPExecution/postToolUseのconversation_idへ束縛 | join結果のendpoint_idを同じ公式hookのconversation_idへ束縛 |
| 作業中の本文 | postToolUse/postToolUseFailureのadditional_context | 同じ2種のhookのadditional_context |
| idle中の本文 | receiptの受信processを親の背景toolから起動 | receiptの受信processを公式の背景Shellから起動 |
| 二重受信の排他 | hookとreceiverの共通claim | hookとreceiverの共通spool claim |
| 継続受信 | 子の回答1件ごとのreceiver | roomのDM・複数宛・allを保存し、次の背景受信を登録 |

修理前のPeertableはafterMCPExecutionでも本文を消費し、postToolUseFailureを登録していなかった。Aitermのhandlerと同じ注入口に揃えた。Aitermのsetupは参照時点でafterMCPExecution/postToolUseだけを登録しているため、「Aitermの既定設定でも失敗後hookが発火済み」とは扱わない。Peertableでは合意済みの失敗後hook対応を接続設定へ含めた。

背景ShellのモデルAPI入力はworking_directoryとblock_until_ms: 0を含む完成済み入力、公式hookはcommandとcwdへ正規化された入力を持つ。両者を分けて保存・照合し、モデルによる引数補正を必要としない。根拠は[実入力の診断](cursor-native-input-diagnosis.json)。Desktopの同一schemaは未確認でありCLIの記録だけでは成立としない。

roomの購読cursor・宛先別receipt・再登録・長文回収はPeertableが所有する。Aitermの配送へPeertable専用分岐を追加しない。
