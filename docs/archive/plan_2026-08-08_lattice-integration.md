# 円卓×工程表 統合campaign（Lattice外部ペイン・チャットUI・Codex席・立卓高速化）

## Context

2026-08-08の円卓改良campaign（peertable 0.2.1）完了後、オーナーから追加5課題。①Lattice工程表
（lattice.kitepon.dev/projects/…）の右ペインに円卓チャットを編入し、卓が立っている時はそれを
デフォルトタブに ②チャットUIを一般的なチャットアプリ並みの見た目に ③参加者一覧とアクティブ演出
④CodexをAiterm経由で円卓メンバーに ⑤立卓の初動が遅いので高速化。

会話で確定した裁定:
- **①は汎用機構**: Latticeは「projectごとに外部ペイン（タイトル+URL+生存probe URL）を1枚差せる口」
  を持つだけで、Peertableを名指しで知らない（決定46の分離維持）。差す/抜くのはpeertableのsetup/
  teardown（明示的コネクタ）。project→roomの対応はsetup時点で機械的に決まる
- **公開面のnoteは掲載が正**: 「公開面はnote本文を落とす」は過剰安全側のAI遺物。未配線の
  `renderPublicTodoGanttForProject`とその意図は**削除**する（オーナー裁定 2026-08-08）
- **Codex wakeupは専用bridgeまで作る**: busy中でも素送信でCodexのキュー/steeringへ積む方式を
  第一候補に実機で確かめ、ダメならidle待ちへ落とす
- **進め方: 円卓を立ててやらせる**（親=ベル、席数=plan compileの幅）

## 調査済みの実装前提（Phase 1の要点）

- Lattice工程図は二層: 描画部品`renderTodoGanttHtml`（外部参照ゼロが`test/todo-gantt-selfcontained.test.mjs`で機械強制）と
  配信層`src/todo-gantt-live.mjs`の`liveHtml()`（CSP注入・SSE controller注入）。**タブ+iframe+CSP
  `frame-src`/`connect-src`は配信層だけに注入**し、描画部品と自己完結テストは触らない
- タブ機構は`src/todo-gantt-html-independence.mjs`の`renderRightPane()`（`data-right-panel`+`hidden`切替、
  controllerは`todo-gantt-html.mjs:130-189`の`showPanel`）。「概要」ボタンの左に追加
- project別設定の既存機構は`.lattice/project.json`（displayName上書き・`src/project-identity.mjs`）のみ
  → ここへ外部ペイン欄を拡張するのが最小
- peertable UIは`room/server.mjs:119-143`の1テンプレート文字列。CSP/X-Frame-Options/CORSヘッダは
  サーバー自体は未設定。**本番はMS-A2のdocker compose再ビルドで反映**（npm publishは配布用で別）。
  Caddyの`security-headers-base`の中身はMS-A2実機でしか確認できない（X-Frame-Options等が入っていれば
  caddy-peertable.snippetで上書き・`docker restart caddy`が正規手順）
- members APIは`{name, joined_at}`のみ。色分け・アクティブ演出はクライアント側でfrom名ハッシュと
  SSE到着時刻から導出（サーバー拡張不要）
- Codex: `~/.codex/config.toml`のproject層/`-c`上書きでstdio MCP（peertable-client）接続可。
  **envはclosed mode**（caveat確認済み・全変数明示列挙）。LAN HTTPのMCPは不可（stdioを使う）。
  起動時にdirectory trustダイアログあり。channels相当は無く、aitermの`pty_send`（agent dispatch/force素送信）
  が既存の注入経路。busy中のキュー/steering挙動は実機で要実測

## 作業項目

### Lattice側（repo: /Users/kite/Developer/Lattice）

- **L1 汎用外部ペイン機構**: `.lattice/project.json`へ任意欄
  `external_pane: { title, url, probe_url }`を追加（読取は`src/project-identity.mjs`系）。
  配信層`liveHtml()`で、設定があるprojectだけ右ペインへタブ（titleを表示・「概要」ボタンの左）と
  `data-right-panel`のiframeペインを注入し、CSPへ`frame-src <urlのorigin>`・`connect-src`へprobeの
  originを追加。**デフォルトタブ**: controllerが`probe_url`をfetchし、200かつmembers非空相当なら
  外部ペイン、それ以外は概要（probe失敗も概要）。テストは`test/todo-gantt-live.test.mjs`側へ追加、
  `todo-gantt-selfcontained.test.mjs`は不変のまま通す
- **L2 note非公開遺物の削除**: `renderPublicTodoGanttForProject`と`includeNotes`配管・
  `test/todo-note-gantt.test.mjs`の該当部・関連コメントを削除し、「公開面もnote込みが正」を
  公開契約/CHANGELOGへ記録
- **L3 release**: 0.50.0へbump→push→npm publish→global install→dashboard daemon入替→
  lattice.kitepon.dev実機確認

### peertable側（repo: /Users/kite/Developer/peertable）

- **P1 チャットUI改装**（`room/server.mjs`のUIテンプレート）: 吹き出し・名前ハッシュ色の
  イニシャルアバター・自分宛/DM/system発言のスタイル分け・タイムスタンプ。**参加者一覧パネル**
  （名前+アバター、直近発言者のパルス演出=「アクティブに仕事してる子」の可視化）。
  入力欄は置かない（決定42維持）。§11「Web UIブランド着せ替え」を消化
- **P2 埋め込み対応**: GET系API（members/messages/events）へCORSヘッダ追加。MS-A2実機で
  `security-headers-base`の中身を確認し、必要なら`deploy/caddy-peertable.snippet`へ
  frame-ancestors（lattice.kitepon.dev許可）を追記して`docker restart caddy`
- **P3 コネクタ**: setupが対象projectの`.lattice/project.json`へ`external_pane`
  （title=「円卓」・url=`https://peertable.kitepon.dev/<room>`・probe=`…/api/<room>/members`）を書き、
  `setup-state.json`へ記録、teardownが復元する（Lattice併用モードのみ。不可侵原則の例外として
  正典へ明記）
- **P4 Codex席**: SKILL.mdへCodex席の起動手順（`codex`起動+`-c`でroom MCPとenv全列挙+trustダイアログ
  通し+着任指示）、member.mdへCodex席の注記。**wakeup-bridge**（`skill/scripts/`の小さな常駐script）:
  room SSEを購読→Codex席への明示宛先だけを席ごとのキューへ→tmuxへ素送信（§16で旧broadcast経路をsupersede。busy中steering実測が
  第一候補・不可ならidle検出待ち）。生死はADR 0157の作法（pid記録+起動時掃除）、teardownで確実に停止
- **P5 立卓高速化**: `skill/scripts/launch-seat.sh <name> <model> <vendor>`（tmux作成+env注入+
  claude/codex起動+既知ダイアログの自動通過+バナー確認まで）、`skill/scripts/make-plan-input.mjs`
  （タスク定義JSONからdigest込みのplan_create入力を生成——今日手書きで2回つまずいた箇所の機械化）、
  bell着卓+kickoff投稿のhelper。SKILL.mdの手順を「聞き取り→script→着任指示」へ圧縮
- **P6 release/正典**: MS-A2でcompose再ビルド+公開面確認、npm 0.3.0 publish、決定53以降の追記と
  §11消化、会話正本アーカイブ

## 進め方

- 円卓（親=ベル・本セッション）。工程正本はpeertable repoのLattice plan（`todo migrate`不要な
  新store——前回teardownで削除済みのため`plan create`可）。席数=compileの幅（想定: L1∥P1∥P4-bridge∥P5
  で幅3〜4）。Lattice側タスクは前回t3と同じ越境1〜2 commit方式
- 受入gate=audit。親は実物照合で監査、push/publish/deployは本plan承認に含まれる
- MS-A2へのssh・docker操作は実行前に目的と対象を短く申告する

## 検証（end-to-end）

1. 新launch-seatで立卓（Claude席+Codex席を最低1つずつ）→ Codex席がroom会話へ参加・bridgeで起床する実測
2. lattice.kitepon.dev/projects/peertable/ に「円卓」タブが出る・卓が立っている間はデフォルトが円卓・
   teardown後は概要へ戻る（probe失敗経路）
3. チャットUIをブラウザで目視（吹き出し・アバター・参加者一覧・アクティブ演出・dark/light両方）
4. Lattice: focused test（gantt-live・selfcontained不変）green、peertable: 単独/併用両モードの
   setup→teardown diffゼロ維持
5. 両repoとも 完了の定義（commit→push→publish/deploy→install→実機確認）まで
