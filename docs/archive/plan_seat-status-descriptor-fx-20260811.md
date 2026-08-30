# 観測記述子 campaign の締め（seat-status-descriptor-fx-20260811）— 計画正本

`seat-status-descriptor-20260811`（t1〜t4・done）で残った**親が持つ範囲**を工程正本へ載せる。

## なぜ別 plan を立てるか

第1 plan は席が実装する4 task だけを起票し、**受入・文書・版・publish を起票しなかった**。
その結果 `lattice todo status` が「全部 done」を返す一方で作業が残り、**工程正本と実態が食い違った**
（オーナーが 2026-08-11 に指摘）。AI のコンテキストと Markdown だけに残る作業を作らない。
既存 store への追加は `todo migrate`（`plan create` は空 store 専用・AGENTS.md）。
`todo revise` は reconciliation digest を伴う plan 再構成の経路なので、追加には使わない
（`roundtable-ux2-20260810` → `roundtable-ux2-fx-20260810` と同じ fx plan の慣行に倣う）。

## 現在地（2026-08-11 時点の実測）

- 第1 plan の t1〜t4 は done。差分は親が全部読み、**t3/t4 を一度 reject → 再修正 → t3 は親が引き取って仕上げた**
- 親が見つけて直した欠陥3件: `ensure-bridge.sh` の record 破壊（`"\\n"` がリテラルになり JSON が壊れ、
  `--stop` も再起動も不能）／stale `ready_at` による偽の起動成功／**tmux セッションへ env を渡しておらず
  `PEERTABLE_TMUX_SOCKET` の手渡しが消えていた**
- 受入の到達状況: **A-1・A-2・B・E・F は 15/0 で通過**。**C は走行中**（04:23:12Z 開始・要 30 分）。
  **G で回帰1本を検出**（`bridge-catchup-repro.mjs` が base rc=0 → 現在 rc=1。他7本は着手前から赤）

## タスク

### f1 wakeup-bridge の catch-up 回帰を直す

`experiments/bridge-catchup-repro.mjs` は campaign 着手前（5871e5b）で rc=0、現在 rc=1。
**この campaign が入れた回帰**である。原因は `wakeup-bridge.mjs:69-74` の `refreshMembers()`:

- `await refreshMembers()` を**module top-level で try 無しに呼んでいる**ため、`/members` が
  返らない相手だと `res.json()` が `SyntaxError: Unexpected end of JSON input` を投げて
  **常駐が起動時に落ちる**。旧コードは `/members` を一切必要としなかったので、明確な後退
- 同じ呼び出しが `wake()`（`:91`）にも在り、失敗すると catch に落ちて**起床そのものが失敗する**。
  旧コードは常に `peer-<seat>` へ送れた

**直し方**: `refreshMembers()` を**非致命**にする。失敗したらログ1行を出して**直前の map を保つ**だけにし、
起動時の呼び出しも `wake()` 内の呼び出しも例外を外へ出さない。`wake()` は既に
`?? { name: seat }` の legacy 保険を持つので、refresh が落ちても**旧 `peer-<seat>` 相当へ縮退**して
起床は続く。**「取れなければ黙って別経路」ではない**——縮退したことはログに出す。

**検証**: `node experiments/bridge-catchup-repro.mjs` が green に戻ること。
加えて `/members` を返さない相手で常駐が起動を続けることを実測する。

### f2 受入 A〜G を実測し、結果を証跡へ残す

第1 plan の計画正本 `docs/plan_seat-status-descriptor-20260811.md` §受入 の A〜G を親が回す。
**手動 POST は green と数えない**（client 自己申告が壊れていても通ってしまう）。

到達済み（再実行して確定させる）: A-1 実 `launch-seat.sh` / A-2 素 pane の client 自己申告 /
B busy・busy_since・idle / E wakeup と teardown が `peer-` でない席を扱える / F 後方互換と server 無変更。
残り: **C**（親シェル終了後 30 分以上 `status_at` が更新され続ける。走行中）と
**G**（f1 の回帰修正後に全ハーネス再走。**着手前から赤い7本は本 campaign の範囲外**として
名指しで記録し、緑に見せかけない）。

**証跡**: `evidence/seat-status-descriptor-fx-20260811/f2.md` に、項目ごとの実測値
（C は開始・終了時刻と `status_at` の推移、G は本数と赤7本の内訳）を書く。

### f3 SKILL.md を観測契約と ensure 経路へ同期する

- 6.5 を観測記述子の契約へ書き換える（`observe: {tmux_socket, tmux_target}`・書き手は
  `launch-seat.sh` と `room/client.mjs` の自己申告・記述子が無い member は `peer-<name>` へ後方互換）
- 手順 6 / 6.5 / run-bridge の**手 `nohup` を `ensure-bridge.sh` へ**置き換える。
  ensure は `ready_at` を待って起動を確かめ、確かめられなければ非ゼロで落ちることを書く
- **Windows + WSL の二重 install 注記**: bridge は WSL の tmux を読むので **WSL 側の版が正**。
  片方だけ更新すると「更新したのに直らない」になる（依頼の付記。gate は作らず手順書に明記する）
- socket 解決順（明示 env → aiterm POSIX 既定 → `/tmp/aiterm-*.sock` の検証付き発見1本 → 既定パス）と、
  bash からは `tmux-socket.mjs` を呼ぶこと

### f4 docs/plan.md へ決定74 と非目標を記録する

- **決定74**: 観測は名前からの推測でなく記述子で決める／常駐は tmux が持ち、起動は `ready_at` で確かめる
- 第1 plan の計画正本 §非目標に挙げた**7件を `docs/plan.md` の §既知の穴へ移す**。
  特に **room 不達で bridge が「黙って無になる」**（`seat-usage.mjs:64` で `attempted===0` → `verdict:'idle'`）は
  オーナーが「検出したら粘る」を裁定済みだが、検出機能自体が範囲外だったので**未消化のまま残る**。
  実装しなかったものを黙って消さない
- 今回 親が見つけて直した3件（record 破壊・stale ready_at・env 不達）を実測付きで記録する

### f5 0.3.8 へ bump して publish する

**H 操作。オーナー承認済み（2026-08-11）だが、f2 の受入が全通過するまで実行しない。**

`package.json` を 0.3.8 へ。`npm pack --dry-run` の files に新規
（`skill/scripts/ensure-bridge.sh` / `skill/scripts/tmux-socket.mjs` / `experiments/` の新規3本）が
入ることを確認。`scripts/verify-release-commit.mjs` で既定ブランチ祖先を検証してから publish し、
`npm view peertable version` で公開後 smoke。

**WSL handoff**: publish 後、ChromeBlocker 端末で **WSL 側**の `npm install -g peertable@0.3.8` と
**skill 実体（symlink 先）の更新**を両方行い、受入1〜3 と一時手当3点の撤去を実測してもらう手順を報告に出す。
**macOS では nohup 版が死なない**ため、nohup との対照実験は WSL 側でしか取れない——ここで取れないことを黙って省略しない。

### f6 第1 plan の terminal-audit gate を閉じる

`seat-status-descriptor-20260811` の `terminal-audit` phase が `gate_ready` のまま残っている。
f2 の受入結果を証拠に `lattice todo phase review` で閉じる。
**受入が通っていない状態で `close-unaudited` で流さない。**
