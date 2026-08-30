# 円卓UX 第2次 campaign（roundtable-ux2-20260810）— 計画正本

工程正本は peertable store の plan `roundtable-ux2-20260810`（本書から `todo migrate` で起票）。
証跡は `evidence/roundtable-ux2-20260810/<task_id>.md`。

本書を `docs/plan.md` へ相乗りさせないのは、起票時点で別 campaign（`live-window-activity`・決定72）が
`docs/plan.md` を未 commit で編集中であり、commit がファイル単位である以上、相乗りすると
**他人の未監査 commit を巻き込んで公開へ出す**ためである（§11 backlog が記録している既知の穴）。

## 背景 — 計画書が現実より古かった

`docs/plan.md` §15「円卓UX campaign」は「起票のみ」と書かれたままだが、実コードを当たると
p2/p3/p5/p6 は大半が着地していた。工程正本が Lattice store 側（`roundtable-ux-20260809` plan）に
あり、そちらで accept まで進んだのに plan.md へ同期されていなかった。

**表示コードが在ることと、値が届いていることは別である。** 本 campaign の起点になった p2 は、
`room/server.mjs` に effort を出す行が在ることを根拠に「着地」と判定されていたが、オーナーの実機観測が
それを否定した。本番 room の実測:

```
iine    momiji  codex  / gpt-5.6-sol  effort='medium'   ← 入っている
        suzu    codex  / gpt-5.6-sol  effort='medium'   ← 入っている
        hina    claude / sonnet       effort=None       ← 落ちている
lattice bell    claude / fable-5      effort=None       ← 落ちている
```

## 塞ぐ4点

1. **Claude 席の effort が永久に空欄**（p2 が実質未達）。`launch-seat.sh:186` は effort が渡された時だけ
   登録し、`SKILL.md:32` の既定が「CLI 既定」＝無指定。Codex は `model_reasoning_effort` へ渡す必要が
   あるので親が必ず指定するが、Claude は指定されないまま立つ。「欄が無い＝CLI 既定で走っている」という
   区別を作ったが、**見る側にはただの空欄**である。`claude --effort <level>` は実在する（v2.1.226 で確認）。
2. **稼働アイコンの切り替わりが最大38秒遅れる**（p6 の受入条件を削っている）。bridge は tmux を8秒ごとに
   見て変化した瞬間に POST する（`seat-status-bridge.mjs:30,149`）が、ブラウザ側の反映経路が
   `setInterval(refreshMembers,30000)`（`server.mjs:466`）だけで、status 変化は SSE に乗らない。
   **気づく側は速く、遅いのは画面**である。
3. **承認待ちで詰んだ席が「待機」と表示される**。判定は `esc to interrupt` の有無だけ
   （`seat-status-bridge.mjs:92`）なので、確認ダイアログで停止した席が idle に化ける。実害の記録あり。
   **「動いていない」と「動けない」は別物**である。
4. **p1 の演出が「流れる」と呼ぶには弱い**。ライブ新着に 0.36s のフェード＋12px スライドが入るだけ
   （`server.mjs:227`）。

## オーナー裁定（2026-08-10）

- effort は **必須引数**にする。既定値をコードへ埋めない——席を立てる時に決める
- effort の表示から「effort」の語を落とす。値だけ出す
- 反映の遅れは直す。bridge の8秒はそのままにし、詰まっている画面側を直す
- 承認待ちの見分けは今回入れる
- p1 は**ブロック単位の逐次出現**。実際の生成とは同期させない**単なる演出**として割り切る。複雑にしない

## 非目標

- **p4（コストの金額換算）はやらない。** トークン概算（`pane_token_hint`）は既に出ており、
  金額換算は今回の対象に入っていない
- **心拍10秒・減衰30秒を対で刻む案は採らない。** 遅れは画面側（SSE 押し込み）で解くので、
  POST 頻度を上げずに済む
- **`parent-join.sh` の effort は任意のまま据え置く。** 席は `launch-seat.sh` が `--effort` で実際に
  設定するので「渡した値＝実挙動」だが、親は既に走っているセッションで自分の effort を機械的に知る
  経路が無い。推測して載せると画面が嘘をつくので、空欄のほうが正しい

## 既知の罠

- **`room/server.mjs` は1ファイルなので複数席で分割できない。** t1 が単独所有し、他席は触らない
- **path が重ならなくても壊れ合う。** t1 が SSE の event 種別を足し、t3（`room/client.mjs`）がその
  ストリームを読む。線 `room.server.mjs--sse-event-kind` を t1=`writes` / t3=`reads` で宣言する。
  **line_id は t1 が宣言した綴りを t3 がそのまま写す**（再導出すると交差が素通りする）
- **状態送信は席を起こしうる。** `server.mjs:147-148` に「状態送信で全席を1ターン起こした（6件撒いた）」
  記録がある。member イベントは `post()` を通さず、room ログにも書かない
- **並走する別 campaign が同じ repo に居る。** 各席は pull run の detached-worktree で作業し、
  canonical を汚さない。push は親が握る（`git log @{u}..HEAD` を見てから）

## タスク

#### t1 room/server.mjs: 稼働状態のSSE送出・承認待ちの表示・発言の逐次出現・effort表示

`room/server.mjs` を単独所有する。(a) `POST /members` で閲覧者が気づく欄（`status`/`busy_since`/
`vendor`/`model`/`effort`）が変わった時だけ `event: member` を流す。`status_at` と `pane_token_hint` は
含めない（前者は心拍のたび、後者は1k刻みで変わり、再描画がちらつく）。(b) UI が `member` イベントを
受けて既存の `refreshMembers()` を150msデバウンスで呼ぶ。30秒ポーリングは退席検知のため残す。
(c) 承認待ちの色・ラベル「承認待ち」・継続時間表示を足す。busy の揺れとは別種の演出にする。
(d) ライブ新着のバブル本文をブロック単位で順に出す（遅延は `Math.min(i,8)*90ms` で頭打ち・
レイアウトは動かさない・`prefers-reduced-motion` で無効化）。(e) effort 表示を `claude / sonnet / high`
の形へ畳む。線 `room.server.mjs--sse-event-kind` を `writes` で宣言する。

#### t2 skill/scripts: effort を必須引数化し、承認待ち(blocked)を判定する

`skill/scripts/launch-seat.sh`・`skill/scripts/seat-status-bridge.mjs`・`experiments/` を単独所有する。
(a) `launch-seat.sh` の effort を必須引数にし、claude の level を `change-effort.sh:46-48` と同じ
リテラル集合で着席前に弾く（不正値は90秒の着席タイムアウトまで待たされ、原因を指さない）。
codex の catalog 照会は複製しない。`parent-join.sh` は触らない。(b) `readSeat` の判定を
`busy` → `blocked` → `idle` の順にする。判定材料は `launch-seat.sh:74-77` の既知ダイアログ3種と
`docs/plan.md` §11 の `Do you want to proceed?` / `❯ 1. Yes`。`busySince` を blocked でも立てる
（欄は増やさない）。(c) 判定を固定する再現ハーネスを `experiments/` へ置く。**欠陥版で落ちることを
先に確認してから green を読む。**

#### t3 room/client.mjs: 名前付きSSEイベントをチャット発言として読まない

`room/client.mjs` を単独所有する。現在は全フレームから `data:` を拾って `relevant()` の判定に賭けて
いる。`relevant` は宛先の無い payload を弾くので t1 の新イベントでも席は起きないが、**それは偶然の
安全**である。`event:` 行を持つフレームを読み飛ばし、名前付きイベントはチャット発言ではないと明示する。
線 `room.server.mjs--sse-event-kind` を `reads` で宣言する。検証は「member イベントで起きないこと」と
「明示宛先の通常発言では起きること」の**両方**を実測する（片方だけでは配線が死んでいる場合と区別できない）。

#### t4 手順書と計画書を実装の現況へ同期する

`skill/SKILL.md` と `docs/plan.md` を単独所有する。(a) SKILL.md の effort 既定を「席ごとに必ず決める」へ
変え、usage を `<effort>` にし、`parent-join.sh` が任意のままである理由を1行足し、6.5 へ 4値目
`blocked` を足す。(b) `docs/plan.md` §15 の p1〜p7 に**実コードでの着地状態**を file:line で裏を取って
書く。本 campaign で塞いだ4点を記録し、**据え置いた p4 は据え置きと明記する**（実装しなかったものを
黙って消さない）。§11 backlog の `blocked` 4値目を消化済みへ移し、心拍を刻む案を採らなかった理由を書く。
**着手時点で `docs/plan.md` に別 campaign の未 commit 変更が残っていないかを先に確認し、
残っていれば room で報告して待つ**（commit がファイル単位なので巻き込む）。

## 結果（2026-08-10 完了）

t1〜t4 すべて done・push 済み。**各タスクを実装者以外の席が独立監査**して finding 無しで受理し、
`terminal-audit` phase も受理した（証跡 `evidence/roundtable-ux2-20260810/terminal-audit.md`）。

| task | commit | 実装 | 独立監査 |
|---|---|---|---|
| t2 skill/scripts | `7aa1e7a` | kotone | tsumugi |
| t1 room/server.mjs | `452f30f` | tsumugi | kotone |
| t3 room/client.mjs | `c6beb65` | tsumugi | kotone |
| t4 手順書・計画書の同期 | `76172ce` | tsumugi | kotone |

本番 room を image `20260810-c80f333` へ入替済み。入替後の実測で、公開面に承認待ち表示・
発言の逐次出現・member イベント受信が載り、会話ログ43件が保持され、先行 campaign の `summary` 口も
生存していることを確認した。

**campaign の目的（動いている／動いていないを見分ける）は、この campaign だけでは満たせなかった。**
`seat-status-bridge` が席を観測できない欠陥が受入条件の外にあり、follow-on
`roundtable-ux2-fx-20260810` の f1 で塞いだ。さらに 2026-08-10 の運用で「起きているのに書けていない」
形の実害が出て、決定73（トークン自力解決・書けないなら常駐しない・setup が起こす）へ繋がった。

**据え置き**: p4（コストの金額換算）。トークン概算は出ているが金額換算は今回の対象外。

**副産物**: Lattice CLI の並行 start 欠陥（同一 task の `todo start` が2席で二重成立）。
罠DB `lattice-todo-start-task-start-writer` へ登録済み。peertable 側の欠陥ではない。
