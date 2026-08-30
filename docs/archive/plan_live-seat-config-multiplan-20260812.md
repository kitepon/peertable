# Peertable 稼働席設定変更・複数PLAN campaign — 計画正本

本書は `live-seat-config-multiplan-20260812` campaign の目的と裁定を記録する。工程状態の正本はLattice storeである。
既存のroom、メンバー席、`peertable-autonomy-runtime-20260811/t4`、同taskのpull runと未commit差分を保持し、
本campaignから変更・完了・破棄しない。

## 1. 目的

1. Aitermの公開MCP tool `agent_configure(session_id, model?, reasoning_effort?)`をPeertableの入口から呼び、
   稼働中のClaude／Codex席のmodel／effortを同じsessionと会話contextのまま変更する。
2. 一つのroomと同じ長寿命メンバー群が、同じLattice store内の複数PLANを完全修飾して扱えるようにする。
3. Codex席の着席時に`wakeup-bridge`を機械的に装備する。
4. Sol監査専任席を`auditor`役割として維持する。

## 2. 設計判断

### 2.1 稼働席設定変更

Peertableはvendor TUIを直接操作せず、Aitermの公開`agent_configure`を呼ぶ薄い入口だけを持つ。Peertableが
保持するAiterm `session_id`を渡し、成功receiptに従ってroom memberのmodel／effortと変更履歴を更新する。
同一vendorの設定変更で席を再起動せず、Aitermの失敗を再起動や別modelへのfallbackで隠さない。vendor変更だけは
従来の再着席経路に残す。

### 2.2 複数PLAN

`setup-state.json.plan_key`と`PEERTABLE_PLAN`は初回着任時の既定値であり、卓が扱えるPLAN数を制限しない。
操作対象は`<plan_key>/<task_id>`で完全修飾する。新PLANの追加にteardown、setup、席再起動、既定PLANの
破壊的書換えを要求しない。既存のroom、メンバー、bridge、credential、`.mcp.json`をそのまま使う。

### 2.3 着席時の機械装備

Codex席を立てる正規経路が、同じroomの`wakeup-bridge`を冪等にensureする。AIや親が手作業でbridgeを補うことを
正常系にしない。監査専任席はlaunch入力とroom member metadataで`auditor`を保持し、実装工程をclaimしない。
役割省略時は互換の`worker`とする。capacity機能はオーナー裁定により製品から削除する。

### 2.4 作業・試験・監査の試行運用

作業者は自ら必要な試験と自己監査を行い、次工程へ進めてよい完成度まで仕上げ、最終試験結果を監査担当へ渡す。
監査担当は試験を再実行せず、提出された試験内容と結果が妥当か判断して工程を閉じ、「次の工程に着手してください」
とだけ指示する。具体的な次工程はLattice正本から作業者が選ぶ。本campaignでこの運用を観察し、恒久規範への反映は
オーナー裁定後に行う。

`done.sh`が証跡本文の監査文言や別席receiptを要求するgateは廃止済みである。監査のために成果や証跡を変更し、
その変更を再監査する自己参照ループを作らない。

### 2.5 非目標

- Lattice、Claude Code、Codex CLI本体は改造しない。i1の実席でAiterm公開`agent_configure`自身の
  長寿命Codex ready誤判定が確定したため、オーナーの明示指示によりAitermの所有repoで根治する。
  Peertable側へ再描画・再試行・fallbackは置かない。
- npm version bump、publish、本番deployは行わない。
- 旧`t4`の修理や監査は行わない。
- 実証されていない安全装置、追加gate、wrapper、独自launcher再構築は加えない。r1はAiterm公開launchを呼ぶ
  最小配線だけを対象とする。

## 3. Lattice工程

### c1 Aiterm公開面へのPeertable実席接続をfocused testで確定する

- Lattice正本を参照。

完了済み。Aiterm `agent_configure`がAiterm管理下のCodex sessionで、同じ`session_id`を保ったまま
model-only、effort-only、同時変更を受理する境界を証拠化した。

### c2 稼働席のmodel／effort変更とroom同期を実装する

- Lattice正本を参照。

所有: `skill/scripts/change-seat.sh`、必要な最小adapter、`room/client.mjs`、focused harness。

Peertableが席のAiterm `session_id`を保持し、既存の公開`agent_configure`へ渡す。成功時だけroom memberの
model／effortと履歴を同期し、同一sessionとcontextが維持されることを作業者がfocused testと自己監査で確認する。
案内同期と実席往復はこの工程へ含める。wrapper、room専用MCP設定、launcher置換は作らない。

### m3 done・証跡・run操作を呼出しPLANで束縛する

- Lattice正本を参照。

完了済み。`done.sh --plan`がshow、run、evidence、doneを呼出しPLANへ束縛し、証跡本文のpeer audit文言gateを
削除した。別PLANに同じtask idがあっても明示PLANを使う。

### m2 複数PLAN・着席装備・監査席役割を実装する

- Lattice正本を参照。

依存: c2、m3。所有: setup／launch／role／案内の必要箇所とfocused harness。

この工程は次の三成果だけをまとめて実装する。

1. 同じroomと席が、setupをやり直さず複数PLANの完全修飾taskを扱う。
2. Codex席の正規launchが`wakeup-bridge`を機械的に装備する。
3. `auditor`役割をroom member metadataへ保持し、Sol監査専任席を維持する。

必要な案内・正典の同期と、修正前の原因を再現するfocused testもこの工程に含める。別のdiscovery工程、
文書だけの完了gate、細分化した確認機構は作らない。

### i1 旧t4を保持した同一円卓で統合実測する

- Lattice正本を参照。

依存: r1、r2、r3、r4。所有: 本campaignの統合証跡だけ。旧`t4`所有fileは変更しない。

旧`t4`をin-progressのまま、同じroom・同じ席で本PLANへ到達できることを実測する。途中で一席のmodel／effortを
親だけがPeertableの入口からAiterm経由で変更し、対象メンバーは変更操作をせず、同一contextのまま作業を続けた
ことを返す。本件の実席E2E動作確認は親が所有する。片方のPLAN操作が他方のtask、run、evidence、未commit差分を
変更しないことも親が確認する。

親はroom `peertable-autonomy-runtime-20260811`をteardown／再setupせず、AkariとAsahiをTerra/highの`worker`、
ReiをSol/highの`auditor`として最新規範で再着席する。全席のroom metadataに`aiterm_session_id`とroleが載ることを
確認し、Reiは実装taskをclaimしない。

### r1 Aiterm管理sessionを正規着席へ結線する

- Lattice正本を参照。

前提のm2は完了済み。所有: 正規launchとroom member登録の最小配線、対応focused harness、必要な案内同期。

現行の正規launchはCodex CLIを直接起動するため、room memberにAiterm managed `session_id`がなく、
`change-seat.sh`は`SEAT_CHANGE_AITERM_SESSION_MISSING`で変更前に停止する。正規launchをAitermの公開agent launchへ
結線し、返された`session_id`を同じroom memberの`aiterm_session_id`として保持する。PeertableはAiterm本体や
model変更ロジックを実装せず、direct CLI launchへのfallbackも持たない。room MCP、model／effort、role、brief、
wakeup bridgeの既存契約を維持する。

作業者は配線のfocused testと自己監査までを行い、現在の実席の再着席、model／effort変更、live E2Eは行わない。
これらはr1の完了後にi1で親だけが行う。

### r2 Aiterm管理席の着席判定をlive挙動へ合わせる

- Lattice正本を参照。

親のi1実測で、Aiterm launch receiptが成功しbrief turnも開始した後、旧direct-launch用の現在画面ヘッダ判定が
ヘッダの画面外流出を未着席と誤判定し、正常席をrollbackした。所有は`skill/scripts/launch-seat.sh`、この原因を
再現するfocused harness、r2証跡だけとする。

Aiterm管理席は公開launcherのtyped receiptでprocess起動を、room member登録で必須room MCPの成立を判定する。
旧direct-launch用のヘッダ・trust dialog観測をAiterm起動後へ重ねない。invalid receiptとroom未登録は従来どおり
typed failureにし、briefが継続中であることを未着席理由にしない。作業者はfocused testと自己監査までを行い、
現在の実席を変更しない。修正後のlive再着席はi1で親だけが再開する。

### r3 Codex管理席へroom MCPをproject設定から装備する

- Lattice正本を参照。

親のi1実測で、Aiterm launch receiptは成功したがCodex席のroom member登録が起きず、
`SEAT_ROOM_MCP_NOT_READY`でrollbackした。`.mcp.json`はCodexの`mcp list`へ現れず、同じcwdの
`.codex/config.toml`へ定義したroom MCPは現れることを親が実測済みである。

Peertableの正規launch／teardown装備を、Codexが読むproject設定へ最小結線する。room clientはcurrent treeへ
束縛し、seat固有のroom・member・credential環境を明示して渡す。既存roomはteardown／再setupせず追補でき、
新規setup後も最初のCodex着席で自動装備され、teardownはPeertableが所有する追加だけを戻す。Aiterm本体、
Codex launcher、wrapperは変更しない。作業者はfocused testと自己監査までを行い、現在の実席を変更しない。
live確認はi1で親だけが行う。

### r4 Codex room MCPへseat固有環境を明示する

- Lattice正本を参照。

r3後の親live実測でCodexはprojectのroom MCPを起動したが、initialize前にclientが終了した。破棄可能なAiterm診断席の
実起動コマンドから、Aitermは新しいtmuxへ`AITERM_*`を渡す一方、launcher呼出しprocessの`PEERTABLE_*`はCodex子へ
継承しないため、`env_vars`だけではroom clientの必須環境が欠けることを確定した。

正規launchはCodexを起こす直前に、project room MCPの明示env tableへseat固有のroom、member、credential file path、
vendor、model、effort、role、Lattice actorを固定する。token値は書かず、`TMUX`／`TMUX_PANE`だけをCodex席の実環境から
継承する。席ごとのMCPは起動時に自分の設定を保持し、次席の設定更新へ影響されない。Aiterm本体とlauncherは変更しない。
親は診断席のroom member登録まで実測済みで、正式な全席再着席とmodel／effort変更はi1で続ける。

### g1 関連回帰・Lattice整合・pushを閉じる

- Lattice正本を参照。

依存: i1。所有: campaign最終証跡だけ。

各工程のfocused test結果を確認し、関連回帰を一度実行する。Lattice整合、roomの試験・監査記録、git差分を照合し、
本campaign対象だけをpathspecでcommitして通常pushする。publish／deployは行わない。

## 4. 依存グラフ

```text
c1（done） -> c2 -> m2（done） -------> i1 -> g1
                    ^                   ^
m3（done） ----------┘                   |
r1（done） -----------------------------┤
r2（done） -----------------------------┤
r3（done） -----------------------------┤
r4 -------------------------------------┘
```

未着手だった`c3`、`m1`、`m4`は、必要な内容をそれぞれ`c2`と`m2`へ吸収して廃止する。

## 5. 完了条件

1. c1、c2、m3、m2、r1、r2、r3、r4、i1、g1がLatticeでdoneである。
2. 親がClaude／Codex席のmodel／effort変更をAiterm公開面で行い、同一session・contextの維持を実測済みである。
3. room memberのmodel／effortと変更履歴が実設定に一致する。
4. 同じroom・席・Lattice storeが複数PLANを扱い、setupや再起動を要求しない。
5. Codex席の着席でwakeup bridgeが自動装備され、Sol監査専任席がworkerと区別される。
6. 旧`t4`、既存run、未commit差分が中断状態で保持される。
7. 関連回帰とLattice verifyがgreenで、本campaign対象commitが通常push済みである。
