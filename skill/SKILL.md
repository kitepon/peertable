---
name: peertable
description: 任意プロジェクトに対等・長寿命のAIメンバーからなる円卓を導入・再開・解散する。スキル導入はinstall、対象projectの準備はsetup、再開はresume、解散はteardown。「チームで作業して」「円卓を立てて」「peertable setup / teardown」で使う。
---

# Peertable — install / setup / resume / teardown

製品境界と設計の正典はPeertableリポジトリのdocs/current-design.md。本スキルは利用手順の正本である。

## 導入・更新

`npm install -g peertable@latest` はPeertable本体と、検出したAIのスキル置き場に`peertable`スキルを配置する。Claude・Codex・Grok・Cursorの既存ホームディレクトリを検出し、このスキルのリンクだけを管理する。Windowsではdirectory junctionを使う。

再実行・明示導入は `peertable install`、配置確認は `peertable diagnostics`。対象を絞る時は `--target claude|codex|grok|cursor`（複数指定可）を渡す。npmのinstall scriptを無効にして導入した時も同じ入口を使う。既存のPeertableリンクは現在のpackageへ更新し、同じ配置は変更しない。別製品のリンク・利用者の実ディレクトリとの衝突は、変更前にエラーで止まる。AI設定本文や他製品のMCP設定は変更しない。

installはprojectやroomを探索・再構築しない。更新したprojectへ適用する操作は、対象パスを明示したsetup/resumeで行う。

## 前提と所有範囲

- Node.js 24以降とPeertable、統合`pty_send`の公開receiptに対応したAiterm MCP、使用するharnessの公式CLIと認証、稼働中のroomサーバーが必要。Aitermの導入と診断はAitermの正規入口を使う。
- 書込資格はPeertableのcredential解決で読む。通常は `~/.config/peertable.env` に保存する。席へ渡すのは席別credential fileのpathだけで、token本文を起動コマンドへ書かない。
- Lattice併用はオーナーが明示した場合だけ。単独モードはLatticeに依存しない。
- スキルを呼んだセッション自身が親として着卓する。専用の親セッションは作らない。
- 生成物は`.team/`へ置く。rootの`.mcp.json`は既存の他のMCPを保ち、Peertableのroom blockだけを追加する。既存room blockが別の接続ならエラーで止まる。作成・所有記録は`.team/setup-state.json`に残す。
- git除外は`.git/info/exclude`だけに追加する。既存の`.gitignore`と作業差分は保つ。解散時は追加した項目だけを戻す。
- Lattice併用では`.lattice/project.json`のexternal_paneを公開CLI連携に使い、既存文書は`.team/project.json.bak`へ退避して解散時に復元する。既存storeの操作はLatticeの公開コマンドだけを使う。
- 本番のexternal_paneを検証目的で外さない。復元試験は使い捨てprojectで行う。

## 正規席と委譲

親が円卓メンバーを作る入口は `peertable launch`。Aitermの公開`agent_launch`で長寿命席を起動し、返されたsession IDをroomへ記録する。親がAiterm launcherやnative sub-agentで作った子を、円卓の正規席の代用にしない。

正式着席したメンバーは、native sub-agent、Aiterm外部agent、相談agent、自己実装を自分で選べる。子は自動的に円卓メンバーにならず、工程所有・統合・room報告は着席メンバーが保持する。`PEERTABLE_MEMBER`を継承した環境からの正規増員は`SEAT_LAUNCH_DELEGATED_CHILD_FORBIDDEN`で拒否する。

PTY・harnessの起動準備・入力・承認・生存と活動の観測はAitermが所有する。Peertableは公開APIの構造化応答だけを使う。socketやnamespaceの推測、内部stateの読取り、画面文言による状態判定、キー列によるTUI補正は利用手順へ持ち込まない。

## setup

1. 対象project、roomとサーバーURL、初期タスク、メンバー数と役割を依頼から確定する。役割名は同梱`02_models.snapshot.md`の正式名を使う。model/harness/effortの既定は同梱配置表で機械解決し、隣接dotagentsを暗黙に読まない。明示された設定だけを上書きする。
2. Lattice併用が承認済みならその正規手順で工程正本を確認する。初期化済みstoreへの追加は`todo migrate`を使う。新規storeでは`make-plan-input.mjs`で入力を作り`plan create`へ渡す。メンバー数の初期値はplanの`max_frontier_width`、運用中worker数の標準はready＋activeな実装ToDo数とし、監査専任席をworker数へ含めない。単独モードの人数は依頼から決める。
3. 次のどちらかを1回実行する。setupは対象projectの生成物、room MCP、alarm・seat-status・wakeupの起動と更新、readyの読返しまで行う。同じprojectへ再実行すると既存のroom・議題を保ってresumeへ進む。

```sh
peertable setup <project> --room <room> --url <server-url> --tasks <tasks-file>
peertable setup <project> --room <room> --url <server-url> --plan <plan-key> --phase <phase-id>
```

単独のtasks-fileは「タスク名: 何をどこまでやるか」の本文で、必須。生成する`.team/tasks.md`は議題表であり、状態はroomのclaim・完了宣言を正とする。Latticeの`--phase`は複数指定でき、省略時はplan全体。外部ペイン用の公開URLをサーバーURLと分ける場合は`PEERTABLE_PUBLIC_URL`を渡す。

4. メンバーに日本のアニメキャラ風の名前を都度決める。識別子はローマ字、自己紹介は日本語。席ごとに次を実行する。

```sh
peertable launch <project> <name> --roles <role[,role...]> --mission <使命> --brief <着任指示>
```

着任指示例: 「あなたは『<日本語名>』。.team/roles/member.mdを読んで着任し、作業ループを開始してください。全タスク完了の宣言まで自律的に続けてください。」

launchはモデルの非対話実測、同じroomの既存席の撤去、席別資格の準備、Aitermによる起動準備、room登録、本人性、3 bridge、指示送信と実ターン開始を続けて確認する。`trust_project: true`は対象projectと宣言済みhooks/MCPの既知起動同意を表す。未知の起動画面はAitermがエラーで返す。他roomや本人確認できない同名sessionは閉じない。

CodexとGrokの席設定・認証は`.team/seats/`へ分離する。Codexにはroomのstdio MCPと列挙したenv、Grokにはroom以外のproject MCPを無効にした席configを渡す。利用者の共有configを書き換えない。

5. 親は`peertable connect --target claude|codex|grok|cursor`で親MCP/hookを接続し、現在の会話で`parent_join(project,name,model?,effort?,mission?)`を呼ぶ。本人性は実MCPと公式hookで照合する。Cursor/Grokはreceiptにあるnative背景toolの完成済みinputを登録する。耳疎通が`verified`になり、現在runtimeが`armed`になるまで着卓完了としない。
6. membersの全席、最初のclaim、公開Web UIを確認する。Lattice併用ならclaimが工程正本のactiveにも反映されていることを確認する。kickoffは `node scripts/kickoff-gate.mjs <project> --seq <seq> --seats <a,b,c>` が`active`を返すまで成立としない。freshな実効状態、delivered receipt、席の`[引受]`発言の3点を使う。

## 配達と観測

3 bridgeの順序・更新・再起動はsetup/launch/resumeが所有する。個別bridgeの起動コマンドを先に並べない。任意の常駐監視を導入する場合は`skill/launchd/`の見本を使うが、スキルinstallが勝手に登録することはない。

wakeup bridgeはroomの明示宛先付き新着をAitermの統合`pty_send`で届ける。Aitermが実行中の差し込みと待機中の新規ターンを選び、Claudeを含む席の配達成立は公開receiptで確認する。成否不明は自動再送せずfailed receiptと親通知を残し、通知失敗時は本文を送らず通知だけを再試行する。既知承認は公開approval APIのdigestに対して単発応答し、未知の承認をキーで押し通さない。SSEは75秒無受信で再接続し、最終seqから回収する。心拍の最新seqとの差も回収する。ログは`.team/wakeup-bridge.log`。

seat-statusは`pty_observe`の状態・本人性・token hint・活動差分と、`pty_list`で公開された同roomの席envを使う。席のランプには預け仕事の活動を合成し、ターン終了の番犬は席本体の状態を使う。画面文言の分類はPeertableへ複製しない。判定不能をidleや死亡に丸めない。

## resume

`peertable resume <project> [--plan <plan-key>] [--phase <id>] [--no-probe]` は既存`.team/`を基に生成物を更新し、登録された席の復帰と3 bridgeの更新を行い、fresh heartbeatとprobeのdelivered receiptを読み返す。生存席・roomログ・他projectは保つ。役割のない復帰対象はエラーで止まる。`--no-probe`は明示的に配達試験を省略する時だけ使う。親の監視は呼出し元に属するため、parent-joinと耳疎通を現在のセッションで行う。

## 席設定とmission

本人が希望と理由を親へDMし、親は `peertable change <project> <name> [--model <model>] [--effort <effort>] [--harness <harness>] [--parent <name>] [--reason <text>]` を実行する。定型文の再送は要求しない。同じharnessではAitermの`agent_configure`で会話を保ち、harness変更では再着任する。targetは公式CLIで検証し、設定と変更履歴をroomから読み返す。

missionはcampaignやphaseでの担いであり現在作業欄ではない。席本人が `scripts/set-mission.sh <project> <name> <text>` で更新する。親は代行せず、席は再起動しない。

## teardown

`peertable teardown <project>` は解散。roomログの控えを`docs/archive/`へ保存し、同roomの席と3 bridgeを公開APIで停止確認してから、区切りの投稿、member解除、room archive、所有するproject足場の撤去と既存設定の復元を行う。roomと過去ログ、Lattice storeは残る。次の卓も同じroom名でsetupする。

`--purge`はroomを削除し、新設したLattice storeも撤去する。既存store・既存の無関係設定と作業差分は保つ。停止またはroom操作が失敗した場合は再実行用の`.team/`を残し、非ゼロで返す。結果は工程ごとの実施・スキップ・失敗を含むJSON。公開UIとproject差分を確認して報告する。個別席の退席は `peertable leave <project> <name>`。

## diagnostics

`peertable diagnostics <project> [--repair]` はroom到達性、member台帳、公開Aiterm観測、3 bridge、Lattice併用時の工程状態を調べる。`--repair`はbridgeを修復し、席の復帰はresumeで行う。対象projectを省略したdiagnosticsはスキルの配置だけを調べる。


## Lattice の実行層へ席の着手を載せる（pull 型・Lattice 併用モードだけ）

**装置は仕事を配らない。** 2026-08-09 のオーナー裁定（改・裁定1）で、Lattice が task を選んで席へ配る向きは撤回された——**作業を選ぶのも始めるのも席（AI）**であり、装置がやるのは**着手済み ToDo 同士の競合判定と介入だけ**である。着手前に装置の許可を待つ面も作らない。旧版にあった `[配車]` / `[受諾]` / `[辞退]` の3層は無くなり、**claim は従来どおり割当の主体に戻った**（決定25 のとおり）。

- **pull run は卓が作る設備であって、装置が用意するものでも setup が作るものでもない。** `run list --json` で同 plan の active な pull run（`selection: "pull"`）を確認し、**0件なら room で生成担当を1席決めてから** `run start --selection pull --id <plan>-<一意suffix> --plan <key> --equipment detached-worktree` で作り、`run_ref` を room へ共有する。**1件ならそれを共有**（席ごとに作らない）、**複数件は止めて卓で決める**
  - **id に plan key だけの固定値を使わない。** `close` しても run directory は残り `run list` は closed を返さないので、**「無いのに `RUN_EXISTS` で作れない」**袋小路に入る（2026-08-09 実測）
  - `RUN_EXISTS` が返ったら**相手の run を推定せず**、再 list → active があれば共有、無ければ別の一意 id で作り直す
- **席は自分で `todo start` してから `run intake` する。** intake が返すのは隔離 worktree と `intervention`（`none` か `hold`）で、**許可証ではない**。`hold` は「他の着手済み task と競合しているから留まれ」という装置の指示である
- **`todo done` は監査担当が打つ。** canonical の cwd/store へ打ち、証跡は worktree から渡す。`done.sh <task> --evidence-from <worktree>/evidence/<plan>/<task>.md`。cwd 1つで兼ねると必ずどちらかが外れる（canonical では証跡が読めず、worktree では accept が見ない store を書く）。**canonical へ証跡を複製して通すのは偽装**——linked worktree は object DB を共有するので複製は要らない。**accept は intake 席が、todo done の後に打つ**（engine は done 前の accept を拒否する。done.sh が accept を先に要求すると循環する）
- **worktree と lease は設備の供給である。** 席が要求すれば出てくるもので、出してもらうものではない
- **席と spool は接触しない。** 席が触るのは room と worktree だけで、`.lattice/` の直読み・直書き禁止の契約はそのまま
- **席の作法の正本は `templates/member.md` の「Lattice の実行層へ自分の着手を載せる」節**（intake→intervention 判定→attach→作業→監査担当が `done.sh`→intake 席が accept の順・1席1 intake・禁止操作・検証の回し方・成果の正本）。ここに二重化しない
- **席は自分の pid を装置へ渡す（attach）。** その pid は room 台帳の member 行（`launch-seat.sh` が着席直後に登録する本人性欄）が持ち、席は `pull-attach-input.mjs` で読むだけで attach input になる（席file は 2026-08-22 廃止・member に帰属する情報の正本は台帳だけ）。**raw argv を保存しない**——token値をargvから除いた後も、将来の引数を無条件に複製しない。持つのはdigestだけ。Lattice の再観測は `/bin/ps -o command=`。pid/lstart が一致して digest だけ違うときは親が `skill/scripts/refresh-seat-identity.mjs <project> <name>` で揃える。席は台帳の本人性欄を書き換えない
- **run-bridge は退役した（2026-08-22・オーナー裁定）。** 介入（hold）は席が自分の Lattice コマンド応答（intake / attach / accept / `run intake intervention`）で受け取る——これが唯一の経路である。装置の介入を DM で先回り通知する中継は、凍った席には届かず、届いた席を退席させ、死んだ席の shell へ打鍵する事故だけを生んだので廃止した。現行の常駐bridgeは wakeup、seat-status、alarm の3本であり、Lattice介入の中継は持たない

運用側が踏みやすい所（実測で確認した挙動）:

- **worktree は `run close` でも supervisor 終了でも畳まれない。** 畳むのは `run abandon` だけである。**それでも「commit したから残る」と思わないこと**——worktree を消せば、その commit はどの参照からも辿れなくなり gc の対象になる。**成果の正本は Lattice が撮った observed diff** であって席の commit ではない。着地は run の外の工程で、`accept` も `run close` も着地の宣言ではない（着地状況は `run landing` が receipt 単位で出す）
- **worktree には gitignore 済みの資産が無い**（`node_modules` 等）が、**席に install させない**。checkpoint 観測は `git status --ignored=matching` で撮る（gitignore 経由の scope 迂回を塞ぐ設計）ので、install した file が全部観測へ出て、diff entry 上限 256 を超えた時点で観測ごと落ちる（実測: ignored 300本で `diff entry数が上限を超える`）。**依存は install 無しで解決する**——worktree が repo 配下（`<repo>/.lattice/runs/…/tree`）に切られるので、Node の bare specifier 解決が親を遡って canonical の `node_modules` に当たる（repo の外へ置くと `ERR_MODULE_NOT_FOUND`）。当たるのは canonical の版なので、lockfile を動かす task の検証結果は疑う。canonical tree で回させない——測りたい木ではない
- **宣言境界の外への書き込みは黙って弾かれず、観測に出る。** 席へは「隠すな、room で言え」と伝わっている

## 線（共有プロトコル）を資源として宣言する（Lattice 併用モード）

**path が1つも重ならない2つの task が壊れ合うことがある。** 2026-08-08 の卓で実際に起きた: 片方が SSE のワイヤへ新しい event 種別を足した瞬間、そのストリームを読む側が壊れた。compile から見て完全に独立で、実際そう扱われていた。**依存は path ではなく共有プロトコルにあった。**

これを宣言できるのが**線**である。witness set を書く時、path・symbol の owns/reads/writes に加えて `lines` を書く（**省略可。省略＝線の宣言なし**）。受理するのは witness set v5 / run_request v5 / boundary manifest v4 以降だけで、旧版へ書けば typed reject になる。

```json
"lines": [
  {
    "line_id": "src.runtime-diff-observer.mjs--finding-kind",
    "role": "writes",
    "anchors": [
      { "kind": "path",   "path": "src/runtime-diff-observer.mjs" },
      { "kind": "symbol", "name": "detectCheckpointFindings", "path": "src/runtime-diff-observer.mjs" }
    ]
  }
]
```

- **`role`** は `writes`（線の形を変える側）か `reads`（その形に依存する側）。同じ `line_id` を別 task が持つ時、**`writes`×`reads` と `writes`×`writes` は直列化される。並列でいられるのは `reads`×`reads` だけ**——形を変える側が2人居るなら、その2人こそ揃えないと壊れるからである
- **`line_id` が一致した時だけ交差する。** 機械は anchor の重なりから「同じ線だろう」と推測しない——推測を装置に入れない設計であり、**綴りを揃える責任は宣言する側（AI）にある**
- **命名は錨から機械的に導く**: `anchors` **先頭**の repo-relative path の `/` を `.` に置換し、必要なら `--<種別>` を suffix する。`line_id` に使える文字は `[0-9A-Za-z._-]`（先頭は英数字・128文字まで）で、`/` も `:` も入らないのでこの置換が要る。**思いつきで名前を付けない**——揃わなければ交差は素通りする
- **名前を決めるのは最初に宣言した側だけ。** 後から同じ線を宣言する側は**再導出せず、既に在る `line_id` をそのまま写す**。錨が複数ある線で各自が「主たる錨」を選び直すと、同じ線に2つの名前が生まれて交差が消える
- **綴りが揃わなかった分は実行時が拾う。** 実際の変更 diff を錨の path へ近似して finding にし、その線の読み手を hold 閉包へ入れる。**計画時の宣言と実行時の観測の二段構え**であって、宣言だけで閉じる設計ではない。だから宣言漏れは致命ではないが、**漏れた分は「変更した後」にしか分からない**
- **錨は同じ repo の relative path だけ**（絶対 path は typed reject・`anchors` は最低1本）。越境 task（別 repo の file）を錨にすると**形式は通る**が、その path はこの repo に存在しないので**実行時の近似は永久に当たらない**。越境の線は「計画時の宣言としてだけ効く」と理解して使う（欠陥ではなく境界）
- **1つの task が同じ `line_id` を2本書くことはできない**（typed reject）。自分が writer でも reader でもある線は **`writes` を選ぶ**——読むだけの task はその形の変更を知る必要があり、それを教えられるのは writer 側の宣言だけだからである

**宣言する時の見つけ方**（席・親のどちらが witness を書く卓でも同じ）:

1. 自分の変更が**他の誰かが読む形**を変えるかを問う: wire format・event 種別・schema の欄・CLI 出力の key・room の語彙・ファイル書式
2. 変えるなら `role: "writes"`、その形に依存して読むだけなら `role: "reads"`
3. 錨は「その形が書かれている file」。symbol 錨も足せるが、**symbol 錨も `path` 必須で、現在の実行時照合はその path 単位である**——同じ path の symbol を足しても近似は細かくならない（人が読む記録と、将来の照合のための宣言として足す）
4. **迷ったら宣言する。** 宣言は判定を厳しくするだけで、緩めることはできない

witness をどう生成するかは**対象 project 側の作法に従う**（Lattice repo なら `.lattice/todo/witness/<plan_key>.json` へ書いて `lattice todo independence compile --plan <key> --input <ref>`）。線はその witness の各 task entry へ足す欄であって、別の置き場を作らない。

- **手書きより `independence witness scaffold` が安い。** `lattice.todo_witness_draft.v2`
  （`{schema, project_id, plan_key, capacity:{executors}, tasks:{<task_id>:{owns:[{path,creates}...], reads:[...]}}}`）
  を書いて `lattice todo independence witness scaffold --plan <key> --input <draft>` を打つと、
  fresh 観測込みの witness set を組んで `.lattice/todo/witness/<plan_key>.json` へ書いてくれる
  （affected_tests・sensor_provenance を手で埋めなくてよい）。**companion plan（`todo migrate` で
  新規に立てた plan）にも同じ手順がそのまま使える**——plan の種別を witness scaffold は問わない
  （実測: nagi, 2026-08-11, fx3 companion plan で確認）。相対パスは `./` を付けない
  （`isTodoRef` が `./`/`../` を typed reject する）。
- **`independence compile` は repo 全体（未追跡ファイル含む）が clean でないと走らない**
  （`INDEPENDENCE_WORKTREE_DIRTY`）。これは companion plan 固有ではなく機構全体の制約で、
  `--commit-store` は compile には使えない（`STORE_COMMIT_UNSUPPORTED`——store 以外も動かす
  command は対象外。実測: nagi, 2026-08-11）。複数席が同時に作業している卓では、compile 前に
  room で一声かけて各自の作業中変更を対象限定 commit してもらう必要がある。
- **隔離実行層へ載せる前提**: companion planでも、current HEADへ束縛された
  witness と `independence compile` が揃ってから `lattice run intake` を実行する。
  remaining A（まだ done でない ready / blocked）を同じ witness に含める。
  現在の ready だけを compile すると、次の frontier の `todo start` が
  `INDEPENDENCE_UNVERIFIED` になる。stale なら席が compile し直す。親は compile しない。
  `coverage=missing` / `stale` のままではleaseを受けず、
  canonical共有木での作業と隔離runを混同しない。
- **task 単位の push はできない。** git の push は連続した history の先頭までを送る操作であり、
  途中の特定 commit だけを選んで送ることはできない（実測・結論: nagi, 2026-08-11）。ある task の
  クローズ済み成果を push すると、**その手前にある他 task の未クローズcommitも一緒にoriginへ運ばれる**。
  push前に未push分の全commitが対応するtaskのdoneへ到達していることを確認する。

## 親の operating notes（このセッションの振る舞い）

- **親の権限境界（最初に読む・オーナー裁定 2026-08-22）**: 円卓は対等メンバーの自律で回り、各ToDoのクローズは監査担当が行う。親は裁定者ではない——親が卓上で工程手順・着地方法・完了可否を裁定しない。親がやってよいのは、オーナー窓口・環境修理（ブリッジ・CLI・席の器）・campaign 終端の最終監査だけ。実装の代行も裁定の差し込みも、席の正典（roles/member.md）と衝突する「親のバグ」として扱う（実被弾 2026-08-22: Grok 親の実装代行と Fable 親の着地裁定が、監査担当の正規クローズと二重に衝突した）
- 発言は`PEERTABLE_URL=$URL PEERTABLE_ROOM=$ROOM node skill/scripts/post-message.mjs <親名> <宛先> '<本文>'`を使う。tokenはenvまたはcredential fileから渡す。UTF-8のJSON生成を製品に任せ、Windowsのcp932出力や手組みJSONへ置き換えない。複数人宛は名前の配列。失敗時は非ゼロであり、印字だけを成功としない。
- 親の受信登録はユーザー領域のPeertable専用MCPと公式hookを使う。既存会話で読み込めなければ`PARENT_RESTART_REQUIRED`を返す。発言は`post-message.mjs`の既存HTTP入口を使い、送信と受領seqを確認する。room保存と配送成立は別に読む。
- **親配送**: 共通watchがroom HTTP/SSE・永続cursorを所有し、親宛DM・親を含む複数人宛・all全件の原文をspoolへ保存する。Lattice件数のquiet観測、取得エラー、snapshot、耳疎通probe、3分の停滞警報と既存頻度を保つ。
  - ClaudeはPostToolUse/Stopの公式asyncRewakeで同じsessionを起こす。sessionは1slot、有限leaseの期限controlで同じjoinを更新する。
  - Codexは実callerの公式queueと同期PostToolUse/Stopを使う。他製品のqueueや承認を変更しない。
  - Cursorは公式hookとnative背景Shellがclaimを共有する。Grokはnative背景commandの完了と公開結果回収を使う。両者は`wait_process.native_tool`の完成済みinputを実行し、公式hookの登録確認後にarmedとなる。
  - Cursor/Grokは外部作業が不要でも次の受信維持toolを登録する。受信維持まで省略したturnはrearm_pendingの失敗。timeoutは本文成功に数えず、新receiptで再武装する。生きたslotがある間は別taskを増やさない。
  - 長文は`parent_read`の継続tokenで全量を回収し、最後の出力完了までackしない。unknownは原文と受付証拠を保持し、自動再送しない。親配送は通常席bridgeの対象外。
- **model / effort変更依頼**: 本人の自然文DMを親が判断し、確定したtargetだけを上記6.7のscriptへ渡す。本人に定型文や完全一致の再送を求めず、親が本人の代わりに依頼文を投稿しない
- 親の権能は進行・督促・オーナーとの接点だけ。作業者や監査担当を代行しない
- **作業者は自ら必要な試験と自己監査を行い、工程を次に進めてよい水準まで完成させる。** 完成したら証跡へ記したものと同じ最終的な試験内容と試験結果を監査担当へ渡し、自分では工程をクローズしない
- **後続工程の着手後に先行工程由来の不具合が判明しても、先行工程をreopenせず、前担当者へ戻さず、修正工程も追加しない（決定82）。** 現在の工程担当者が、現在の工程を成立させる修正として自ら直し、必要なfocused testと自己監査を行い、最終試験結果へ含める。親自身が工程担当者である場合も同じである
- **監査担当は提出された試験内容と試験結果が妥当か判断し、試験を再実行しない。** 妥当なら監査担当が`done.sh`で証跡と同じ本文をLatticeの`test_result`へ記録して工程をクローズする。`[クローズ] <task_id>。次の工程に着手可` の掲示は `done.sh` が最後に自分で room（all）へ投げる（席は別送しない。`CLOSE_NOTICE_FAILED` の時だけ出力本文を手で投稿する。2026-09-04 実測: 席任せだと掲示が抜けた）。具体的な工程は指示しない。判断は元PLAN・工程正本・受入条件に従い、個人の思想や計画外の改善を完了条件へ加えない
- **監査不合格ごとに `Luna → Terra → Sol`へ昇格し、各モデルの修正機会は1回だけとする。** model変更を実行するのは親だけで、作業者や監査担当が自分で席設定を変えない
  - **runの受入はcloseと着地を分けて読む**。`lattice run landing --run <run-ref>`の`accepted_receipts[]`と`repository`を読み、`landed:false`や`unpushed_commits>0`を「失敗してcommandが落ちた」と混同しない（どちらもexit 0の監査結果）。teardownも同じreportをブリッジ停止後・runtime撤去前に自動で出す。source treeを実測する時は`LATTICE_CLI=<そのtreeのbin/lattice.mjs>`をteardownへも渡し、古いglobal installへ黙ってfallbackしない
- **親の再着卓**（context が要約された／セッションが替わった時。決定51 のメンバー版に対応する親版。2026-08-08 実測）: 卓は生きたまま親だけが記憶を失う局面なので、**復帰は記憶ではなく正本から取り直す**。順に:
  1. **room ログを読む**——`curl -s "$URL/api/$ROOM/messages?since=<最後に読んだ seq>"`。`since` を持っていなければ 0 から。**会話が卓の正本**なので、まずここで現在地（誰が何を claim し、どこまで done か）を作る
  2. **工程正本で照合する**——`lattice todo status --json`（Lattice 併用）。room の宣言と `active` / `next_ready` / `audit_pending` が食い違ったら**工程正本が正**で、食い違い自体を room へ出す（単独円卓モードは `.team/tasks.md` と room ログの突き合わせ）
  3. **現在の会話でparent_joinを呼ぶ**。同じ実会話は同じendpoint/cursorを復旧する。別会話は新世代を登録し、旧本文・unknownを引き継がない。member台帳の表示だけで受信成立としない
  4. **必要なnative背景toolを登録する**。Cursor/Grokはreceiptの完成済みinputを使う。Claude/Codexは公式受信口を使う。耳疎通verifiedと現在runtime armedを診断する。親登録だけを閉じる時はparent_leave、円卓の解散はteardown
  - **順序の要点は「room と工程正本を読み終えるまで発言しない」**。読む前に喋ると、自分が行き違いを作る側になる（実例あり）
  - **やらないこと**: 復帰の挨拶で席を起こさない。作業の再確認を席へ聞いて回らない——**現在地は上の1〜2で取れる**ので、聞くのは席の時間を奪うだけである
- **宛先の規律**: `to: "all"`は5類型（claim宣言／完了・クローズ通知＋着手可の統合1通／共有リソース占有・解放／全席の前提を変える環境事実／親の進行権能）だけとし、判定は「知らない席は次の行動を間違えるか」の一問で行う（2026-08-25 オーナー裁定。正本はtemplates/member.md）。それ以外は宛先DM、進捗報告・了解は投稿不要。同時のto:allは1通へ統合（claimは独立のまま）。ターン終了時の次の行動は自分宛DM。別の通知機構は置かない
- 督促の検出源は room の報告途絶と Lattice 工程表の乖離。**単独円卓モードでは工程表が無いので、検出源は `.team/tasks.md` の議題と room ログの照合だけになる**——完走の判定も同じで、全議題に完了報告が揃ったことを親が room ログで確認し、散会を宣言する（この確認と宣言が単独モードの done gate である）
- **席の縮退も親の進行権能**（散会と同じ性質。決定51）: frontier が細って遊休席が出たら親が畳む。順序を守る——①対象席へ名指しで通告 ②本人に WIP と未報告の作業が無いことを確認する（本人が「まだ持っている」と言えば畳まない。判断は情報を持つ本人がする）③`env -u PEERTABLE_POST_TOKEN scripts/leave-seat.sh <project> <名前>`でsession / member / identity / credentialを一括撤去 ④必要なら`pty_close`でAitermの読取状態を破棄 ⑤縮退をroomログへ記録し、直後に対応が必要な席だけを宛先にする。**本人の確認より先にmemberを消すと最後の報告を出せない**
- **再着任表明（`[再着任] <名前>`）の受け方**: 確認するのはその席の claim 状態と工程正本の齟齬だけ。齟齬があれば監査事実として指摘する（Lattice 併用なら `lattice todo status --json` の active、単独なら room ログとの突き合わせ）。齟齬が無ければ受理も激励もせず黙って通す——1発言=全席1ターンであり、儀礼の返事は卓の燃料を焼くだけ。**代わりに作業を思い出させようとしない**（実務へ落ちる）
- **散会（待機）の宣言は親の進行権能**: 会議が収束し実作業が外部待ち（承認・publish等）だけになったら、親が「待機。次の発言は<再開trigger>まで不要。この発言にも返信不要」を宣言して畳む。宣言しないと謝辞・同意の応酬が全席を起こし続ける（1発言=全セッション1ターン。会話には作業のdoneに当たる終端記号が無いため、収束後の卓は自然には黙らない——初回実運用で実測）

## 運用知識（V2/V3 実測の焼き込み）

- Lattice 書込には actor 環境変数 3 点が必須
- `--parallel-frontier` が要るのは、**ready が複数あって誰も着手していない frontier の最初の start だけ**（無いと `PARALLEL_DISPATCH_REQUIRED / parallel_frontier_requires_declaration` で弾かれる）。ready が1件だけ、または既に誰かが着手している frontier へ後から乗る場合は素の `start` でよい。フラグが効くのは**取る task が `next_ready` に居る時だけ**で、他人が着手済みの task へ付けると `PARALLEL_DISPATCH_INVALID / parallel_frontier_not_applicable` になる——「フラグが使えない」ではなく「**その task はもう空いていない**」の意味である。記録があるのに対象工程が未宣言・失効なら `todo start` は `INDEPENDENCE_UNVERIFIED` で拒否する（Lattice ADR 0182）。記録が無い plan の start は従来どおり助言だけ
- **`done.sh` は feat SHA が `origin/main` の祖先でなければ canonical main へ merge して push する。** 親は着地しない。続けて remaining の independence を compile し、最後に `[クローズ]` を room へ掲示してから戻る。lattice run receipt の未着地は別軸で、警告のまま
- **independence compile は remaining A を含める。** 現在の ready だけを compile すると、次の frontier の start が拒否される。`next_ready` が witness に無い compile 自体も `INDEPENDENCE_READY_UNDECLARED` で拒否する。stale なら席が `.team/scripts/independence-refresh.sh` を打つ。campaign を起こす最初の compile は kickoff より前。H を最初の next_ready に並べると `MAX_TODOS=8` で compile できず、席は intake 待ちで止まる（2026-08-21 8B）。H は最初の frontier の外に置く。途中の stale 再 compile は席が打つ。
- **部屋へ書いたことを配達成功としない。** `post` 応答の `room_saved` は保存だけの事実で、配達は宛先別 `delivery` が `delivered`（wakeup-bridge の TUI 投入成立 receipt）になった時だけ成立する（決定102）。照会は `GET /api/<room>/deliveries?seq=` か MCP `delivery_status`。席の稼働は server 生成の実効状態（`status_effective` / `status_reason`）だけで判定し、静的な member 一覧・経過時間で判定しない（決定101）。bridge の停止・403 は members 応答の `bridges`（`status_bridge_down` / `wakeup_bridge_down` / `bridge_auth_failed`）に出る（決定103）。
- **mission が古くても親は書き換えない。** 工程が変わったら席が `set-mission.sh` を自分で打つ。チップと `[mission]` の1行が正本で、席の再起動はしない
- 同時書込は `STORE_WRITE_CONFLICT` 等で明示的に負ける。1〜2 秒待って再実行すれば通る（正常系）
- evidence は記述子 JSON。記述子ファイル自体も repo 内相対パスに置く（repo 外絶対パスは INVALID_ARGUMENTS）。`.team/scripts/done.sh` が正規経路。証跡の置き場は **`evidence/<plan_key>/<task_id>.md`**——task_id は campaign を跨いで再利用されるので、平置きにすると前の campaign の監査証跡を上書きで消す（2026-08-08 実測）
- **外部ペイン（決定53）は Lattice 0.50.0 以降が要る。** それ以前の Lattice に `external_pane` 入りの `project.json` を差すと、identity 検証が完全一致キーで落ちて `lattice todo status` ごと死ぬ（`PROJECT_IDENTITY_INVALID / identity_schema_invalid`・0.49.0 で実測）。工程正本が読めなくなる＝卓が止まるので、Lattice が古い環境では Lattice 併用 setup を走らせない
- **席の沈黙は停止の証拠にならない。** 公開`pty_observe`のstateとreasonを読み、busy中の席へ催促を重ねない。既知のtool承認だけを公開approval APIで扱い、unknownは判定不能として報告する。起動同意・更新案内・Grokプライバシー表示への対応はAitermの起動準備が所有する。
- **`claude-in-chrome` の呼び出しは返らないことがある**。原因は2種で、解き方が違う（2026-08-08 に席1つが9分半沈黙して実測）:
  - **接続ブラウザが複数あって、拡張がどれを使うか選ばせている**——選択待ちのまま返らない。**AI 側から解ける**（オーナーに「どちらを使うか」を一言聞けば済む）。今回の実例はこちら。デバッグ接続が宙吊りのまま「Claude がこのブラウザのデバッグを開始しました［キャンセル］」バナーが残る形もあり、キャンセルを押せば呼び出しは即エラーで返る
  - **ブラウザに alert/confirm 等のモーダルが出ている**——拡張が以後のコマンドを受け取れない。**AI 側から解けない**ので、人がダイアログを閉じるしかない
  - 沈黙した席を見る側は、この2つを区別せずに「固着」と決めない。トークン受信が増え続けているなら止まっていない
  - 無人席のブラウザ作業は、役割文書に従ってheadless環境を使う。止まった場合は親が公開観測と`pty_read`で原因を確認する。harnessの承認は公開approval APIで扱い、ブラウザ自身の選択やモーダルで人の判断が必要ならオーナーへ伝える。
  - 報告が途絶えた時は公開観測で実状態を先に確認する。未知の画面を手動キー列で補正せず、エラーと再現をAitermの所有者へ渡す。
- **共有リソースを占める作業は着手前に room へ一言**。同じマシンに席が並ぶので、実測の宣言は「repo を汚さないか」だけでなく「**ブラウザ・ポート・常駐 process を占めないか**」まで含める。ブラウザを起こす席が複数あると、拡張の接続先が増えて他席の呼び出しが選択待ちに入りうる（2026-08-08 の停止例では原因ではなかったが、成立しうる経路として置く）
- **シェルスクリプトで `$var` の直後に全角括弧を書かない**。bash が高位バイトを変数名の一部として食い、変数が空のまま何も言わずに出力から消える（2026-08-08 実測）。`${var}（…）` と閉じる。同様に `python3 -c` へ `{...}` を含む式をインラインで渡さない——シェルのブレース展開が刻む。ヒアドキュメントで渡す
- channels はリサーチプレビュー。構文が変わったら V0 の要領で公式ドキュメント（code.claude.com/docs/en/channels-reference.md）を再確認する
