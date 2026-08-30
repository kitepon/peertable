# 稼働状態の観測記述子 campaign（seat-status-descriptor-20260811）— 計画正本

本書がこの campaign の工程正本である。起票は `lattice todo migrate` でこの文書から行う。
`docs/plan.md`（決定履歴の正本）へ相乗りさせない——commit はファイル単位なので、別 campaign の
未 commit 変更を巻き込んで公開へ出す（2026-08-10 実測）。決定74 の本文だけは完了時に `docs/plan.md` へ入れる。

## 何を直すか

peertable 0.3.7 の席稼働状態表示が ChromeBlocker（Windows 11 + WSL2・aiterm-mcp 運用）で**一切動かない**。
server は `capabilities.member_observation_v1 = true` を返すのに `GET /members` に `status` が入らない。

根は1つ——**観測先とホスト環境を、実際に知っている者から受け取らず、peertable 側が名前と固定パスから推測している。**

### 実測で確定した事実（全部コードを読んで確認済み・2026-08-11）

| # | 症状 | 実測 |
|---|---|---|
| 1 | bridge を誰も起こさない | **起こしている**（`skill/scripts/setup.sh:172` の `nohup`・決定73・0.3.7 に含まれる）。欠けているのは**起こした後の生存確認** |
| 2 | socket 解決が固定 | 固定なうえ **TMPDIR 未設定の Linux/WSL で壊れる**（実測: bash → `claude-tmux-sockets/claude.sock`（相対）／node → `undefinedclaude-tmux-sockets/claude.sock`）。同じ式が**4箇所に散り、全部微妙に違う** |
| 3 | セッション名が `peer-${name}` 固定 | そのとおり。**status bridge だけでなく `wakeup-bridge.mjs:67` と `teardown.sh:63` にもある** |
| 4 | nohup が死ぬ | そのとおり。pid は記録されるが生存確認も再起動も無い |

aiterm の socket 規則（`aiterm-mcp/src/core.ts:26-35`）は POSIX が `join(TMPDIR ?? "/tmp", "claude-tmux-sockets", "claude.sock")`、
**Windows host のときだけ** `/tmp/aiterm-<sha1(Windows側SOCKDIR)[0:12]>.sock`。
ハッシュ元が Windows のパスなので **WSL 内からは計算できない**——だから「検証付き発見」が正解で、記述子が第一。

## 設計 — 機構は3つだけ

### (1) 観測記述子

```jsonc
POST /api/<room>/members
{ "name": "codex", "observe": { "tmux_socket": "/tmp/aiterm-xxxx.sock", "tmux_target": "seat-codex" } }
```

**表示名と tmux セッション名を分離する。** `peer-${name}` の推測をやめる。書き手は2つ:
`launch-seat.sh`（自分が作った socket / session）と `room/client.mjs`（`$TMUX` / `$TMUX_PANE` から自己申告）。
**後者が aiterm 席をゼロ設定で観測対象へ戻す経路。** 取れない時は**欄を省略し、理由を stderr へ1行出す**。

記述子が無い member は `peer-<name>` へ後方互換で落とす。socket 内の全セッション走査はしない（誤観測する）。

**server は無変更。** `room/server.mjs:159-176` が既に任意欄を upsert し、`GET /members` が `{name, ...meta}` で返す。
`MEMBER_EVENT_FIELDS`（`:82`）に `observe` は含まれないので SSE 再描画も増えない。**「変えなくてよい」ことを試験で固定する。**

### (2) socket 解決を1箇所に集約

`resolveTmuxSocket(env, probe)`: ①明示 env ②aiterm POSIX 既定（`tmux -S <sock> ls` が通る時だけ）
③`/tmp/aiterm-*.sock` の検証付き発見（**ちょうど1本なら採る**）④複数なら採らず候補を返す ⑤無ければ既定パス。
例外は投げず `{socket, source, candidates, error}` を返す。**bash 側4箇所は `tmux-socket.mjs` を呼ぶ**——規則を二重に書かない。

### (3) supervisor

`ensure-bridge.sh <project> <seat-status|wakeup|run> [args...]` に**3本の起動口を一本化**する。
常駐は専用 tmux セッション `peertable-<bridge>-<room>` が持つ（tmux は呼び出し元シェルの寿命に縛られない）。
**pid 生存は「届いた」の証拠にならない**ので、各 bridge が初回の実成功で `ready_at` を書き、ensure は**それを待つ**。
出なければ**ログ末尾を stderr へ出して非ゼロ**——「起こした」と言って終わらない。

## 非目標（やらないこと）

いずれも敵対的検証（Codex sol×xhigh 2巡）で出た**真の欠陥**だが、上の4症状にも受入3点にも効かない。
黙って抱えず、campaign 完了時に `docs/plan.md` §既知の穴へ記録して別依頼へ出す。

1. **room 不達で bridge が「黙って無になる」**（members GET 失敗が `attempted===0` → `verdict:'idle'` に落ちる。
   `seat-usage.mjs:64`）。オーナーは「検出したら粘る」を裁定済みだが、**検出機能自体が本 campaign の範囲外**
2. fetch に deadline が無く `setInterval` が前 tick を待たない（WSL の半開き TCP で tick が並走する）
3. `$TMUX` が無い環境の ppid 鎖 fallback（**`$TMUX` で足りるかまだ実測していない**。今回は理由を1行出すまで）
4. session 名 target が split 時に別 pane を掴む（pane_id で解決するが、**この誤観測はまだ観測されていない**）
5. 二重 install の機械 gate（依頼は「手順書に明記してほしい」なので手順書まで）
6. `change-effort.sh` の aiterm 管理外席への対応
7. 心拍30秒／減衰90秒の刻み直し（`docs/plan.md` に「実装しない」として既出）

## 既知の罠（席は着手前に読む）

- **`${TMPDIR}` を素で連結しない。** Linux/WSL は TMPDIR 未設定が普通で、bash は相対パス・node は `undefined…` になる。
  `join(env.TMPDIR || '/tmp', …)` が正（aiterm と同じ規則）
- **`teardown.sh` の `$seats` を JSON へ置換しない。** 席停止だけでなく**解散本文**（`teardown.sh:250`）と
  **member DELETE**（`:259-263`）にも再利用されている。`for name in $seats` が JSON token を名前として処理して壊れる
- **200 は保存の証拠にならない。** 素性欄を知らない server も 200 を返して黙って捨てる。読み返して確かめる
- **`observe` を `MEMBER_EVENT_FIELDS` へ足さない。** 足すと記述子更新のたびに SSE 再描画が走る
- **`.team/seats/<name>.json` の6欄を増やさない。** `lattice.pull_worker_attach_input.v1` の exact 集合から
  `schema` を除いたものと一致させてある（`launch-seat.sh:123-126`）
- **変数展開の直後に全角括弧を置かない**（bash が高位バイトを変数名の一部として食う。2026-08-08 実測）

## タスク

### t1 socket 解決と観測記述子を seat-usage.mjs へ集約する

本 task は `skill/scripts/seat-usage.mjs`・`skill/scripts/tmux-socket.mjs`（新規）・
`experiments/seat-socket-discovery-repro.mjs`（新規）・`experiments/seat-observe-descriptor-repro.mjs`（新規）・
`experiments/seat-status-socket-repro.mjs`（更新）を**単独で所有する**。他のファイルは触らない。
**これが全 task の土台**なので、export の名前と戻り値の形を勝手に変えない（t2〜t4 が写して使う）。

**(a) `defaultTmuxSocket(env)`** — aiterm の POSIX 規則をそのまま写す:
`join(env.TMPDIR || '/tmp', 'claude-tmux-sockets', 'claude.sock')`。
現行 `seat-usage.mjs:24` の `` `${env.TMPDIR}claude-tmux-sockets/claude.sock` `` は
**TMPDIR 未設定の Linux/WSL で `undefinedclaude-tmux-sockets/claude.sock` になる**（実測）。
`env.TMPDIR` が空文字のときも `/tmp` へ倒す（`||` であって `??` ではない）。

**(b) `resolveTmuxSocket(env, probe)`** — **例外を投げず**判定結果を返す:
`{ socket, source: 'explicit'|'default'|'discovered'|'none', candidates: string[], error: null|{code,message} }`
1. `env.PEERTABLE_TMUX_SOCKET` があれば `source:'explicit'`
2. `defaultTmuxSocket(env)` を `probe.serverAlive()` が通る時だけ `source:'default'`
3. `probe.listAitermSockets()`（`/tmp/aiterm-*.sock`）を `serverAlive` で絞り、**ちょうど1本なら** `source:'discovered'`
4. 2本以上なら `socket:null` / `source:'none'` / `candidates:[…]` / `error:{code:'PEERTABLE_TMUX_SOCKET_AMBIGUOUS'}`
   ——**推測で選ばない**。候補は全部返す（呼び手が人へ出せるように）
5. 1本も無ければ `defaultTmuxSocket(env)` を `source:'default'` で返す
   （新規セッションを作る `launch-seat.sh` にはこれが正しい。**存在しない socket を返すのは失敗ではない**）

`probe` は注入口にする（既定は実 tmux。`resolvePostToken` の `readFile` と同じ作法）。既定実装:
`serverAlive(sock)` = `execFileSync('tmux', ['-S', sock, 'ls'])` が 0 終了、
`listAitermSockets()` = `/tmp` を readdir して `aiterm-*.sock` に一致するもの。**どちらも throw しない**（catch して false / []）。

**(c) `resolveSeatObservation(member, defaultSocket)`** — 観測先を決める。**`peer-${name}` の推測をここへ閉じ込める**:
- `member.observe` が object で `tmux_target` が非空文字列 →
  `{ socket: member.observe.tmux_socket || defaultSocket, target: member.observe.tmux_target, source: 'descriptor' }`
- それ以外 → `{ socket: defaultSocket, target: \`peer-${member.name}\`, source: 'legacy' }`（後方互換）
- `defaultSocket` が falsy でかつ記述子も socket を持たない → `null`（観測できない）
- **socket 内の全セッション走査はしない。**

境界の検証は「型と空でないこと」までにする（tmux へは `execFileSync` の引数で渡すので shell 注入は起きない。
`-t` は次の引数を値として取るので `-x` のような値も安全）。**過剰なチェック機構を作らない**（AGENTS.md）。

**(d) `tmux-socket.mjs`（新規 CLI）** — bash 側4箇所（`launch-seat.sh:23` / `teardown.sh:62` /
`change-effort.sh:93` / 将来の `ensure-bridge.sh`）が同じ規則を写さないための薄い入口。
解決できたら socket を stdout へ1行、`AMBIGUOUS` なら**非ゼロ**で候補を stderr へ。`--source` で source も出す。

**(e) 再現ハーネス**:
- `seat-socket-discovery-repro.mjs`: TMPDIR 未設定で `undefined…`／相対パスを返さない ／
  明示 env が最優先 ／ 検証付き発見が1本を採る ／ 2本で `AMBIGUOUS` と候補全部 ／ 0本で既定パス
- `seat-observe-descriptor-repro.mjs`: 記述子が `peer-<name>` に勝つ ／ 記述子なしは legacy へ落ちる ／
  記述子の socket が空なら defaultSocket を使う ／ `defaultSocket` null かつ記述子に socket 無しで `null`
- `seat-status-socket-repro.mjs`: 新シグネチャへ追従（現行は文字列を返す前提で書かれている）

**検証**: `node experiments/seat-socket-discovery-repro.mjs` ほか3本を green にする。
**欠陥版で落ちることを先に確認してから green を読む**（測定器を先に疑う・決定60）。実 tmux は使わない（probe 注入で足りる）。

### t2 bridge と client を記述子ベースにする

本 task は `skill/scripts/seat-status-bridge.mjs` と `room/client.mjs` を**単独で所有する**。
t1 の export を使う（**再実装しない**）。t1 完了まで着手できない。

**(a) `seat-status-bridge.mjs` の観測先を記述子で決める。**
- `seats()`（`:85-89`）が `members.map(m => m.name)` をやめて **member オブジェクトの配列**を返す
- `readSeat` が `resolveSeatObservation(member, defaultSocket)` の結果（socket + target）で観測する。
  **`:92` の `` const target = `peer-${name}` `` を撤去する**——これが aiterm 席（`seat-codex` 等）を
  観測対象外に落としていた根本原因
- socket は **member ごとに違いうる**ので、`tmux()` ヘルパ（`:82`）を socket 引数付きへ変える
- 既定 socket の解決は**遅延させる**——記述子を持つ member は既定 socket を要らないので、
  `AMBIGUOUS` でも記述子付きの席は観測し続ける。理由は初回に1回だけログへ出す
- `last` Map のキーは `name` のままでよい（記述子は席の実体に紐づくので、同名で別席へ移る運用が無い）

**(b) 初回 tick 後に `ready_at` を書く。** pid（`:77` で起動直後に書かれる）は「届いた」の証拠にならない。
`.team/seat-status-bridge.json` へ `ready_at`（ISO）を追記する。書くのは
**members GET と capability 判定が成功した初回 tick の直後**（席ゼロでもよい——席がまだ立っていない卓は正常）。
`ensure-bridge.sh`（t3）がこれを待つ。**書込は一時 file → rename で原子的に**（ensure が部分読取しないように）。

**(c) 初回に解決の内訳を1回だけ診断出力する**（stderr）:
既定 socket をどう解決したか（source と、`AMBIGUOUS` なら候補一覧）／記述子を持つ member 数と持たない member 数。
**「1席も見えない」を診断できる形にする**のが目的。毎 tick 出さない（ログが埋まる）。

**(d) `room/client.mjs` が自分の観測先を名乗る。** `IDENTITY`（`:124-129`）へ `observe` を足す。
- tmux の中で動く席は `$TMUX`（= `<socket_path>,<server_pid>,<session_index>`）と `$TMUX_PANE` を持つ。
  socket は `$TMUX` の**カンマ区切り1つ目**。session 名は
  `tmux -S <socket> display-message -p -t "$TMUX_PANE" '#S'` で取る
- **登録のたびに載せる**（`IDENTITY` と同じ理由——1回きりの経路に置くと member の状態が失われた時に戻らない）
- **取れない時は欄ごと省略する。`null` を送らない**——`{...known,...meta}` の merge で
  `launch-seat.sh` が載せた記述子を消してしまう
- **取れなかった理由を stderr へ1行出す**（`peertable-client: observe unavailable: TMUX 不在`）。
  **黙って落とさない**——WSL 実測で「自己申告が効いているか」を判別する唯一の手掛かりになる
- `tmux` が無い環境・`display-message` が失敗する環境で**例外を投げない**（client の起動を妨げない）

**検証**: 使い捨て room を自分で起こし（`PEERTABLE_DATA=$(mktemp -d) PEERTABLE_PORT=<空きポート> node room/server.mjs`。
**ポートは着手前に room で宣言してから取る**）、①tmux セッション内から `peertable-client` を起こすと
`GET /members` に `observe` が載る ②tmux 外から起こすと欄が無く理由が1行出る ③記述子付き member を
bridge が `peer-` 以外の名前で観測できる、を実測する。**本番 room へは触らない。**

### t3 ensure-bridge.sh を作り nohup を置換する

本 task は `skill/scripts/ensure-bridge.sh`（新規）・`skill/scripts/setup.sh`・
`experiments/bridge-supervisor-repro.sh`（新規）を**単独で所有する**。t1 の `tmux-socket.mjs` を使う。

**(a) `ensure-bridge.sh <project> <seat-status|wakeup|run> [args...]`**
- 記録 file は既存の `.team/<name>-bridge.json`（`seat-status-bridge.json` / `wakeup-bridge.json` /
  `run-bridge.json`）。**新しい pid file を作らない**——teardown の `--stop` 経路が既存名を見ている
- 既に pid が生きていれば**何もせず 0 で返る**（冪等）
- 起こす時は**専用 tmux セッション** `peertable-<name>-<room>` を **`tmux-socket.mjs` が解決した socket 上**に作り、
  `node <script> <project> <args…> >> .team/<name>-bridge.log 2>&1` を走らせる。
  **`nohup` を使わない**——`wsl -e bash -lc` 経由だと呼び出し元シェルの終了で殺される（実測）。
  tmux は呼び出し元の寿命に縛られない
- セッション名が `peertable-*` なので `teardown.sh` の `peer-*` 掃討には巻き込まれない（**`peer-` で始めない**）
- **起動後に `ready_at` の出現を待つ**（最大15秒・0.5秒間隔）。出たら成功。
  出なければ**ログ末尾20行を stderr へ出して非ゼロ**。**「起こした」と言って終わらない**
- 直前の終了が書き込み拒否（`WRITE_DENIED`）だった記録が残っていれば、**起こさず理由を出して非ゼロ**。
  `--force` で上書きできる（構成ミスは人が直すまで直らない・決定73 を維持）
- 引数を省略して呼ばれたら、記録に残した args を再利用する（席起動のたびの re-arm 用）

**(b) `setup.sh:168-173` の `nohup` を置換する。**
`ensure-bridge.sh "$proj" seat-status` を呼び、**結果をそのまま報告する**。
setup は `set -e` なので明示的に `||` で受けて、失敗しても scaffold は完了扱いにする
（bridge は演出であって必須経路ではない）が、**成功していないのに「起こした」と出さない**。

**(c) `experiments/bridge-supervisor-repro.sh`**
- **呼び出し元シェルを終了させても常駐が生きる**——`bash -c 'ensure-bridge.sh …'` の子から起こし、
  その shell の終了後に pid が生きていること。**同じ手順を `nohup` 版で先に走らせて落ちることを確認する**
  （測定器を先に疑う・決定60）
- 二重起動しない（連続2回呼んで pid が変わらない）
- `ready_at` が出ない状況（存在しない script を指す等）で**非ゼロ＋ログ末尾**が出る
- 後始末で作った tmux セッションと一時 project を必ず消す（**`peer-*` を一括で消さない**——他卓を巻き込む）

**検証**: 上のハーネスを green にする。実 tmux を使うが、**socket は使い捨て**（`$(mktemp -d)/t.sock`）にして
稼働中の卓へ触れない。`.team/` は `$(mktemp -d)` 配下に作る。

### t4 launcher と他2ブリッジを記述子・新 resolver へ揃える

本 task は `skill/scripts/launch-seat.sh`・`skill/scripts/wakeup-bridge.mjs`・`skill/scripts/teardown.sh`・
`skill/scripts/archive-room-log.py`・`skill/scripts/run-bridge.mjs` を**単独で所有する**。
t1 の export と `tmux-socket.mjs` を使う。t3 の `ensure-bridge.sh` を**呼ぶ**が中身は触らない。

**(a) `launch-seat.sh`**
- `:23` の socket 式を `tmux-socket.mjs` の呼び出しへ置換する
- metadata POST（`:191-201`）へ `observe: {tmux_socket: <sock>, tmux_target: <sess>}` を載せる。
  読み返し確認（`:208-219`）にも `observe` の有無を含める（**200 は保存の証拠にならない**）
- Codex の closed-mode env（`:68`）へ **`TMUX` と `TMUX_PANE` を追加する**——親 env を継がないので、
  これが無いと Codex 席の client は自己申告できない
- 末尾で `ensure-bridge.sh "$proj" seat-status` を呼ぶ（席が1つ立つたびに常駐が復帰する）。
  **失敗しても席は着席済みなので落とさない**が、黙って飲まない

**(b) `wakeup-bridge.mjs`**
- `:26` の socket 式を t1 の resolver へ置換する（**同じ壊れた式**）
- `:67` と `:69` の `` `peer-${seat}` `` を **member ごとの記述子**へ置換する。
  member 一覧を room から引き、`resolveSeatObservation` で target を決める。
  **直さないと status は見えるのに Codex 席が起きない**
- SSE 接続成功（`:173` の `log('SSE 接続')` の位置）で `ready_at` を記録へ書く（t3 の ensure が待つ）

**(c) `teardown.sh` + `archive-room-log.py`**
- `archive-room-log.py` へ `--members --json` を足す（member ごとの `{name, observe}` を JSON で出す）。
  **既存の `--members`（空白区切りの名前列）は互換のまま残す**
- `teardown.sh:62` の socket 式を `tmux-socket.mjs` へ置換する
- 席の終了（`:63-76`）を記述子ベースにする。**ただし `$seats` を JSON へ置換しない**——
  `$seats` は**解散本文**（`:250`）と **member DELETE**（`:259-263`）にも再利用されている。
  停止用の `members_json` と、表示・DELETE 用の `seat_names` を**分離**する。
  `for name in $seats` が JSON token を名前として処理して壊れる形を作らない
- 3本の bridge 停止後に `peertable-*-<room>` セッションの残存ゼロを確認して報告へ出す

**(d) `run-bridge.mjs`**: 初回の `run list` 成功で `ready_at` を記録へ書くだけ。**本体ロジックは触らない。**

**検証**: 使い捨て room と使い捨て socket で、①`peer-` 以外の名前の tmux セッションを wakeup が起こせる
②teardown が同じ席を畳める ③空白を含む member 名で `for name in $seats` が壊れない、を実測する。
`launch-seat.sh` は**実際に席を立てる検証をしない**（稼働中の卓と衝突する）——
usage・引数検証・`tmux-socket.mjs` 委譲が効いていることまで。**本番 room へは触らない。**

## 親が持つ範囲（席は触らない）

- 受入 A〜G の実測（ローカル room を親が起こす。**本番 room へは書かない**）
- `skill/SKILL.md`・`docs/plan.md`（決定74）・`package.json`（0.3.8）
- commit（pathspec 明示）・push・publish（H 操作・承認済み）
- Phase gate: 差分の第三者レビュー（Codex 旗艦×medium・クロスprovider）と、
  **公開契約 `observe` の反証**（最上位 `fable`×high をスポット1回。F 相当）

## 受入（publish 前 gate）

**手動 POST は green と数えない。** 手で `observe` を入れると、client 自己申告が壊れていても通ってしまう。

- **A** 実経路で記述子が載る: ①`launch-seat.sh` の席 ②`pty_open` の素 pane から手起動した席（`peer-` 以外の名前・
  **fresh member**）。いずれも `GET /members` に `observe` と `status` が入る。`$TMUX` が取れない構成では
  **欄が省略され理由が1行出る**ことも確認する（黙って落ちない）
- **B** pane に `esc to interrupt` を出す → `busy` + `busy_since`、消す → `idle`
- **C** `bash -c 'ensure-bridge.sh …'` の子から起こし、**その shell を終了させて 30 分以上**放置しても
  `status_at` が更新され続ける。**`nohup` 版で先に落ちることを確認してから** green を読む（決定60）
- **D** 起動直後に死ぬ状況で ensure が**非ゼロ＋ログ末尾**を出す
- **E** 一時手当3点（`peer-codex` 別名／手動常駐／`PEERTABLE_TMUX_SOCKET` 手渡し）すべて無しで A〜C が通り、
  **wakeup が `seat-codex` を起こせる**／**teardown が `seat-codex` を畳める**
- **F** `observe` を持たない member が `peer-<name>` で従来どおり観測される／**server 無変更で往復する**
- **G** `experiments/*-repro.*` 全 green ／ `npm pack --dry-run` の files に新規ファイルが入る

## 席の配置（`docs/02_models.md` の決定表を写す）

| 役割 | モデル | effort | 根拠 |
|---|---|---|---|
| 実装席 ×4 | `gpt-5.6-terra` | medium | 「実装物量（外部枠）」既定行（$2.5/$15）。`implementer.toml` の公認例外と同値 |
| 第三者レビュー ×1 | `gpt-5.6-sol` | medium | 「第三者レビュー」行。Phase gate で差分1回 |
| `observe` の反証 ×1 | `fable` | high | 公開契約＝F 相当。最上位のスポット呼び |

**xhigh は既定禁止**（high との有意差を実測できた時のみ・理由記録）。
