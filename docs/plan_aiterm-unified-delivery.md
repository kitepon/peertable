# Aiterm統合送信APIへの移行計画

状態: 統合配送の実装・公開版導入・Codex／Claude／Grokの実席確認は完了。Cursorのroom MCP接続原因を特定し、env補間を修理。Cursor実席の再確認を待つため現行campaignとして保持。

## 2026-09-28 時点の実測

- Cursor AutoとGrokは利用可能で、現在の利用上限はClaude系だけ。Cursor CLI `v2026.09.26-dd393fe`は任意の起動envをstdio MCPへ継承せず、明示した`${env:NAME}`だけが席情報を渡すことをprobeで確認した。[Cursor公式仕様](https://prod.cursor.com/docs/mcp)もこの補間を定義する。PeertableのCursor専用room定義へ必要な席envとcredential pathの補間を追加し、管理marker付きlegacy定義だけをensure/resumeで移行する。利用者定義の非上書きと旧定義の撤去はfocused testで確認した。CursorのMCP enableとlistは同じ席envで実行し、展開後の定義とapprovalを一致させる。

- 実装は `be71d78`、Windows fixture修正は `2fc4553`、公開前の非同期登録テスト修正は `aff6e21`。いずれも `origin/main` に着地した。
- [3環境CI](https://github.com/kitepon/peertable/actions/runs/36329329070)はmacOS・Linux・Windowsで成功。`npm pack --dry-run`は111ファイルで、旧`aiterm-deliver.mjs`を含まない。
- `v0.8.60`の公開workflowは、既存テストがMCP接続直後の会員登録完了を待たない競合で失敗した。タグは動かさず、修正を`v0.8.61`に含めた。[Trusted Publishing](https://github.com/kitepon/peertable/actions/runs/36329419231)は成功し、registryとこのMacのglobal installで`0.8.61`を確認した。
- ソース版の隔離卓で、Grokの待機中配送、観測`unknown`のClaudeへの配送、実行中Codexへの`agent_steer`配送を確認した。各メッセージのroom receiptが`delivered`となり、受信席が識別子を含む返信を投稿した。
- 公開版だけで作った隔離卓では、`peertable resume`が2席のheartbeatと配送probeを確認。CodexからClaudeへのDM #7は`agent_dispatch`で受理され、roomの`delivered`とClaudeの識別子付き返信が一致した。`peertable diagnostics <project>`は`ready`。両試験卓は正規teardownで解散した。
- Cursor席は最初の実行が月間利用上限で止まり、別モデルではCursor CLIの`room` MCPが`Connection failed`となった。Peertableの`pty_send`へ渡す前にroom参加登録が成立していないため、Cursor実席の配送成否は未確認。利用可能なCursorセッションでroom MCP接続を診断し、参加・待機中・実行中の配送を確認してから本計画をarchiveへ移す。

## 目的と完了条件

Peertableのメンバー間配送をAitermの公開`pty_send`へ統一する。実行中の差し込みと待機中の新規ターンの選択、TUI操作、ターン相関はAitermが所有する。Peertableは宛先、本文、配送順序、未処理メッセージ、配送receiptを所有する。

完了条件は次のすべて。

- Claude Code、Codex CLI、Grok CLI、Cursor CLIの通常席へ、待機中・実行中とも同じ呼出しで配送できる。
- 廃止された`agent_steer` toolの呼出し、harness別のbusy分岐、Grokのidle待ち、配送ごとの外部スクリプト・一時ファイル・待機プロセスを撤去する。
- 新規ターンと差し込みの正常receiptを受理し、通常PTYへの素送信、送信失敗、成否不明を配達成功にしない。
- bridgeが制御する再試行・再接続・再起動で、成功済みと成否不明のメッセージを自動再送しない。
- 公開packageを対象端末へ導入し、正規`resume`からbridge更新、実配送、roomのreceipt表示まで確認する。

## 着手時の範囲

実装はPeertable内の配送処理、直結する試験、利用文書、release metadataに限定する。roomの保存形式・API・Web UI意匠、親の`parent_watch`、配置表、着席方式は維持する。Aitermの内部state・Stop hook・画面判定をPeertableへ移さない。

Lattice工程の導入とSolの起動はこの計画作成には含まない。後続の実装依頼で明示されない限り、Lattice storeを変更しない。

調査開始時に`room/server.mjs`の未コミット変更、未追跡の`.worktrees/`と`docs/brand-landing-refresh-20260905.md`があった。実装担当は開始時にstatusを取り直し、他作業の差分を保持する。隔離が必要ならアプリの管理worktreeを使う。commitは対象pathだけをstageして行う。

計画作成時のローカル文書検査は、既存の未追跡`.worktrees/`配下まで走査して古い文書のリンク切れ4件を報告した。これは配送修理の範囲へ追加しない。実装担当は隔離したcheckoutの検査結果と、元の作業ディレクトリの既存失敗を区別して報告する。

## 調査根拠

2026-09-27に確認した固定snapshot。現役versionの正本としては使わず、実装開始時に公開packageと実行中MCPを照合する。

- Peertable調査commit: `658114911a98c510c2657f06fef4524b51bbabed`。
- Aiterm調査commit: `2fa450ef3c170c39ff10a0543d3598ca5567d630`。npm registryの公開版は調査時点で`0.41.2`、ローカルstdio MCPの応答は`0.41.1`だった。
- 現行`aiterm-deliver.mjs`へ存在しない試験sessionと`--mode=steer`を渡すと、exit 1、`MCP error -32602: Tool agent_steer not found`となった。稼働席には送信していない。
- [Aitermの公開送信実装](https://github.com/kitepon/aiterm-mcp/blob/2fa450ef3c170c39ff10a0543d3598ca5567d630/src/index.ts#L273)は、両経路を`aiterm.pty-send-result.v1`で返す。`agent_steer`はreceiptのmode名として残るが、tool名としては存在しない。
- [送信時の振分けとSteer失敗](https://github.com/kitepon/aiterm-mcp/blob/2fa450ef3c170c39ff10a0543d3598ca5567d630/src/core.ts#L4352)はAitermが所有する。`STEER_NOT_QUEUED`は新規ターンとして既に送られた可能性、`STEER_STILL_QUEUED`は後で実行される可能性を明示している。
- [ClaudeのStop hook](https://github.com/kitepon/aiterm-mcp/blob/2fa450ef3c170c39ff10a0543d3598ca5567d630/src/claude-stop-hook.ts#L176)が完了記録後にoperation markerを消費する。[aiterm-wait](https://github.com/kitepon/aiterm-mcp/blob/2fa450ef3c170c39ff10a0543d3598ca5567d630/src/aiterm-wait-cli.ts)は読み取り専用である。
- Aiterm repoで`node --test --test-name-pattern='secure markerのoperation_idをresultとeventへ同一相関し消費する' test/managed-stop-hooks.test.mjs`を実行し、1件成功した。4種の実席配送は未実施。

## 実装方針

### 1. 単一の送信呼出し

`wakeup-bridge.mjs`の既存`AitermClient`接続を使い、宛先sessionと整形済み本文だけを渡す。

```js
await aiterm.structured('pty_send', {
  session_id: sessionId,
  text,
  enter: true,
}, 'aiterm.pty-send-result.v1')
```

`force`、`mark`、harness別キー操作、呼出し側で選ぶ送信modeを追加しない。席単位の既存`flushing`とメッセージ順序は維持し、別席の配送を全体で直列化しない。

bridgeのready確定前に、一度だけ公開`tools/list`から`pty_send`の統合schemaと`agent_dispatch`／`agent_steer`対応を確認する。旧APIへの切替は行わず、不足は`PEERTABLE_AITERM_CONTRACT_UNAVAILABLE`として更新方法を示す。照合はAiterm接続を所有する箇所へ集約し、汎用の互換frameworkや毎回のversion照会を作らない。

この照合とagent receiptの受理条件はメンバー配送に適用する。bridge自身を起動する通常PTYへの`pty_send`は`mode=sent`が正常なので、共通clientの全呼出しへagent専用の制限を加えない。

公開`pty_observe`による生存・既知承認の確認は既存用途で維持する。観測したbusy／idleを送信方法の選択には使わない。観測後に状態が変わっても、呼出し回数は1回である。

### 2. receiptの解釈

| 公開結果 | Peertableの処理 |
|---|---|
| `mode=agent_dispatch`、送信エラーなし、`submit_residue !== true` | 配達成功として既存の保存・receipt更新へ進む。回答完了は待たない |
| `mode=agent_steer` | 差し込み成功として同じ保存・receipt更新へ進む。`event_cursor=null`、`wait_process=null`は正常 |
| `mode=sent` | 通常PTYへの素送信なのでメンバーへの配達成功にしない |
| schema欠落・不一致、未知mode | 外部API契約エラーとして明示する |
| `submit_residue=true`、MCPエラー、応答喪失 | 配達成功にせず、次節に従って再試行可否を扱う |

ログの送信modeは要求時の推測値を廃止し、receiptの実値を記録する。receiptは入力の受渡しを表し、メンバーの読了・回答完了とは区別する。Steerにcursorやwaiterを要求しない。

エラー・schema違反・`submit_residue=true`を先に判定してからmodeを受理する。modeだけを見て失敗を成功へ変換しない。

### 3. 送信後の成否不明と再送

送信前に席不在・着任中・既知承認などで止めたものは、既存のpendingと再試行方針を使う。`pty_send`を呼び出した後は、APIが未送信を明示した場合だけ自動再試行を許す。

`STEER_NOT_QUEUED`、`STEER_STILL_QUEUED`、本文残留、送信後の通信切断・timeout・解釈不能な応答は、送信済みの可能性を残したまま保留する。文字列の曖昧な部分一致から「再送して安全」と推測しない。新しいTUI解析や独自の再送判定器は作らない。

- roomへ既存の`failed` receiptと識別可能なreasonを記録し、同じ(seq, 宛先)への自動送信を止める。
- 保留対象は既存の`.team/wakeup-bridge-delivery.json`へ追加fieldとして保存する。旧fileでは空として読み、別の台帳を増やさない。保存するのはroom正本から再取得できる本文ではなく、再送を止める対象と理由だけにする。
- 成功を表す`delivered`集合へ保留対象を混ぜない。再起動、SSE再接続、`resume`だけでは保留を解除しない。他席・後続メッセージの配送は続ける。
- 読了ackで確認できた対象は既存`acked_read`経路で解消できる。ackが無いものは、公開APIで実受信を調査してから再送を判断する。保留解除用の独立製品や自動再送サービスは追加しない。
- 既存の親への失敗通知は通常「2回目の失敗」で出る。今回の再試行しない保留だけは初回で通知し、既存の耐再起動`notified`管理で重複を防ぐ。通常の一過性失敗の通知頻度は変更しない。
- 保留の記録保存に失敗した場合は、同じ本文を送信し直さず永続化失敗を明示する。記録だけの再試行と本文の再送を混同しない。

公開APIが未送信を識別できない場合、Peertableで安全な再送を推測せず保留する。自動回復に追加契約が必要なら、最小再現と必要な応答fieldをAitermへ渡す。Aiterm本体の追加改造をこの計画へ無断で広げない。

ここで保証するのは観測できた結果に基づく再送制御である。送信成功とPeertableの保存の間でprocessが突然消える場合まで、完全な一回配送を実現したとは報告しない。その保証には送信所有者との冪等性契約が必要になる。

### 4. 撤去する処理と維持する処理

撤去するもの:

- `aiterm-deliver.mjs`と、その起動・本文一時fileの作成／削除。
- `--mode=dispatch|steer`、旧`aiterm.agent-steer.v1`判定、`delivery=idle`からの二重呼出し。
- Codexのbusy分岐、`shouldDeferGrokWake`、`deferredBusy`。
- 配送のたびに`wait_process`を起動する処理と、旧Stop回収の説明。

維持するもの:

- 着任指示が成立するまでの`isSeatLaunching`、宛先解決、席別の順序とまとめ配送。
- `parent_watch`の除外、自己待機DMの除外、読了ack、成功済み対象の再送抑止、取りこぼし回収。
- 生存確認、既知承認の公開API、着任時の実ターン開始確認。
- roomの配送receipt形式、通常の席不在に対する復旧待ちと既存の通知規則。

`launch-seat.mjs`の着任確認で使うwaiterは配送用waiterと用途が異なるため、今回まとめて消さない。削除前に文字検索とsensorの依存関係を併用し、動的script呼出し・npm配布対象も確認する。

## 変更ファイル

| 対象 | 変更 |
|---|---|
| `skill/scripts/wakeup-bridge.mjs` | 統合送信、旧分岐撤去、receipt判定、保留の保存と通知 |
| `skill/scripts/aiterm-client.mjs` | 公開送信契約を接続時に照合する小さな入口。共通MCPエラー処理を再利用 |
| `skill/scripts/wakeup-delivery.mjs` | Grok固有の保留関数・古いコメントを削除。試験に必要なら送信結果の小さな純粋関数をここへ置く |
| `skill/scripts/aiterm-deliver.mjs` | 消費者確認後に削除 |
| `skill/scripts/wakeup-delivery.test.mjs`（追加） | 公開receipt・送信契約・再送判定のfocused test |
| `experiments/aiterm-unified-delivery-repro.mjs`（追加） | ローカルroom＋MCP fixtureでbridgeの配送・永続化・通知を確認する最小再現 |
| `experiments/wakeup-delivery-repro.mjs` | 旧Grok保留期待を削除し、既存の本文・宛先試験を維持 |
| `experiments/wakeup-bridge-grok-idle-repro.mjs` | 旧契約のfixtureを退役。新しい統合配送試験へ置換し、参照を更新 |
| `skill/scripts/runtime-contract.test.mjs`、`scripts/run-product-ci.mjs` | 新規試験を既存CIへ接続。重複実行しない |
| `skill/SKILL.md`、`docs/current-design.md`、`README.md`、`README.ja.md` | 統合送信、保留の見え方、必要な公開APIを記述。古い最低版の案内を更新 |
| `package.json`、`package-lock.json` | release時のversion同期 |

試験を可能にする抽出は配送の小さな関数に限り、bridge全体をframeworkへ作り直さない。文書には変動する最新versionを複製せず、必要な公開API契約を説明する。実機確認で用いた版は証拠へ記録する。

## 作業順序と検証

### A. 現行差分と依存の確認

1. `git fetch`後、既定ブランチとの差分と他作業の変更を確認する。
2. Aitermの現行公開版と実際のMCPのversion、`pty_send`のschemaを確認する。調査時の受入基準は`0.41.2`であり、より新しい版なら変更点を確認する。更新はAitermの標準入口だけを使う。
3. 廃止toolの失敗を、存在しない試験sessionで再現する。稼働席へ確認用本文を送らない。

### B. 最小試験から実装する

新しい試験は現行コードで失敗することを確認してから実装する。MCP fixtureの送信toolは`pty_send`だけとし、`agent_steer` toolを公開しない。観測・承認の公開toolには試験に必要な最小応答を返す。TUIやtmuxを模倣せず、Aitermの公開境界を模す。

| 試験 | 受入条件 |
|---|---|
| 4 harness × busy／idle | 同じ`pty_send`へ1回送信。busyのGrokも保留しない |
| 観測と送信の間の状態変化 | Aitermが返したmodeを採用し、呼出し側の切替再送をしない |
| dispatch／steer receipt | 両方成功。Steerのnull cursor・waiterを拒否しない。外部waiterを起動しない |
| 旧API・schema不足 | bridge ready前に更新が必要と明示し、本文を送信しない |
| `sent`、残留、schema違反、応答喪失 | `delivered`を記録しない。送信後成否不明は自動再送しない |
| 保留後の再起動・再接続 | 同じ(seq, 宛先)を再送しない。成功済み別宛先へも重複送信しない |
| 保留と通知 | 初回でfailedと親通知が出る。再起動後も通知は重複しない。後続配送は続く |
| 保留の保存失敗 | 永続化失敗を明示し、記録の再試行から本文の再送が発生しない |
| 読了ack | 既読は追加送信せず`acked_read`で解消する |
| 着任中、親、自己待機DM | 従来の配送順序と対象除外を保つ |

focused testの実行入口は次を基本とする。

```sh
node --test skill/scripts/wakeup-delivery.test.mjs
node experiments/aiterm-unified-delivery-repro.mjs
node experiments/wakeup-delivery-repro.mjs
```

既存の着任・承認処理へ変更が必要になった場合だけ、そのfocused testを追加実行する。変更のないgreen testは反復しない。

### C. 実席受入と最終CI

隔離した試験projectと試験roomで、`peertable setup`／`launch`から4種の席を用意する。実際のroom MCPを使ってメンバーから別メンバーへ一意の本文を送り、受信者のroom返信で受信を確認する。

- 待機中と実行中の各席へ届け、roomのmessage seq、配送receipt、受信者の返信を対応付ける。
- Claudeは「新規ターン→実行中の差し込み→完了後の次メッセージ」を確認し、配送用waiterが無くても連続配送が成立することを測る。
- 再起動時の配送重複は制御可能なfixtureで検証し、実席に障害を注入して繰り返し起こさない。
- 試験資産は正規teardownで片付ける。API上限・認証不備で試せないharnessを成功扱いしない。

最終確認は`node scripts/run-product-ci.mjs`を1回、文書検査は既存の`npm run test:docs`で行う。既存CIのmacOS・Linux・Windows対象を維持する。新規fixtureはNodeと公開MCPだけで動かし、OSごとのTUI fixtureを増やさない。

## 公開と稼働卓への適用

1. versionを上げ、`npm pack --dry-run`で旧配送スクリプトが消え、新しい必要ファイルが入ることを確認する。
2. 対象限定commitとpushを行い、既定ブランチへの着地と製品CI成功を確認する。公開commitが`origin/main`の祖先であることを確認する。
3. `v<version>` tagをpushし、既存Trusted Publishing workflowで公開する。手元の`npm publish`は使わない。
4. 公開版を対象端末へ標準global installし、`peertable diagnostics`でスキル配置を確認する。
5. 対象projectごとに`peertable resume <project>`を実行する。既存runtime digestによるbridge更新、ready、heartbeat、配送probeの成立を確認する。手作業のbridge再起動手順を利用者へ要求しない。
6. 実際のメンバー間配送を1往復確認し、公開roomのreceiptと照合する。`resume`のprobeだけを実受信の証拠にしない。

今回はbridgeの更新が本番反映に当たる。room実装とDocker imageの内容が変わらなければ、roomコンテナの再配置は不要と報告する。room変更が必要と判明した場合は範囲を説明し、[deploy手順](../deploy/README.md)に従う。

公開済みnpm版の欠陥はfix-forwardする。旧Peertableは現行Aitermの廃止APIを呼ぶため、直前版へ戻すだけで復旧するとは判断しない。緊急時は影響するbridgeの運用停止と失敗の可視化を行い、確認済みの互換組合せだけを復旧候補にする。

## 実装担当の最終報告

- 変更commitと公開version、導入端末・対象project。
- 廃止した制御、残したPeertableの責務、実際の差分量。
- focused test、CI、4種の実受信、公開後smokeの結果。未実施は理由付きで明記。
- 保留中の配送や外部依存の未解決があれば、対象と必要な次の操作。
- 完了時は本計画を`docs/archive/`へ移し、文書地図のリンクも更新する。
