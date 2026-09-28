# 調査資料の入口

- [親セッションの公式受信口](parent-delivery/receivers.md) — Aitermの親返信4方式、Peertableへの適用、3 OSで未検証の条件、公式仕様と固定sourceの参照。
- [Codexの公式hook本文の符号化](parent-delivery/codex-hook-body-encoding.md) — 公式XMLの一度の復号と実機本文照合の境界。
- [WindowsのNode終了エラーの観測](parent-delivery/windows-node-exit-observation.json) — CIの内部assertion、上流修理、公式installerによる更新とfocused確認。
- [修理後の通常CLI候補の観測](parent-delivery/repaired-cli-candidate-observation.json) — macOS Claude/Codexの原文・返答・receiptと、親終了後の自動停止・索引撤去・設定復元。
- [Cursor/Grokの正式CLI証拠の親監査](parent-delivery/cursor-grok-formal-review.json) — 旧候補の6 audience、18本文と公式turn・後続返答の独立照合、画面取得の不足。
- [CLIの終了・設定解除・本人相関の修理](parent-delivery/cli-lifecycle-repairs.md) — Linuxの削除済みbinary、Windows Codex Job、公式設定解除とJSON構造、旧証跡の保存と再測定条件。
- [修理後候補のCLI正式証拠の独立監査](parent-delivery/cli-formal-review-017bf2c.json) — macOS Claude/Codexのaudience原文・実会話・receipt・controller・pack・終了回収の照合。
- [旧sourceのWindows・Linux CLI追加監査](parent-delivery/snapshots/017bf2c/additional-cli-independent-review.json) — 各3通の実会話・receipt照合と、Windows packのmode差。製品修理後の候補には算入しない。
- [Linux Grok公式更新先名の実診断](parent-delivery/linux-grok-native-name-diagnosis.json) — 修理moduleの指紋と、実PID・開始identityによるGrok本人照合。準備診断であり正式配送受入には算入しない。
- [Codex初回probeの実期限超過](parent-delivery/codex-probe-deadline-diagnosis.json) — 実app-serverの停止・自然timeout・room healthを照合。30秒期限への14.478秒の遅延を保持する修理診断。
- [Codex probe timer修理後の実診断](parent-delivery/codex-probe-timer-repair-diagnosis.json) — 同じOS障害で実期限10ms後のroom failedを観測し、生timeline・PID・Git blobを独立照合。正式受入への算入は0件。
- [Codex同会話での再登録失敗](parent-delivery/codex-probe-rejoin-diagnosis.json) — 自然timeout後の正規再登録でもfailed probeが不変となる実再現。開始時controller bytesと製品Git blobを照合し、正式合格へ算入しない。

- [Windows競合CIのrename失敗](parent-delivery/windows-rename-ci-diagnosis.json) — transaction ticketの実EPERMと保持readerのAPI対照を保存し、Windows標準APIで修理。[実Node版のlibuv一次原文](parent-delivery/sources/node-v24.20.0-libuv-win-fs.metadata.json)は原因を断定する証拠と分ける。
- [Claude同会話のhook無効化・復帰](parent-delivery/claude-own-session-hook-diagnosis.json) — 公式session settingsと同CIDの3 MCP結果を原transcriptへ独立照合。復帰後の本文配送はこの準備診断では検証していない。

- [正常なLinux Grokのprobe遅延](parent-delivery/linux-grok-probe-latency-diagnosis.json) — 正規本文回収53.198秒と健康復旧の原記録、共通期限の調整根拠。
- [Codex同会話再登録の修理診断](parent-delivery/codex-probe-rejoin-repair-diagnosis.json) — 新probe原文・後続DM・health復旧と旧failed保持の独立照合。正式受入へ算入しない。
- [Cursor入力の実診断](parent-delivery/cursor-native-input-diagnosis.json) — モデルAPIの完成済み入力とhookが正規化した入力の差。
- [AitermとCursor受信の対照](parent-delivery/cursor-aiterm-parity.md) — 束縛hookと本文差し込みhook、背景受信、Peertableが所有するroom状態の区別。
- [Windows排他の実再現](parent-delivery/windows-lock-contention-diagnosis.json) — 6process同時更新でCIM本人確認が10秒期限を占めた原記録。
- [Windows本人確認APIの実測](parent-delivery/windows-process-identity-diagnosis.json) — native handleの存命・開始時刻とCIM互換性、実PID再利用、計測の限界。
- [120秒期限のLinux Grok診断](parent-delivery/linux-grok-probe-repair-diagnosis.json) — 正規本文回収33.102秒とhealth復旧。次のsourceの正式受入には算入しない。
- [親配送の公開裁定](parent-delivery/release-decision.json) — オーナーが正式実機受入の完了を待たず公開するよう指示した対象version・runtimeと未確認範囲。
- [親配送0.8.63の公開結果](parent-delivery/release-result-0.8.63.json) — npm公開、3 OS導入・接続更新、本番API確認、再起動待ちと延期した実機受入。
