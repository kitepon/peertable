# 通信失敗の報告判断

Peertableの通信診断、配送状態と修理依頼を扱う手順。
共通契約は[ServerManager NETWORK_REPORTING.md（ef578fe）](https://github.com/kitepon/ServerManager/blob/ef578fe6d4512ecf07693f6aad5997e7d098536d/bughub/NETWORK_REPORTING.md)。
BugHub送信本文の形は[PRODUCT_REPORTING.md](https://github.com/kitepon/ServerManager/blob/ef578fe6d4512ecf07693f6aad5997e7d098536d/bughub/PRODUCT_REPORTING.md)に従う。

## 診断と修理依頼

- 通信環境の事象は、対象環境と観測根拠を記し、環境管理担当へ渡す。
- Peertableの対処不良は、期待する動作と実際の差を確認して製品の修理対象にする。送信結果の誤表示、本文の喪失、重複配達、取消後の配達、復帰後の受信停止などが対象になる。
- 原因未確定の場合は、確認できた影響、製品の対処、未確認の部分を記す。エラーコード、発生回数、ログの不在から原因や正常性を決めない。

正常な取消、適切に処理して復帰した一時的な通信断は、必要な診断を保持し、参考情報として扱う。自動で修理対象へ上げない。影響や復帰を確認できていない時は未確認と明記する。

重大度は機能停止、入力・データの喪失、重複配達、復帰の可否、影響範囲で判断する。通信環境の障害でも重大な実害は重大として報告する。重大度と修理担当は別に決める。コードやcountだけでhighを付けない。

## 現行の登録経路

0.9.9にはBugHub用のruntime error登録・severity決定・製品報告送信処理がない。通信失敗は次の診断と配送記録に残る。これらのfail、failed、unknownは通信・配送の状態で、アプリ欠陥やBugHubの重大度を意味しない。

| 処理 | 記録と対処 |
| --- | --- |
| [room/client.mjs](../room/client.mjs)のrunDiagnostics | 接続先が指定されている時だけroom_reachabilityを調べる。到達できない時はfail。接続先未設定はnot_applicable。JSONに原因・担当・severityを追加しない。 |
| [skill/scripts/room-api.mjs](../skill/scripts/room-api.mjs)のRoomApi.request | 15秒の期限とHTTP状態を確認し、通信失敗をtyped errorで返す。空の台帳や成功として扱わない。 |
| [skill/scripts/wakeup-bridge.mjs](../skill/scripts/wakeup-bridge.mjs)のSSE loop・catchUp | 自分で接続を切ったAbortErrorを連続失敗に数えず、再接続時にsinceから回収する。10回連続接続失敗は受信機能の停止として記録する。回数は停止条件で、severity決定ではない。 |
| [skill/scripts/parent-watch.mjs](../skill/scripts/parent-watch.mjs)の受信loop | --nextの待機期限とendpointの交代は正常終了。連続失敗によるwatch_errorは受信停止の診断として扱い、環境原因や製品欠陥とは断定しない。 |
| [skill/scripts/parent-delivery.mjs](../skill/scripts/parent-delivery.mjs)のParentSpool | 原文・配送IDを保持し、同一イベントを重複登録しない。出力の成否不明はunknownとして本文の自動再送を止める。receiptの送信失敗はpendingを残し、本文の配送成否とは区別する。 |

工場のdotagents adapterは[lib/factory/v7.mjs](https://github.com/kitepon/dotagents/blob/0d4c5ad6267f3b5fa4eeccdc517211cc3f87b726/lib/factory/v7.mjs)のpeertableProductがPEERTABLE_URLを空にして診断する。check失敗へのhigh固定は存在するが、room_reachabilityはnot_applicableからskippedへ写すため、roomの通信断をhighとして登録する経路にはならない。同adapterのruntime_errorsは空で、Peertableは工場のruntime error収集対象にも入っていない。工場の導入診断と製品の実行時報告を混同しない。

## 調査・訂正

依頼を受けたら、対象操作、本文が保存されたか、宛先の受付状態、取消の有無、再接続後の復帰を診断・room台帳・spoolで確認する。本文の再送前には、結果不明の既存送信を照合する。利用者の通信を乱す試験や、取りやめた実機試験、終了した環境根因追跡を再開しない。

既存報告を訂正する場合は、その送信元の正規入口と根拠を使い履歴を残す。原本、累計、時刻、fingerprintを書き換えたり補造したりしない。新しいJSON項目は足さず、既存診断・調査注記・担当報告で分類と実害を伝える。BugHubに表示されたPeertableのissueがある場合は、まず送信元・fingerprint・元の診断を照合し、未取得の原本を訂正済みとは扱わない。

## 2026-10-07の見直し結果

- 製品sourceは01bc70a、npmと端末3台は0.9.9。通信失敗を自動でアプリ欠陥またはhighにする製品処理はなく、今回の報告条件の見直しに実行コードの変更・npm公開・端末更新は不要。
- macbook、fox、rabbitのpeertable-client diagnostics --jsonはoverall=ready。version_consistency、bin_integrity、node_runtime、skill_bundleはpass。room_reachabilityはnot_applicableで、稼働roomの通信正常を実測した結果ではない。3台とも規定位置にPeertableのBugHub製品credentialはなかった。credentialの不在だけを報告不達の証明にはしない。
- 既存の親配送・親MCP試験18件が通過。原文保存、HTTP/SSE重複の配送ID維持、遅延receipt失敗、受信の張り直し、parent_leave後の正常なclosedを確認。ローカルfixtureの結果であり、実harnessや利用者の回線断時の全操作を確認したとは扱わない。
- 過去のBugHub原本と件数は未取得で、訂正・解決送信は行っていない。今回の調査結果とこの手順を担当報告として渡し、BugHub担当が到達・表示と照合する。
