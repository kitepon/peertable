# 親セッションの公式受信口

取得日: 2026-09-28。確度: Aitermのsource確認、公式仕様と配布資料の確認。Peertable新方式の実機成立は未検証。

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
