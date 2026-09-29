# 親への配送をAitermと同じ方式にする

## Decision

親宛のroom発言は、Aitermが子の回答を親へ届けるのと同じ方式で届ける。受け口・hook・親の特定は、Aitermから切り出した共通パッケージ`aiterm-steer-delivery`を使う。Peertableはroomの見張り、配送記録、宛先別receiptだけを持つ。

オーナー指示（2026-09-29）: 「Peertableの親へのメッセージをAitermと同じ方式にしたいだけ」「peertableの親配送に共通モジュールを適用しないといけない」。

## 変えたこと

- Codex・Claude Code・Cursorの受け口、hookの中身、親の特定をパッケージへ置き換えた。Grokはパッケージの背景受信（Aitermの`wait_process`と同じ）で受け取る。
- Aitermは依頼1回に回答1回。roomの発言は何通も届くので、パッケージのchannel（同じ会話へ何通も送る受け口）を使う。Claude Codeはturn終了のStop hookで待機を張り直す点だけがAitermとの違いで、受け口の仕組み（asyncRewake）は同じ。
- Peertable独自のhook_context_id相関、耳疎通probe、待機slot、lease、`parent_read`のページ分割、旧方式の実機受入manifestによる公開gateはやめた。Aitermに無い仕組みで、修理が次の修理を呼んでいた。
- `peertable connect`は旧方式のhook（`parent-hook.mjs`）を取り除き、パッケージのhookを登録する。

## 確認

- パッケージ: 各受け口の試験と、Aitermの配送試験一式（公式Codexのqueue＋hook試験を含む）。
- Peertable: 配送記録の試験、実SDKのstdioで`parent_join`から背景受信・receipt・`parent_leave`までの通し試験、既存のreceipt repro。
- 各harnessの実機での受信はリリース前に確認し、結果を記録する。
