# Peertable 自律性・席設定 campaign（peertable-autonomy-runtime-20260811）— 計画正本

本書がこの campaign の計画正本である。要求収集中の記録は
`docs/intake_peertable-autonomy-runtime-20260811.md`、製品全体の設計決定履歴は
`docs/plan.md` が持つ。本 campaign の Lattice plan key は
`peertable-autonomy-runtime-20260811` とし、本書を commit した後に
`lattice todo migrate` で起票する。

## 1. 目的

Peertable の「対等な長寿命メンバーが、自分で仕事を見つけ、相互に監査し、進捗を流しながら
最後まで働く」という設計を、現在の実装と着任文書へ戻す。同時に、席の effort 変更だけに
閉じた硬直的な操作を、model / effort を独立または同時に変更できる最小の席設定操作へ直す。

この campaign で成立させる状態は次のとおり。

1. メンバーの自然文による明確な依頼を親が意味判断し、完全一致文の再送を求めず席設定を変更できる。
2. 同じ vendor の範囲で model-only / effort-only / model+effort を変更できる。
3. メンバーは親の配車や次指示を待たず、active、ready、peer audit の順に着手可能な仕事を探す。
4. active な仕事を持つ席は、進捗・完了・blocker・明示的待機のどれも記録せず turn を閉じない。
5. 各工程は実装者とは別の文脈近接一席が実物を監査し、監査が通ってから Lattice 完了になる。
6. 親は工程内監査と通常の Lattice 工程管理を持たない。各工程の完了後だけ、設計思想・工程記録・
   完成部分をメンバーへ予告せず照合し、欠陥がある時だけ当該工程を差し戻す。
7. 上の親役割は Claude / Codex のどちらを親にしても同じ文書と入口から成立する。

## 2. 設計判断

### 2.1 自然文を shell script に再解釈させない

現行 `change-effort.sh` は room の全ログを読み、本人→親の単独 DM が
`[effort変更依頼] <level>` と完全一致することを再検証する。この機械判定を廃止する。

自然文の意味、本人の意図、変更してよい局面は親である AI が判断する。imperative script は親が
確定した `member / target model / target effort` だけを受け取り、外部境界で必要な次の仕事だけを行う。

- 現在の member metadata と vendor を読む。
- target model / effort の組合せを、利用可能な live catalog または実 CLI で検証する。
- 同値変更なら再起動しない。
- busy 席は停止しない。
- 同じ vendor / 対象設定で再起動し、metadata を読み返す。
- 再起動失敗時は旧設定へ一度だけ明示 rollback し、黙って別設定へ fallback しない。
- 成功または部分失敗を room 履歴へ残す。

vendor 変更は本 campaign の対象外とする。Claude の model catalog を非破壊で取得できない場合は、
古くなる hardcode を足さず、実 CLI の起動失敗と rollback を正式な検証境界にする。
既存の `change-effort.sh` は配布済み入口として互換を保つが、完全一致 DM の検査は持たせない。

### 2.2 相互監査を Lattice 完了より前へ戻す

現行 role は実装者が `done.sh` で Lattice 完了にした後、空いた席が room 上で監査する順である。
これを次の順へ置き換える。

1. 実装者が成果・focused test・証跡・対象限定 commit を用意する。
2. 実装者が、関連工程の記憶を持つ別の一席へ具体的な監査点を添えて依頼する。
3. 監査席が diff、受入条件、実測を自分で確認する。報告を読むだけでは監査に数えない。
4. 欠陥があれば実装者が直し、欠陥が枯れるまで同じ工程内で続ける。
5. defect-free の監査所見を証跡へ束縛してから、実装者が `done.sh` を実行する。

監査席を親が指名しない。手が空いた席は ready が無ければ、room の監査依頼と未監査の完成候補から
文脈近接の対象を自分で探す。無関係な二席目の追認や、監査対象の無い自主レビューは行わない。

### 2.3 自律作業ループと進捗の可視性を分けない

着任時、再着任時、自工程の完了時、blocker 解消時に、メンバーは次の順で工程正本を読む。

1. 自分の active 工程を完了させる。
2. claim 範囲内の未担当 ready 工程を自分で claim / start する。
3. ready が無ければ、文脈近接の peer audit を探して着手する。
4. 実装・監査とも無ければ `[待機]` を room へ記録する。

親の「必要なこと以外答えるな」「指示に従え」のような局所的な簡潔化要求は、この基底ループと
報告義務を停止しない。停止できるのは、オーナーの明示 pause、承認待ち、外部依存待ち、または
安全に進められない実在 blocker だけである。一方、進捗可視化のために broadcast を復活させたり、
全席を周期的に起こしたりはしない。room ログは全員が pull で読め、作業を開始させる注入は
具体的に行動が必要な席への明示宛先だけにする。

### 2.4 親は工程の外側でだけ完成を照合する

Peertable を使う親へ、provider-neutral な親 role を setup / parent join の正規入口から渡す。
親が既定で行わないものは、技術監査、通常の task 起票・start・note・done、作業の配車、
peer audit の不足補充である。

親は各 ToDo が peer audit を含む証跡とともに done になった後だけ、次をメンバーへ予告せず読む。

- 元の設計思想と当該 ToDo の受入条件。
- room / Lattice / evidence に残った工程記録。
- commit ではなく実際の diff、完成部分、関連 test の結果。

問題がなければ room へ追加の承認・講評を流さない。具体的な欠陥があれば当該 ToDo を reopen し、
`[差し戻し]` と再現可能な理由だけを担当席へ伝える。これは親に許される唯一の通常 Lattice 書込みで、
修正、再監査、再完了はメンバーが行う。後続工程が既に動いていれば、影響する時だけその工程も block する。

### 2.5 campaign 中に発見した不具合を後回しにしない

本 campaign の受入または実装面で再現する不具合を見つけた席は、同じ作業の中で次を行う。

1. 再現と影響範囲を記録する。
2. 現在の ToDo の受入内で閉じない独立欠陥なら、発見者自身が `todo split` / `todo revise` の
   適切な authoring transaction で新しい ToDo と依存線を工程正本へ追加する。**本 plan は migrate
   時に narrative_ref へ行番号を持たせていないため、`todo split` は `predecessor_source_inventory_
   unavailable` で機構的に失敗する（実測: nagi, 2026-08-11）。その場合は `todo revise`（重量級）を
   自作せず、`node skill/scripts/todo-extraction-from-plan.mjs <計画Markdown> <新規companion
   plan_key> --project <id> --agent <name>` で companion fix plan（`<campaign>-fx[N]-<日付>`）の
   migrate 入力を自動生成し、`lattice todo migrate` で起票する**。計画 Markdown に
   `### <task_id> <title>` 見出しで独立欠陥を書くだけで、見出し階層・行番号・digest が機械的に揃う。
   ツールは計画Markdownの所属repoにある `.team/setup-state.json` の `lattice_cli` を自動利用するため、
   親shellで `LATTICE_CLI` を手入力しない。stateにも明示envにもCLIが無い時だけ、正規setup入口を伴う
   typed診断で停止する。
3. 新しい欠陥 ToDo を、影響する統合工程または最終工程の前提へ `dependency connect` で接続する。
4. 親へ task 化や工程管理を代行させず、ready になった欠陥を卓が通常の pull ループで直す。

依頼外の改善案は欠陥へ偽装しない。再現するエラー、受入不成立、明白な論理破綻、具体的事故経路だけが
この即時編入の対象である。

## 3. Lattice 工程

### t1 席設定変更を model / effort 共通操作へする

- [x] t1の実装・試験・証跡化を完了した。後続の現行実装方針を正とする。

所有: `skill/scripts/change-seat.sh`（新規）、`skill/scripts/change-effort.sh`、
`experiments/effort-change-repro.mjs`、必要な配布診断だけ。role 文書と `skill/SKILL.md` は触らない。

現行 exact DM 検査が自然文依頼を拒否する負例を先に固定する。その後、親が意味判断した target を
明示引数で受ける共通操作を実装し、model-only / effort-only / 同時変更、同値 no-op、busy 保護、
vendor 境界、catalog 検証、再起動、metadata 読み返し、履歴、rollback を Claude / Codex fixture で実測する。
既存 effort 専用入口の互換と npm `files` / diagnostics への梱包も確認する。

### t2 メンバーの自律ループと相互監査を role へ戻す

- [x] t2の実装・試験・証跡化を完了した。後続の現行実装方針を正とする。

所有: `skill/templates/charter.md`、`skill/templates/member.md`、
`skill/templates/member-standalone.md`、この契約を測る `experiments/` の新規 harness。
script、親 role、`skill/SKILL.md` は触らない。

§2.2 と §2.3 の順序を三つの role 文書へ一貫して反映する。特に、現行の
「done 後に監査」「依頼されていない監査へ自発参加しない」「ready が無ければ即待機」の衝突を解消する。
親の局所発言で基底ループが停止しない優先関係、active 席の turn 終了報告、ready / audit / wait の
探索順、実装者と独立した文脈近接一席、監査後の Lattice 完了を fixture と実際の role 生成で確認する。

### t3 provider-neutral な親 role と Codex 親の入口を作る

- [x] t3の実装・試験・証跡化を完了した。後続の現行実装方針を正とする。

所有: `skill/templates/parent.md`（新規）、`skill/scripts/setup.sh`、
`skill/scripts/parent-join.sh`、必要なら親の通知 connector、対応する `experiments/` の新規 harness。
メンバー role と `skill/SKILL.md` は触らない。

§2.4 の親 role を setup 時に生成し、parent join が Claude / Codex のどちらにも同じ役割境界を
実際に提示する。親の通常 Lattice 操作を read-only 観測と defect 時の reopen に限定する。
Codex 親について room の read / post、各工程完了の検知、黙った照合、差し戻しが成立する正規入口を
実測する。Desktop と CLI で自動 wake の面が異なる場合は区別し、手動ポーリングを自動 wake 成功と
偽らない。外部注入面が存在しない host は、制約と継続監視の正規手順を明示して止める。

### t4 新契約を実円卓のライフサイクルで統合実測する

- [x] t4の実装・試験・証跡化を完了した。後続の現行実装方針を正とする。

依存: t1、t2、t3。所有: 本 task 用の `experiments/` と
`evidence/peertable-autonomy-runtime-20260811/t4.md`。先行 task の所有 file は、再現欠陥を
工程へ追加した場合を除いて触らない。

使い捨て room / project と実席を使い、少なくとも次を一連で測る。

- 自然文の model / effort 依頼を、完全一致の再送なしで親が実行できる。
- 再起動席が role・工程正本・room ログから再着任し、進行中の仕事へ戻る。
- 親の抑制的な発言後も active 席が報告して作業を続け、ready を親の配車なしで拾う。
- ready が無い席が文脈近接の監査を自分で拾い、監査前に Lattice done へ進まない。
- parent role を読んだ Codex 親が工程内監査と工程管理を奪わず、done 後だけ黙って照合する。
- 欠陥を意図的に含む完成物だけが親に差し戻され、問題のない完成物では親の講評が流れない。

### t5 正典同期・回帰・配布面を閉じる

- [x] t5の実装・試験・証跡化を完了した。後続の現行実装方針を正とする。

依存: t4。所有: `skill/SKILL.md`、`docs/plan.md`、README の該当記述、
`docs/intake_peertable-autonomy-runtime-20260811.md` の状態、campaign 最終証跡。
先行 task の product code は触らない。

実測で成立した挙動だけを `docs/plan.md` の新しい通し番号の決定として記録し、旧決定60・67・68と
SKILL の exact effort protocol / 親 operating notes を supersede する。全関連 repro、
`PEERTABLE_URL= node room/client.mjs diagnostics`、`npm pack --dry-run` の files、Lattice verify、
git diff / status を確認する。version bump / npm publish / 本番 deploy はオーナーの別途明示承認まで行わない。
repo の成果は対象限定 commit、fetch 後の祖先照合、通常 push まで届ける。

## 4. 依存グラフと円卓規模

```text
t1 席設定 ─┐
t2 自律・監査 ─┼─> t4 実円卓統合 ─> t5 正典・回帰
t3 親 role ──┘
```

初期 frontier は t1 / t2 / t3 の3本である。Lattice independence witness で三者の書込み境界を検証し、
`max_frontier_width = 3` が成立した場合はメンバー3席で開始する。成立しない場合は witness の実測に従い、
競合する工程だけ直列化する。席数を先に固定して工程を歪めない。

配置は 2026-08-11 版 dotagents `docs/02_models.md` に従う。

- t1: 仕様固定・focused test で判定できる局所実装として Codex Luna × max を第一候補。
- t2: 規範間の矛盾解消と行動契約の設計として最上位の判断席 × high を第一候補。
- t3: provider / host 境界の探索と実装として中位以上の実装席 × high を第一候補。
- peer audit は実装者と別 vendor を必須にせず、文脈近接を優先する。契約クリティカルな t2 / t3 は
  必要時だけ別レンズを1席追加する。

## 5. 親の運用（この campaign へ直ちに適用する暫定規律）

製品内の親 role が t3 で着地する前から、この campaign の親は次を守る。

- Lattice plan の作成と初期立卓までは campaign 準備として親が行う。
- 立卓後、通常の claim / start / note / done / peer audit はメンバーが行う。
- 親は room と Lattice を観測し、裁定が必要な議題だけオーナーへ運ぶ。
- 各 ToDo が peer audit 込みで done になった後、親はメンバーへ言わず §2.4 の照合を行う。
- 緑なら発言しない。欠陥なら当該 ToDo を reopen し、差し戻し理由だけを伝える。

この暫定規律は、改修前の role 文書を読んで着任する最初の3席にも、着任 brief と room の冒頭決定として
明示する。campaign 自身が直そうとしている旧規則へ卓を従わせないためである。

## 6. 完了条件

次の全てを満たした時だけ campaign 完了とする。

1. t1〜t5 と campaign 中に追加した defect ToDo が、別席の peer audit を経て done である。
2. 各 ToDo の done 後に親の黙った照合が行われ、未解決の差し戻しがない。
3. model / effort の変更、rollback、再着任、メンバー自律継続、相互監査、Codex 親の役割境界が
   fixture と実円卓の両方で確認されている。
4. Lattice `todo verify` が green で、工程・room・evidence・commit の参照が一致する。
5. 関連 repro、client diagnostics、package files 確認が green である。
6. clean worktree、既定ブランチへの着地、origin への通常 push が確認できる。
