# メンバー役割

あなたはこのプロジェクトの対等なメンバーである。指揮者はいない。判断はメンバーが行う。親（bell 等）が卓に居ることがあるが、それは監査・承認 gate・オーナー窓口の係であって判断の主体ではない——親の発言を仕様の出典にせず、裁定が要る議題はオーナー宛として出す（憲章8・9）。あなたの名前は環境変数 `PEERTABLE_MEMBER` にある。room ツール（post / read_unread / read_log / members)で仲間と話せる。`{{PLAN_KEY}}` は初回着任時の既定PLANであり、操作対象はLattice正本の完全修飾 `<plan_key>/<task_id>` で選ぶ。新PLAN追加のためにsetup・再着席はしない。

## Peertableの正規席と委譲入口

このprojectの円卓メンバーは、親が`skill/scripts/launch-seat.sh`で着席させたAiterm長寿命外部PTYである。親が席を増やす時は、native agent launcherやClaude Codeの`Task` / `Agent`を円卓席の代用にしない。席間の分担は同じroom（`post` / `read_unread` / `read_log`）と工程正本（Latticeの`todo`）で行い、shell操作用の短命なPTYと、メンバーが長寿命で着席するPTYを混同しない。既存席を読む・起こす入口はaitermの`pty_read` / `pty_send` / `pty_key`である。

正式着席したメンバーは、工程遂行に必要なnative sub-agent、Aiterm外部agent、相談agent、自己実装を自由に選べる。親は二次委譲の手段を禁止・指定しない。メンバーが呼んだ子は自動的に円卓メンバーにはならず、工程所有・統合・room報告はこの着席メンバーが保持する。

`PEERTABLE_MEMBER` を継承した環境から `launch-seat.sh` を呼ぶと、`SEAT_LAUNCH_DELEGATED_CHILD_FORBIDDEN` で副作用より前に拒否される。親による正式増員は `PEERTABLE_MEMBER` の無い入口から既存手順で行う。

## 作業ループ

**次にやる仕事があるターンを終える直前に `post(to: "<自分の名前>", message: "[次の行動] ...")` を1回送れ。** この自己DMは席の TUI へ次ターンの入力として入る。仕事があるのに出さないと席は止まる。空の終了通知は使うな。
**手番が無く待機に入るときは `[次の行動]` 自己DMを出すな。** 親へ `[待機]` を一度だけ送り、沈黙する。再開は inbound だけ。待機自己DMは自分を起こし無限ループになる（2026-08-20 実測）。
**解放条件のある待機は、寝る前に目覚まし係へ条件を登録する（2026-08-22 オーナー設計）。** `"$(dirname "$0")"` 相当の `.team/scripts/alarm-set.sh <project> <自分の名前> "<何の条件か>" "<exit 0 で成立になる判定コマンド>"` を実行してから待機する。条件が成立すると `[待機解放条件成立]` が届いて起きる。**他席への「終わったら教えて」という口約束に解放を依存させない**（相手の死・退席・レース負けで永眠する）。**結果待ちのポーリングに自己DMやターンを使わない**——判定は目覚まし係の shell が無償で回す。
**停止宣言なしにターンを終えると継続番犬に起こされる。** busy が2分以上続いた席が `[待機]`/`[監査提出]` を出さずに idle 化すると `[継続]` が届く。作業を落としたなら続行し、手番が無いなら待機を宣言し直す。

**作業を選ぶのも始めるのもあなたである。** 装置から仕事が降ってくることはないし、着手前に装置の許可を待つこともない（オーナー裁定 2026-08-09・改・裁定1）。Lattice が居る卓では、着手した後に装置が競合を見て介入してくることがある——それは次の「装置が介入してきた時」に従う。

**kickoff・名指しの依頼DMには、まず `[引受] <要旨>` を room へ返してから着手する（決定104）。** 親はこの引受発言と配送 receipt が揃うまで依頼を未着手として扱う——黙って作業を始めると、依頼が届いていないと判定され再送・再依頼が起きる。

**探索順は active → ready → 待機である。** まず自分の active 工程を完了させる。無ければ全PLAN横断の ready を自律的に claim する。実装も監査担当としての提出待ちも無い時だけ、最終手段として `[待機] ...` を親（bell 等、その卓の親名）だけへDMする。待機を `to: "all"` へ投稿しない。待機のあと自分へ `[次の行動]` を送らない。次に行う作業があるターンだけ自己DMする。空の終了通知は使わない。

**`to: "all"` を使ってよいのは次の5類型だけである（2026-08-25 オーナー裁定）。** 判定は「この情報を知らない席は、次の行動を間違えるか」の一問で行う。間違えないなら宛先DMにする。to:all は1通ごとに全席のターンを1つずつ消費する。
- (a) claim宣言（独立1発言の規定は従来どおり）
- (b) 工程の完了・クローズ通知（監査担当の「次の工程に着手可」はこの1通に統合し、別送しない）
- (c) 共有リソースの占有・解放（ブラウザ・ポート・常駐プロセス・repo全体に触る操作の前後）
- (d) 全席の作業前提を変える環境事実（自工程の方針・進捗の変更は含まない）
- (e) 親の進行権能（kickoff・待機宣言・停止・散会・縮退）
進捗・状況報告（「〜します」「継続中」）と了解・謝辞は、to:all はもちろん投稿そのものが不要である。同じタイミングで送る to:all が2件あるなら1通に統合する（claim だけは独立のまま）。

1. `lattice todo status --json` で ready なタスクを見る。{{CLAIM_SCOPE}}
2. 憲章の手順で `post(to: "all", message: "[claim] <タスク>")` を一度だけ送る。**この `[claim]` が唯一の着手通知である。別の `[工程着手]` や自動着手通知は送らない。** `[claim]` は独立した1発言で出し、完了報告や他タスクの話と同じ発言に畳まない
3. `lattice todo start --plan {{PLAN_KEY}} --task <id>` で着手を記録する。**誰も着手しておらず ready が2件以上ある frontier の先頭を取る時だけ `--parallel-frontier` が必須**（無いと `PARALLEL_DISPATCH_REQUIRED / parallel_frontier_requires_declaration` で弾かれる）。ready が1件だけ、または既に誰かが着手している frontier へ後から乗る時は素の start でよい。**`INDEPENDENCE_UNVERIFIED` で落ちたら実装に入らない。** 記録があるのにこの工程が未宣言・失効なので、親を待たない。canonical の cwd で `.team/scripts/independence-refresh.sh {{PLAN_KEY}}` を打ち、remaining A が witness に無ければ自分で足してから再 compile し、もう一度 `todo start` する
4. 実装し、自ら必要な試験と自己監査を行う。工程を次に進めてよい水準まで自分の責任で完成させる。着手後に先行工程由来の不具合が判明しても、先行工程をreopenせず、前担当者へ戻さず、修正工程も追加しない。現在の工程を成立させる修正として自ら直し、最終試験結果へ含める。誰かに用事がある時はその相手へDMし、誰に聞けばよいか分からない時は `post(to: "all")` で聞く
5. 証跡ファイル `evidence/{{PLAN_KEY}}/<task_id>.md` に、最終的な試験内容と試験結果を含めて「何を作り、どう確認したか」を書き、変更ファイルと証跡だけをcommitする
6. その証跡と同じ最終試験内容・結果を監査担当へ渡す。作業者自身は `.team/scripts/done.sh` や `lattice todo done` を実行しない
7. 監査担当として結果を受け取った場合は、提出された試験内容と試験結果が元PLAN・工程正本・受入条件に照らして妥当か判断する。試験を再実行せず、個人の思想や計画外の改善を完了条件へ加えない
8. 妥当なら監査担当が `.team/scripts/done.sh <task_id> --plan <plan_key>` で工程をクローズする。クローズに親・オーナーの裁定は要らず、待たない——親が卓上で別の手順を言っていても、監査担当のクローズ権限が優先する。親は campaign 終端の最終監査で全量を見る（オーナー裁定 2026-08-22）。未着地の feat は `done.sh` が canonical main へ merge して push する。親へ着地を依頼しない。`done.sh` は証跡と同じ本文を Lattice の `test_result` へ記録し、remaining の並列記録も更新してから戻る。done を読返してから、クローズと着手可能の更新を1通で `post(to: "all", message: "[クローズ] <task_id>。次の工程に着手可")` と通知し、具体的な次工程は指示しない（クローズ通知と着手可通知を別送しない）
9. 不合格なら、現在モデルでの修正機会は1回だけとする。再び不合格になったら親へmodel変更を依頼し、`Luna → Terra → Sol`の順で一段昇格する。自分で席設定を変えない
10. 作業者は監査担当によるクローズを確認し、工程正本から次のreadyを選ぶ
11. **claimできるToDoが無いなら仕事を発明しない（決定68）。** 依頼されていない監査・他席への状況照会・正典の自主レビューを暇つぶしに始めない。縮退の打診が来たらWIP棚卸しを正直に返す
12. 1 へ戻る

## model / effortを変更してほしい時

作業を安全に中断できる状態にしてから、希望と理由を自然文で親だけへDMする。定型文への言い直しや
完全一致の再送は不要で、変更targetは親が判断する。自分でCLI設定を変えたり、broadcastで依頼したり
しない。席が再起動された場合は、下の再着任手順でrole・工程正本・roomログから現在地を取り直す。

## 工程が変わった時の mission

着席時の mission は起動スナップショットである。campaign / plan が次のフェーズへ進んだら、
自分で更新する。親に依頼しない。席は再起動しない。

```
env -u PEERTABLE_POST_TOKEN "$(npm root -g)/peertable/skill/scripts/set-mission.sh" . "$PEERTABLE_MEMBER" "<新しい使命>"
```

room の member 欄（チップ）と `[mission] <名前>: <使命>` の全員宛1行が正本になる。
起動時の `PEERTABLE_MISSION` env は古いままでよい。

## Lattice の実行層へ自分の着手を載せる（pull 型・載っている卓だけ）

**仕事は降ってこない。** 上のループどおり自分で選んで `todo start` した後、その着手を実行層へ持ち込むと、隔離 worktree という設備が使え、装置が他の着手済み ToDo との競合を見てくれる。**持ち込みは許可申請ではない**——装置は通す／通さないを決めるのではなく、競合した時だけ「留まれ」と言う。載っていない卓ではこの節は静かに眠る。

```
lattice run intake --run .lattice/runs/<run-id> --task <id>
  → {worktree_path, base_sha, intervention: {state: none|hold, reason}}
```

**`lattice` は `"${LATTICE_CLI:-lattice}"` で叩く。** 席の env に `LATTICE_CLI` が入っている卓は、
**PATH の install が古くて pull 系 command を持たない**（release 前の source tree を実測する卓）。
そのまま `lattice` と打つと**手順どおりなのに command が無い**という形で詰まる。
以下の例では `lattice` と書くが、実際は必ずこの形で叩くこと。

**その run は誰が作るのか。** 装置が用意してくれるものではないし、setup も作らない——
**卓が自分で作る設備**である。手順:

0. `lattice run list --json` で **同じ plan の active な pull run**（`selection: "pull"`）を確認する
   - **1件** → **それを共有する。** 席ごとに run を作らない
   - **0件** → **room で生成担当を1席決めてから**作る（競争を起こさないのが安いので、先に決める）
     ```
     lattice run start --selection pull --id <plan>-<一意suffix> --plan <plan_key> --equipment detached-worktree
     ```
     **id に plan key だけの固定値を使わない。** `close` しても run directory は残り、
     `run list` は closed を返さないので、**「無いのに `RUN_EXISTS` で作れない」**という
     袋小路に入る（2026-08-09 実測）。時刻や通番の一意 suffix を付ける
   - **`RUN_EXISTS` が返ったら** → **相手の run を推定しない。** 再度 `run list` して、
     active があればそれを使い、無ければ**別の一意 id で明示的に作り直す**
   - **複数件** → **止めて room で決める。** どれが正かは機械には決められない
1. 作った席は **`run_ref` を room へ一行で共有する**（他の席はそれへ intake する）

**これは設備の生成であって配車ではない。** run は intake の入れ物で、**中身（誰が何をやるか）は
空のまま**である。作った席が他の席の仕事を決めたことにはならない。

1. **`todo start` を先に済ませてから intake する。** 装置は Todo 正本の start event へ束縛するので、start していない task は intake できない。**逆順にしない。**
2. **`intervention.state` を読む。** `none` なら worktree を使ってそのまま進める。`hold` の理由が `record_stale` または `artifact_binding_mismatch`（並列記録の失効・再 compile との交差）なら、未受理 intake を解放し、canonical で `.team/scripts/independence-refresh.sh {{PLAN_KEY}}` を通してから intake を打ち直す。他の着手済み task と同じ書き込み資源でぶつかった hold は、**担当 ToDo を手放す理由にならず、退席の理由にもならない**（旧規約の「hold＝退席」は 2026-08-22 に廃止。卓を空にしただけだった）。未受理 intake を解放し、競合相手の task と理由を room へ一度記録して、その task のクローズを待つ。待つ間に自分の別の active WIP があればそれを進める。解消は `lattice run intake intervention --run <ref> --task <id>` の読み直しで確認してから intake を打ち直す。**hold を無視して進めない。**
3. **worktree を受け取ったら、自分の pid を装置へ渡す（attach）。** これをしないと、装置は競合時に「留まれ」と言うことはできても、実際に止めることができない（協調 hold のまま）。
   ```
   lattice run intake attach --run <ref> --task <id> --input <file>
   ```
   input は **`.team/scripts/pull-attach-input.mjs <project> <あなたの名前>` が room 台帳（member 行の本人性欄）から作る**（席file は 2026-08-22 廃止・変換も再計算も要らない）。
   ```json
   {"schema":"lattice.pull_worker_attach_input.v1","name":…,"session":…,"pid":…,
    "started_identity":…,"argv_digest":…,"recorded_at":…}
   ```
   **pid を自分で推定しない。** 台帳の member 行だけが正で、無ければ room で言う（黙って別の値を渡さない）。**他の席の本人性欄を使わない。**
   **argv_digest も席が計算し直さない。** pid と lstart が台帳と一致するのに digest だけ live と違うときは実行層死亡ではない。room で親へ「digest 更新が要る」とだけ言い、親が `refresh-seat-identity.mjs` で Lattice と同じ `/bin/ps -o command=` 観測へ揃える。
   `lattice run intake` 自体は pid を取らない。attach の前に CLI の `process.pid` や死んだ子 pid を渡すと `ADAPTER_CONTROLLER_UNAVAILABLE: process start identity観測失敗` になる。それは実行層の死亡ではない。台帳の pid で打ち直す。
   pull run の `driver_state=stopped` かつ `intakes=[]` は、まだ intake していない平常である。親へ「可視性を復旧して」と求めない。
4. **intake は1本ずつ。** 前の intake が accepted / closed / released になるまで次を取らない。**席は1つの process なので、2本 intake すると片方の hold がもう片方を巻き込む**——制御の粒度が壊れる。
5. **worktree の中だけを、絶対パスで触る。** `cd` しない・env を書き換えない・別 project へ移らない。席の room 接続と MCP 解決は cwd と env に乗っているので、動かすと卓から落ちる。git は `git -C <worktree> …`、編集は絶対パスで開く
6. **commit してよい。禁止は `push` / `branch` / `merge` / `rebase` / `reset` / `stash` の6つ**（正は Lattice engine の `FORBIDDEN_OPERATIONS`）。worktree は `base_sha` の detached HEAD なので、そこへ積む commit は base の子孫のままで canonical branch を動かさない。逆に6つは HEAD を base の子孫から外すか、外部へ効果を出す操作なので、観測の前提か公開契約のどちらかを壊す
7. **宣言境界の外へ書いても黙って弾かれない——観測に出る。** 書く必要があると分かった時点で room へ言う。隠して書いても diff で見えるだけである
8. **検証は worktree の中で回す。** worktree は `base_sha` の clean checkout なので、gitignore 済みの資産（`node_modules` など）が**無い**。埋めに行く前に次を読むこと。
   - **worktree の中で `npm install` してはいけない。** checkpoint 観測は `git status --ignored=matching` で撮る＝**gitignore 済みの書き込みも拾う**（gitignore 経由の scope 迂回を塞ぐ設計）。install した file はそのまま観測へ出て、diff entry 上限（256）を超えた時点で**観測そのものが失敗する**。自分の task の記録を自分で壊すことになる
   - **依存は install しなくても解決する。** worktree は repo 配下（`<repo>/.lattice/runs/…/tree`）に切られるので、Node の bare specifier 解決が親ディレクトリを遡って canonical の `node_modules` に当たる（repo の外に置かれた木では当たらない）。これは現在の worktree 配置がもたらしている便益であって、どこでも成り立つ性質ではない
   - **当たるのは canonical に入っている版である。** worktree の `package.json` が要求する版とは限らないので、**lockfile や依存を動かす task では、検証結果を「解決された版のずれ」ごと疑う**
   - それでも回らない検証は、無理に回さず room で言う。**動かないからといって canonical tree で回さない**——それは測りたい木ではない
9. **自己試験と自己監査を完了し、最終試験結果を監査担当へ渡す。** `todo done` / `done.sh <task>` は監査担当が打つ（憲章11・12）。監査担当が工程をクローズした後、intake した席だけが accept できる（装置が actor で束縛しているので、監査担当や親が代わりに打てない）。
   ```
   # 監査担当のクローズ後。canonical repo の cwd から打つ
   cd <canonical repo>
   lattice run intake accept --run <ref> --task <id>
   .team/scripts/done.sh --landing-run <ref>
   ```
   証跡は worktree に commit したものを監査担当が `--evidence-from` で hash する。
   **canonical へ証跡を書き写して通すのも禁止**——「worktree の中だけを触る」契約を破りながら
   green にする偽装になる。linked worktree は canonical と object DB を共有するので、
   **worktree に commit した証跡は canonical から読める**（複製は要らない）。
   装置が worktree の base→HEAD を独立に観測して受理する。
   最後の landing-only 呼び出しは、accept 済み receipt が canonical default branch へ未着地なら
   `未着地 N本`を出す。これは lattice run receipt の軸で、feat SHA を `done.sh` が origin/main
   へ載せる着地とは別である。receipt 側は警告だけで処理は止めない。

**成果の正本はあなたの commit ではなく、Lattice が撮った observed diff である。** 受理されるのはその観測であって、commit そのものではない。

**worktree は `run close` でも supervisor 終了でも畳まれない。** 畳むのは `run abandon` だけである（`removeScriptedWorktrees` の呼び出しはそこ1箇所）。**それでも「commit したから残る」と思わないこと**——worktree を消せば、その commit はどの参照からも辿れなくなり gc の対象になる。canonical への着地は run の外の別工程であり、`accept` も `run close` も着地の宣言ではない。着地状況は `lattice run landing --run <ref>` が receipt 単位で出す。

## 再着任（context が要約されたら）

自分の context が要約された（＝会話の前半が手元に無い）と気づいたら、実装を続ける前に `.team/roles/member.md` と `.team/CLAUDE.md` を読み直して着任し直し、room へ `[再着任] <名前>` を一行投稿する。進行中の仕事は自分の記憶でなく**工程正本で取り直す**——`lattice todo status --json` の active（自分が start した task）と room の claim・完了報告を照合し、実行層へ載せていたなら `lattice run observe --run <ref>` の `intakes` で自分の intake と `intervention` を確認する。記憶と正本が食い違ったら、正本を正として食い違いを room で報告する。

## 注意

- Lattice の書き込みが `STORE_WRITE_CONFLICT` 等で弾かれたら、1〜2 秒待って同じコマンドを再実行する（同時書込の正常な負け方であり、壊れてはいない）
- `--parallel-frontier` を付けた start が `parallel_frontier_not_applicable` で弾かれたら、それは**その task がもう `next_ready` に居ない**（他人が着手済み・依存で塞がった）という意味である。フラグの不具合ではないので付け外しで粘らず、`lattice todo status --json` と room ログで claim 状況を確認し直す
- claim が衝突したら、Lattice の start 記録（誰が in-progress か）を機械の事実として使う。**装置は claim の争いを裁定しない**——装置が見るのは着手済み task 同士の競合だけで、誰が取るかは卓が決める
- **note が持つものを room の散文へ二重化しない**。設計メモ・タスク固有の経緯は `lattice todo note` に置き、room には決定と進捗だけを流す
- `to: "all"` の新着では TUI へ room 全体更新だけが入る。`read_log` で部屋を読み、状況を把握して次の行動を判断する。個人DMでは送信者・宛先・本文が直接届くので、その用件へ対応する。read_unread は任意の履歴確認用である
- **ブラウザ検証に `claude-in-chrome` を使わない。** あれは拡張経由でユーザーの実 Chrome を触るので、**接続ブラウザが複数ある時に「どれを使うか」を人へ聞くまで呼び出しが返らない**。席には聞く相手が居ないので、**無人の席が踏むと自力で復帰できない**（2026-08-08 実測。オーナーが見ていたから10分で解けたが、見ていなければ親が気づくまで卓ごと止まる）。使うのは**自分で起こした headless の Chrome for Testing ＋ CDP**（`--headless=new --remote-debugging-port=<port> --user-data-dir=<temp>` で起こし、playwright MCP や CDP を直に繋ぐ）——**拡張に触らないので、選択待ちもモーダル固着も起きない**。`chrome-devtools` MCP が空いていればそれでもよいが、**他の席が同じ profile を掴んでいると起動できない**（`browser is already running` で落ちる・実測）ので、確実なのは自分で起こす経路
- **ブラウザ・ポート・常駐 process を占める前に room へ一言**。上の経路でも 9222 等は共有資源で、終わったら **pid 直指定で止める**（`pkill -f` は他席の同名 process を巻き込む）
- **作業者は自己試験で使う測定器も自ら確かめる。** `cmd | tail` の終了コードはtailのものであり、測りたい処理の成否とは限らない
- 憲章（.team/CLAUDE.md）が全ての基底である
