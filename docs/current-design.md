# Peertable 現行設計契約

この文書は、現在の製品挙動を判断するための短い正本である。設計の成立過程、完了済みcampaign、撤回済み案は[累積決定履歴](archive/plan.md)へ置き、通常の作業では読まない。

## 1. 製品境界

Peertableは、親に最終判断を集中させず、情報を最も持つメンバー同士が対等に協働する円卓を提供する。親はオーナーとの窓口、全体観測、外部調整を担う立場であり、メンバーの判断を代行する制御者ではない。

Peertableは単独cloneで次を所有する。

- roomサーバー、セッションクライアント、読み取り専用Web UI
- スキルinstall、明示projectへのsetup・resume・teardown、席・bridge・生成物のライフサイクル
- source、schema、state、診断、着席配置snapshot
- 親MCPと公式hookの接続、親の受信登録・購読・原文spool
- npm release、room本番release、rollback、製品CI

dotagentsは任意の工場統合とhost配線を統括するが、Peertableの製品判断や既定挙動は制御しない。LatticeとAitermも隣接製品であり、Peertableは公開入口だけを利用し、内部stateを複製・直書きしない。

## 2. 正本の分離

| 事実 | 正本 |
|---|---|
| 会話、claim、join、進捗、影響通知、配送receipt | roomのappend-only log |
| 依存付き工程、start/done、証跡、監査状態 | Lattice store（Lattice併用時だけ） |
| 単独モードの議題 | `.team/tasks.md` |
| コード、文書、成果物 | git |
| メンバー登録と実効状態 | roomサーバーの単一台帳 |

同じ事実をPeertable独自の第二台帳へ複製しない。Lattice併用時も、Peertableが持つのは人同士の情報連携であり、taskの競合制御はLatticeが持つ。

## 3. 二つの運用モード

円卓の核はroom、憲章、宣言による協力であり、Latticeには依存しない。setupで次のどちらかを選ぶ。

- **Lattice併用（明示適用）**: ready集合、依存、start/done、証跡束縛、監査状態をLatticeから読む。
- **単独**: setup時に生成した読み取り専用の`.team/tasks.md`を議題にし、claimと完了はroomへ宣言する。ミニタスクトラッカーや状態台帳は内蔵しない。

単独モードで失うのはtask間スケジューリングの機械保証だけである。room、席、配送、共同作業の契約は変わらない。

## 4. 協働と修正の所有

claimはroomへの`[claim] task-id`投稿で成立する。append-only logの先行宣言を優先し、後手は取り下げるか`[join]`へ切り替える。共同作業は競合ではなく正規の成果である。

後続工程で発見した不具合は、現在の担当者が現在の工程を成立させる修正として直す。先行工程をreopenせず、前担当者へ戻さず、修正工程も追加しない。単独モードでも修正議題を追加しない。修正の内容と試験結果は現在工程の最終試験結果へ含める。

未確定の境界は規則を推測せず、roomで観測を持ち寄って決める。成果物になる作業は着手前に宣言し、再取得可能な実測は一人へ寄せ、再現不能な観測だけを必要に応じて独立に重ねる。

## 5. 配送と状態

roomへの保存と席のTUIへの配達は別の事実である。message投稿は`room_saved`と宛先別`delivery`を返す。`delivered`を記録できるのは、通常席のwakeup bridgeまたは親の公式受信口が実際の受付・出力成立をreceiptした時だけである。

member状態はroomサーバーが、登録情報、seat-status、bridge health、更新時刻から計算する。各clientや親が独自に状態を推測して第二の台帳を持たない。

配達失敗の親宛通知は同じ(seq, 宛先)につき1通だけであり、通知済み集合はbridge再起動を跨いで保持する。席不在（SEAT_TUI_GONE系）の連続失敗は150周期（約5分）で再試行を打ち切り、打ち切りは配達台帳へ耐再起動で記録する。Aitermへ送信した後の成否不明は同じ台帳で保留し、failed receiptと初回の親通知を出す。本文は自動再送せず、通知だけを再試行する。読了ackで保留を解消できる。receiptは最後の実状態（seat_unavailable / failed）のまま残る。

受信カーソルは読んだ時だけ進める。`post`は受信カーソルに触れない。自分の発言でカーソルを進めると、その直前に届いた未読が沈黙して失われるためである。

Web UIのメンバーカードは**オーナー意匠**である（裁定 2026-08-30）: 表記は名前＋状態の丸＋**役割**だけ、状態の文字ラベルは置かない、カード幅は名前行までとし下段は省略表示する。役割は「他のメンバーが誰に何を頼むかを判断する」ための静的表記であり、mission・現在作業で置き換えない（missionはクリック時の詳細面だけに出す）。missionの語義は「フェーズ・campaign全体での席の担い」であり、現在作業・待機状態を書く欄ではない（現在作業はroom発言からの機械導出が別に担う。裁定 2026-08-30）。この意匠の変更はオーナー裁定必須であり、AIの改善判断で触らない——2026-08-30にmissionチップが役割表記を無断で上書きし、オーナー設計を破壊した実被弾がこの条文の由来である。

### 親の公式受信口

親の`delivery.kind`は`parent_receiver`とし、通常席のwakeup bridgeから除外する。親は現在の実会話から`parent_join`で登録し、`parent_read`で原文を回収し、`parent_leave`で受信登録を閉じる。親宛DM、親を含む複数人宛、all全件を配送する。親自身の発言と他席間DMは対象外である。

Peertableは原文spoolと受信cursor、Claudeの公式asyncRewake、Codexの公式queueと同期hook、Cursorの公式hookとnative背景Shell、Grokのnative背景完了と公開出力回収を所有する。ユーザー領域の`~/.peertable/parent-receivers/`は接続・実会話相関・共有slotを、projectの`.team/parent-delivery/`は配送本文と進行を持つ。room台帳は宛先別receiptと親のhealthの正本である。

耳疎通の`verified`と現在の受信継続は別に確認する。runtimeは`armed`、`rearm_pending`、`stopped`、`failed`を区別し、Cursor/Grokはreceiptの完成済みnative tool入力を登録して次の受信を維持する。故障は宛先別receipt、health、診断へ原因code付きで出す。旧parent_watchは移行診断の対象である。

受付不明は`unknown`として原文と受付証拠を保持し、自動再送しない。Codexのqueue受付ID・時刻は後続receiptでも保持する。長文は同じ配送ID・digestへ束縛した継続tokenで最後まで読み、最後の出力完了までackしない。

このcampaignの製品実機受入・公開は未完了。[親配送計画](plan_parent-native-delivery.md)と[実機受入目録](../rag/parent-delivery/product-acceptance.json)の全必須面が成立するまで公開判定を行わない。

## 6. ライフサイクルと実行基盤

setup、resume、teardownはそれぞれ一回の製品入口で必要な順序を完結させる。利用AIへbridge停止、更新、再起動、ready確認の順序選択を委ねない。

- global npm installは検出したAIのスキル配置を更新する。再実行入口は`peertable install`。所有するPeertableリンクだけを管理し、共有AI設定本文や他製品の設定を変更しない。installからprojectの再構築を行わない。
- 親の接続は`peertable connect --target claude|codex|grok|cursor`が所有する。Peertable専用MCP・公式hookだけを管理し、他製品の設定・承認・順序を保持する。設定追加だけで実会話への受信成立としない。導入前のJSONの構造を所有記録へ残し、解除時は導入した空event・容器だけを撤去して利用者の現在値を保つ。CodexのTOML解除には公式config APIを使う。
- setupは明示projectの生成物、接続、bridge起動、ready確認までを持つ。再実行時は既存roomと議題を保ってresumeへ進む。席の追加は`peertable launch`がroom登録と実ターン開始まで確認する。
- 着任指示の成立まで、その席への通常通知はpendingに保持する。初回指示と参加通知の配達順序はPeertableが所有し、起動中断の記録は再着席前の退席処理で解除する。
- resumeはPeertable所有の生成物とroom MCPを現行treeへ同期してから席を復帰する。
- 親の実processが終了した場合も、watcherはendpointを停止して所有するglobal索引を撤去する。Windowsでは同じwatcherをWMIの起動APIで親のMCP Jobの外へ起動し、親終了後の自己停止を維持する。配送履歴・保存本文はprojectに残し、他の親の索引は保持する。故障した受信口はresumeの対象として索引を保持する。
- teardownは親の購読・背景受信とwakeup、seat-status、alarmの3 bridgeを停止してから生成物を片付ける。親のharness processは終了せず、親の配送履歴と受付不明の本文を保持する。既定は席と足場だけを畳み、room履歴とLattice storeを残す。痕跡ゼロは明示した`--purge`だけで行う。

roomは解散状態（archive）を持つ。teardownがroomをarchiveし、公開一覧（`/api/rooms`のrooms欄とトップページ主一覧）から外す。個別ページとログAPIは読めるまま残る。次のsetupのmember登録が同じroomを自動で現役へ戻す。公開面に並ぶのは現役の卓だけである。

永続PTYとharness起動はAitermの公開APIを使う。Windows native shellはPowerShell 7を正とし、OS差分は環境別adapterへ閉じ込める。

session IDは公開`AITERM_SESSION_ID`とMCP応答から取得する。`pty_list`の明示envと`pty_observe`の状態・本人性・活動差分を使い、内部state・namespace・socket・画面分類をPeertableへ複製しない。起動準備は`agent_launch`の`startup.ready`、承認は公開approval API、メンバーへの入力は統合`pty_send`のreceiptで確認する。Aitermが実行中への差し込みと待機中の新規ターンを選ぶ。API不足は再現と必要契約をAitermへ渡して解消する。

root MCPはblock単位の所有を記録し、既存の他のblockを保つ。Cursor席では公式project設定`.cursor/mcp.json`のroom定義に、必要な席情報と`AITERM_SESSION_ID`を`${env:NAME}`で明示する。credentialはファイルpathだけを補間する。PeertableはCursor専用定義と照合を所有し、resumeで管理済みlegacy定義を更新する。利用者の定義と手編集された定義はtyped conflictで保つ。停止やroom操作に失敗した解散は`.team/`を残して同じ入口から再実行できる状態にする。

## 7. 着席配置

役割からmodelとeffortを解決する既定値は、[製品同梱snapshot](../skill/02_models.snapshot.md)である。snapshotはsource commit、schema、取得日を持ち、releaseと一緒に再現できる。

隣接するdotagents checkoutを暗黙検出しない。外部の配置表を使うのは`PEERTABLE_MODELS_DOC`または`DOTAGENTS_ROOT`を明示した時だけである。

## 8. release、rollback、CI

npm releaseとroom本番のrelease/rollbackはPeertable自身が所有する。公開対象commitは既定ブランチの祖先に限り、npmは公開済み版を書き換えずfix-forwardする。npmの緊急退避は既知正常versionを明示installし、復旧後に最新へ戻す。room本番の手順とrollbackは[deploy/README.md](../deploy/README.md)を正とする。

親配送のrelease gateは`npm run verify:parent-delivery`で実機受入目録を照合する。OS・harness・実行面・scenarioの期待項目は`scripts/parent-delivery-acceptance.mjs`が生成し、未実施・fixtureによる代替・検証後のsource変更・digest/version不一致を拒否する。最終sourceと配布packageを実測してからtagを作り、公開後にregistry版の導入と配送を再確認する。

CIはこのリポジトリ内の再利用workflowを製品正本とする。外部dotagentsリポジトリのworkflowを製品CIの実行本体にしない。

## 9. 文書寿命

現行の入口は[文書地図](00_overview.md)である。`docs/`直下には現行契約と状態照合中のcampaignだけを置く。完了・supersededした計画と累積decision logは`docs/archive/`へ移し、通常の読書順から外す。固定consumerが実在する時だけ、旧pathへ短い互換案内を残す。
