# skill導入と公開依存変更の受入

## Decision

Peertableのskill導入入口、明示projectのsetup/resume、Aiterm公開APIへの移行を受け入れる。別製品の内部state・namespace・backend・TUI補正をPeertableへ実装せず、必要な能力はAiterm所有者が公開した。

公開後のWindows実機で発見した参加通知と着任指示の競合は、配送順序を所有するPeertableで修理した。起動から初回指示の成立まで通常通知を保持し、中断記録は退席で解除する。Grokの読取反証を通し、focused試験と実機確認が成立した。

最終版0.8.57の既定ブランチ統合、npm公開、3 OSへの公式導入、既存設定保持、実harnessの投稿・同一session設定変更・DM応答・再開・解散・履歴と元MCP保存がすべて成功した。room本番は新imageで稼働し、既存履歴、公開API、SSEの確認も成功した。未達の受入はない。

証拠は[公開版の受入記録](../../evidence/skill-install-aiterm-boundary-20260910/published-acceptance.md)と[反証・機能確認](../../evidence/skill-install-aiterm-boundary-20260910/refutation-and-focused.md)に保持する。本裁定文書は追記更新せず保持する。
