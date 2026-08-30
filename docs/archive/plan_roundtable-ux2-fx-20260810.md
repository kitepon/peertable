# 円卓UX第2次 follow-on（roundtable-ux2-fx-20260810）— 計画正本

工程正本は peertable store の plan `roundtable-ux2-fx-20260810`（本書から `todo migrate` で起票）。
証跡は `evidence/roundtable-ux2-fx-20260810/<task_id>.md`。

## 背景 — 観測の入口が塞がっている

`roundtable-ux2-20260810` は t1〜t4 を完遂し、実装者以外の独立監査も通した。しかし**campaign の
目的（参加者一覧で「席にいるけど動いていない」と「席にいて仕事をしている」を見分ける）は
達成されていない**。

`skill/scripts/seat-status-bridge.mjs` は tmux 呼び出しへ `-S <socket>` を渡していない。席は
`launch-seat.sh` が `${PEERTABLE_TMUX_SOCKET:-${TMPDIR}claude-tmux-sockets/claude.sock}` へ作るので、
ブリッジは既定ソケット（このマシンには存在しない）を見に行き、**生きている席を全て `dead` と判定して
room へ送る**。

2026-08-10 実測（親）:

```
bridge の観測   tsumugi → dead   kotone → dead   bell → dead
実際の tmux     peer-tsumugi 生存（22:21:26）   peer-kotone 生存（22:21:44）
socket 対応     同ファイルを socket で grep して0件
```

`git log -S 'PEERTABLE_TMUX_SOCKET' -- skill/scripts/seat-status-bridge.mjs` は0件で、**このファイルは
一度も socket を扱ったことがない**。つまり p6（稼働状態の表示）は `launch-seat.sh` で立てた席に対して
一度も通っていない。t1 が入れた `event: member` の押し込みも承認待ち表示も、**届く状態が無い**ので
end-to-end では確かめられない。

これは前 campaign の受入条件の外にあった欠陥であり、t1〜t4 の受理を取り消すものではない。
**「実装したこと」と「機能したこと」が別である**という、この repo が繰り返し記録してきた形の一例である。

## タスク

#### f1 seat-status-bridge が席を実際に観測できるようにする

`skill/scripts/seat-status-bridge.mjs` を単独所有する。

**(a) socket を渡す。** `launch-seat.sh:14` と**同じ解決規則**を使う——
`${PEERTABLE_TMUX_SOCKET:-${TMPDIR}claude-tmux-sockets/claude.sock}`。**規則を二重に書かない**
（片方だけ直すと同じ穴がもう一度開く）。既定ソケットへ落ちる fallback を残さない——見えないなら
`dead` と嘘をつくのではなく、見えないと言う。

**(b) 席でないものを `dead` と報告しない。** ブリッジは room の member 名から `peer-<名前>` を引くので、
tmux 席を持たない親（bell）は socket を直しても `dead` になる。**親は「死んでいる」のではなく
「観測対象ではない」**。`dead`（席が落ちた）と「tmux セッションがそもそも無い」を区別し、後者は
status を送らない（UI 側は報告が無ければ点を出さない既存挙動に乗る）。

**(c) 判定を再現ハーネスへ固定する。** `experiments/seat-status-blocked-repro.mjs` が
`classifyPaneTail` を固定しているのと同じ形で、socket 解決と「席が無い場合に送らない」を固定する。
**欠陥版で落ちることを先に確認してから green を読む**（この task はまさに「green が嘘だった」件なので、
測定器を疑う手順を省かない）。

**受入は実測で閉じる**（コードが在ることでは閉じない）:
1. 卓の席が立っている状態でブリッジを `--once` で回し、**生きている席が `busy` か `idle` を返す**
   （`dead` でない）こと
2. 存在しない tmux 席を持つ member（親 bell）へ status が送られないこと
3. 実際に席を1つ落として（または `pane_dead`）、その席だけが `dead` になること
4. room の `GET /members` を読み返して、①の結果が実際に保存されていること
   （**200 は保存の証拠にならない**）
5. 上を通した上で、Web UI で稼働アイコンが**実際に動く**こと——t1 が入れた `event: member` の
   押し込みが効いて、切り替わりが8秒以内で出ることまで見る（p6 の目的はここで初めて満たされる）

**触らないもの**: `room/server.mjs`・`room/client.mjs`（前 campaign で受理済み）、`launch-seat.sh`。

## 結果（2026-08-10 完了）

f1 done・push 済み（`c3fc0a4`）。実装 kotone / 独立監査 tsumugi、finding 無し。
`terminal-audit` phase も受理（証跡 `evidence/roundtable-ux2-fx-20260810/terminal-audit.md`）。

修正前後の同一手順での実測:

```
修正前  tsumugi → dead   kotone → dead   bell → dead   （実際の tmux は両席とも生存）
修正後  tsumugi → idle   kotone → idle   3 席を見て 2 件送った（tmux席を持たず観測対象外: 1）
```

本番の公開面でも `is-idle`／`状態 待機` が出ることを確認した。**公開面で本物の稼働状態が出た
最初の記録**である。

**この後、同じ面でもう1つ実害が出た。** f1 は「席が見えない」を塞いだが、「見えても書けない」は
残っていた——トークン欠落の常駐が4時間403を撃ち続けた。決定73 でそちらを塞いだ
（`resolvePostToken` / `WRITE_DENIED` / setup が起こす）。**f1 と決定73 で、この面の
「起きているのに何も届かない」経路は塞がったことになる。**
