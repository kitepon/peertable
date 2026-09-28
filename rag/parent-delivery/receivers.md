# 親セッションの公式受信口

取得日: 2026-09-28。確度: Aitermのsource確認、公式仕様と配布資料の確認、固定snapshotのCLI実測。Peertable全対応の製品受入は未達。

この文書は調査記録である。実装要求は[配送設計](../../docs/plan_parent-native-delivery.md)を正本とする。Aitermの内部state・hook・moduleは参照資料だけであり、Peertableの実行時依存にしない。

## Aitermの実装

比較commitは`8cfe1da43a28606ccb53acd1dbfcc0607436add0`。以下は同commitのsourceを読んで確認した。

- [requestでの親識別と背景受信](https://github.com/kitepon/aiterm-mcp/blob/8cfe1da43a28606ccb53acd1dbfcc0607436add0/src/index.ts): Codex、Claude Code、Cursorのreceiverを選ぶ。これ以外の親は構造化`wait_process`で子の完了を受信して結果を回収する。
- [配送の保存と復旧](https://github.com/kitepon/aiterm-mcp/blob/8cfe1da43a28606ccb53acd1dbfcc0607436add0/src/parent-delivery.ts): waiting/ready/sending/submitted/failed/unknownを保存。孤立したsendingはunknownとし再送しない。子の回答保存と親への受信は別処理。
- [Codex receiver](https://github.com/kitepon/aiterm-mcp/blob/8cfe1da43a28606ccb53acd1dbfcc0607436add0/src/codex-parent-receiver.ts)、[同期hook](https://github.com/kitepon/aiterm-mcp/blob/8cfe1da43a28606ccb53acd1dbfcc0607436add0/src/codex-parent-hooks.ts): 公式queueへ投入し、所有記録に一致した項目だけを同じturnへ渡す。
- [Codex導入](https://github.com/kitepon/aiterm-mcp/blob/8cfe1da43a28606ccb53acd1dbfcc0607436add0/src/setup-codex-hooks.ts): 現在の新規導入はdarwin/win32に限定。Linuxで同方式が不可能という検証結果ではない。
- [Claude receiver](https://github.com/kitepon/aiterm-mcp/blob/8cfe1da43a28606ccb53acd1dbfcc0607436add0/src/claude-parent-receiver.ts): 実hookとtoolUseIdで会話を相関。出力完了と終了を記録する。現在は1依頼への1回答であり、無期限のroom購読を証明しない。
- [Cursor receiver](https://github.com/kitepon/aiterm-mcp/blob/8cfe1da43a28606ccb53acd1dbfcc0607436add0/src/cursor-parent-receiver.ts)、[背景受信](https://github.com/kitepon/aiterm-mcp/blob/8cfe1da43a28606ccb53acd1dbfcc0607436add0/src/cursor-parent-receive.ts): tool結果のIDを会話へ束縛。hookと背景受信が同じclaimを使う。確認できるclient名はcursor-vscode。claimと本文出力完了の区別はPeertableの設計で明記する。
- [Grok等で使う背景wait](https://github.com/kitepon/aiterm-mcp/blob/8cfe1da43a28606ccb53acd1dbfcc0607436add0/src/aiterm-wait-cli.ts): outcomeとexitを区別する純reader。終了だけでは成功・本文到達を意味しない。

## 公式仕様

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)、[App Server](https://learn.chatgpt.com/docs/app-server): PostToolUseでの追加文脈、Stopでの継続、実session/turn、hook実効確認を確認。外部queueの詳細はAitermが記録したOpenAI公式sourceと受入試験も参照する。
- [Claude Code hooks](https://code.claude.com/docs/en/hooks): asyncRewakeは背景で動き、exit 2の出力でidleの親を起こせる。timeoutは適用され、複数発火の自動重複除去はない。Peertableでは連続受信・再登録・timeout跨ぎを別途実測する。
- [Cursor hooks](https://cursor.com/docs/hooks): conversation_id、tool結果、additional_context、preToolUseのupdated_input、会話終了情報を確認。通常のturn終了と本当の会話終了を実測で区別する。現在の仕様にはcloudで使えるhookと未確定のhookがあるため、旧資料の『cloud全体がhookなし』を現行事実として使わない。
- [Grok Build背景処理の一次資料](https://raw.githubusercontent.com/xai-org/grok-build/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-pager/docs/user-guide/20-background-tasks.md): 親所有の背景commandと完了通知、結果回収、persistent monitorを確認。設計時には導入済みGrokの同じ配布資料も読んだ。schedulerやloopが子taskで動くことを、親自身への配送と混同しない。
- Grokの公式配布資料`~/.grok/docs/user-guide/10-hooks.md`: 実sessionId/toolUseId、PreToolUseのupdatedInput、PostToolUseのtoolResult、互換hook読込みを確認。入力変更が実際のMCP呼出し階層へ渡ることは、Peertableの第1工程で別途検証する。
- [OpenAIのLinux desktop preview](https://learn.chatgpt.com/docs/changelog#install-the-chatgpt-desktop-app-on-linux): Linuxの公式desktopでCodexを使えることを確認。旧来の『LinuxにDesktopは存在しない』を現在の受入範囲の根拠にしない。
- [Cursorの公式導入資料](https://prod.cursor.com/docs/enterprise/deployment-patterns): CLIのWindows PowerShell installerが記載されている。古いWSL限定資料だけでWindows nativeの必須行を除外しない。

公式仕様の記述、Aitermでの試験、Peertableの新機構の成立は別の証拠である。Aitermの成功をPeertableの12組合せの成功へ置き換えない。

第1工程のmacOS実測は[caller相関と背景完了の記録](phase1-macos-caller-background.md)へ保存した。Cursor/Grokの事前hook入力書換え・別会話拒否・通常TUIの2件の背景受信を観測済み。Codex queue＋同期hookと製品版の12組合せは未合格。

## 製品実装チェックポイント

第1工程後、Peertable所有の共通spool、3親MCP tool、4receiver、hook/connectと所有設定、OS adapter、runtime移行とsource監視、setup/resume/doctor/teardown、通常席除外、全件all配送を実装した。Aiterm内部moduleをruntime importしない。原文・continuation・PID開始identity・hardlink claim・unknownと不変queue受付証拠を保持する。

親の独立probeではClaude Stop継続とlease更新、Codex BUSY/STOP/IDLEが3 OSで成立した。sourceは[Claude Stop](../../experiments/parent-claude-stop-native/README.md)、[Claude lease](../../experiments/parent-claude-lease-native/README.md)、[Codex queue](../../experiments/parent-codex-queue-native/README.md)へ保存した。各`phase1-*.json`はprivate HOMEや認証設定を除いた投影である。Stop macOSとlease Linux/Windowsの投影はnative hook全文の原本回収が未完了であり、`native_hook_evidence_complete:false`を保持する。親の実測成立と、公開投影の完全性を同じ判定にしない。

親の実製品snapshotではClaude 3 OSとCodex macOSのALL/DM/MULTIが同じ会話へ届き、room deliveredまで観測された。Codex Linux/Windowsではidle・queue空からALL/DM/MULTI/LONGの各新turnを確認した。40,097 UTF-16単位・104,151 UTF-8 bytesの長文は、送信本文・room応答・spool・公式queue本文をhash投影前に完全一致で照合した。長文のStop完了は新projectのLONG 1通だけで補足した。macOSのUTF-8修理後LONG 1通も原文一致と同会話の起床を確認した。必要fieldだけを`product-snapshot-*.json`へ保存した。各runtime_digestは試験時の固定snapshotであり、最新実装と異なる。525件の最終受入へ算入しない。

Cursor/Grokの6 CLIは旧snapshotで5件失敗、Windows Grokの無改造試験は未実施だった。診断copyの受信は製品成功へ算入しない。実processと公式hook入力を確認し、CursorのNode起動option、Grok native名、system祖先の境界、Windows CursorのBOM/UTF-8、afterMCPExecutionのendpoint相関、native receiver準備後のprobe期限を製品へ修理した。hook以外のtoken設定差はfixtureの隔離であり、標準credentialの取得先を変更しない。修理版で6 CLIを再測する。GUI試験は送信前に中止し、専用Cursorウィンドウ・room serverを閉じた。Codex Desktop/IDEとCursor Desktopのlive受入は残る。

親停止時は所有endpoint索引と終了したcallerの相関を撤去し、spool本文は保持する。共有する同会話のendpointと、生きた親の未消費要求を消さない。project用hookだけで参加した親はglobal接続を所有しない。teardownで共通hookを解除する対象は、自身のpackageのconnect記録に一致する親だけとする。

親のCodex idle長文試験でroomのUTF-8断片decodeによる原文破損が再現された。`readBody`をNodeのstream decoderへ修理し、[HTTP UTF-8再現](../../experiments/http-utf8-body-repro.mjs)で40,097 UTF-16文字の日本語・emojiの途中を5箇所で分割する。POST応答、GET messages、保存logの完全一致をfocused検証する。修理前のnative idle長文試験は失敗証拠として親が保管し、成功へ変更しない。

公開前gateは`npm run verify:parent-delivery`で[実機manifest](product-acceptance.json)を検査する。3 OS・7実行面・25scenarioの525件を要求し、欠落/skip/fixture・証拠file欠落・source digest/version不一致を拒否する。現manifestは空で、公開gateは未達。gateは会話/原文/receipt等の共通証拠を機械照合し、scenario固有の実観測の十分性は親の受入監査でも確認する。実装チェックポイントと全製品受入完了を分ける。

## 配布候補の確認

最新の固定候補のsource、version、digest、製品CI、packと導入診断、公開gateの実行結果は[配布候補のチェックポイント](release-candidate-checkpoint.json)に保存する。3 OSの製品CIと正式tarballからの導入診断は成立したが、実機受入manifestの不足は残る。tarballを専用local prefixへnpmで導入した確認を、registry版のglobal installや本番反映として報告しない。

Cursorの専用Desktop projectは正式tarballから構成した。OS権限の確認は成立したが、Jevの画面取得がwindow非公開・複数windowの相関・OS inventoryのtimeoutで停止し、初回メッセージは未送信である。専用ウィンドウとroom serverは停止した。モデルの利用上限やPeertableの配送不成立と同じ原因にしない。GUI試験の操作ツール変更はオーナーへの確認中であり、CLIの正式受入runnerは独立に準備している。
