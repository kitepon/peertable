# Peertable tooling friction — companion fixes 4

## 工程

### h1 teardownのroom URL表示をbyte完全に直す

`skill/scripts/teardown.sh`のメンバー登録解除報告が、`$room`直後の全角括弧を変数名へ
取り込んでURL末尾を文字化けさせる。既知の罠を正規script自身が踏んでいる。

`${url}/${room}`のように変数境界を閉じ、ASCII・日本語room名の両方で、実際のroom URLが
byte完全に報告される再現harnessを置く。撤去の成否、room原本保持、member解除の挙動は変えない。
担当外peer audit後、次のPeertable配備へ載せて実teardownでsmokeする。

### h2 launch-seatのbriefを事前検証し半端な着席を残さない

長いbriefを渡すと、model preflight、tmux着席、member登録、seat identity、bridge起動まで済んだ後の
`tmux send-keys`で`command too long`となり、席を残したままlauncherだけ非ゼロ終了する。

briefの輸送上限と送信方式を着席前に検証し、受理する長文は確実に送信、受理できない入力は
副作用ゼロでtypedに拒否する。送信後は入力欄へ置いただけでなく、turnが開始した事実を観測する。
負のcontrolで旧版が同じ長文に失敗し、修正版では着任turnが始まることを固定する。
担当外peer audit後、次のPeertable配備へ載せて実Codex席でsmokeする。

### h3 Codex席の必須room MCPを無関係MCP失敗から分離する

Codex席の起動で無関係なglobal MCPが失敗・初期化打切りになると、launcherが明示した`room`まで
`MCP startup interrupted`へ巻き込まれ、member登録上は着席済みなのに会話正本へ参加できない。

円卓の必須面はroomだけである。launcherはroomの初期化成功を着席条件として実測し、無関係MCPの
失敗でroomを失わない起動構成にする。room不成立なら着席成功に丸めず、作成したtmux/member/identityを
回収して原因と再実行条件を返す。担当外peer audit後、実Codex席でroom read/postをsmokeする。

### h4 setupがgit追跡済みteam資産を上書きしない

対象repoに過去からgit追跡されている`.team/scripts/done.sh`がある状態でsetupを行うと、
`.git/info/exclude`では追跡済みfileを隠せず、setupが既存資産を上書きしてworktreeをdirtyにした。

setupは書込前に`.team/`配下の追跡済み・既存資産を判定し、所有していない資産を1 byteも変えずに
typed failureする。前卓の正規teardown残骸と、projectが意図して追跡する`.team`資産を区別し、
黙って削除・退避・上書きしない。負のcontrolとteardown後diffゼロを実測する。
担当外peer audit後、次のPeertable配備へ載せて実repo setupでsmokeする。
