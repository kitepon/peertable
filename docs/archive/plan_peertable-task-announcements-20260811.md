# Peertable 工程着手・終了アナウンス campaign（peertable-task-announcements-20260811）— 完了履歴

日付: 2026-08-11

## 0. 縮小決定（2026-08-12）

本計画の typed task event、自動start/completion入口、遷移ID、冪等制御、送信者除外、専用の
受信後ループは過剰設計だったため撤去した。a1〜a5は、その設計を試作・配備した履歴としてdoneの
まま残すが、現行製品の仕様を表さない。

現行仕様は次の4規則だけとする。

1. Claimは通常のroom発言を `to: "all"` で送る。
2. 工程完了は通常のroom発言を `to: "all"` で送る。
3. 発言ターンの終わりには、次に行うことを自分宛DMで送る。
4. 特定相手への用事はその人へDMし、誰に聞くべきか分からない相談は `to: "all"` で送る。

a6は旧typed機構の統合工程ではなく、上記の最小規則、不要機構の撤去、MS-A2への配備、roomと
wakeup配送の実測をまとめて受理する縮小工程として完了する。

## 1. 目的

円卓の全員へ短い工程遷移を注入し、他席が残りの ready 工程・新しく開いた工程を自発的に探す契機を
作る。通常発言の broadcast は復活させず、全体へ届くのは **工程着手** と **工程終了** の二種類だけに
限定する。共通部屋の進捗がメンバーの自律行動を促した実運用上の効果を、自由文の大量注入と切り離して
製品機能として戻す。

## 2. 契約

### 2.1 typed な全体イベントだけを許す

room は通常 message とは別の task event を受理する。event kind は `started` / `completed` の二値だけ。
caller が渡せるのは actor、plan / task の識別子、短い title、同一遷移を束縛する id までとし、自由本文は
受け取らない。表示本文は room が次の定型で生成する。

```text
[工程着手] <task_id> <title> — <actor>
[工程終了] <task_id> <title> — <actor>
```

同じ transition id の再送は保存も注入も一度だけにする。未知 kind、自由本文、通常 message の全体宛先は
typed reject し、既存の明示宛先規律を緩めない。

task event は room ログと Web UI では全員に見える。channel / wakeup 注入は送信者自身を除く現在の全席と
親へ一行だけ届ける。受信者は「了解」や追認を返さず、工程正本と room ログを読み直し、active を続ける、
ready を claim する、文脈近接の監査依頼を取る、待機する、のいずれかへ進む。親は `started` では観測だけを
行い、`completed` で各工程完了後の黙った照合へ入る。

### 2.2 着手通知は正規の着手操作に内蔵する

AI に「`todo start` の後で全体発言をもう一回行う」と覚えさせない。Lattice 併用モードでは start 成功と
task event 送信を一つの Peertable 正規入口へまとめ、start が失敗した時は通知しない。単独円卓モードでも
同じ入口が claim 済み議題の着手を通知できるようにする。別々の手操作、全員の名前を列挙する宛先生成、
自由文の組立ては呼出側へ出さない。

### 2.3 終了通知は本当の完了後だけ送る

peer audit 前、Lattice `todo done` だけが先行した時、pull run の receipt が未 accept / 未 landed の時は
`completed` を送らない。Lattice 併用モードでは、その task に必要な peer audit、evidence、done、実行層を
使った場合の accepted receipt と canonical landing が成立した後だけ送る。単独円卓モードでは peer audit
後の `[done]` 成立時だけ送る。終了処理の再試行で同じ遷移を二重注入しない。

### 2.4 注入は仕事の契機であって会話の義務ではない

一つの工程につき全体注入は着手・終了の最大二回だけ。監査依頼、途中進捗、相談、blocker、設計判断、
受理所見は必要な相手への明示宛先のままとする。task event を受けた全席が定型の返事を流す挙動は退行と
みなし、role と live smoke の両方で止める。

## 3. Lattice 工程

### a1 typed task event の room transport を作る

- [x] a1の実装・試験・証跡化を完了した。後続の現行実装方針を正とする。

所有: `room/server.mjs`、`room/client.mjs`、task event transport を測る `room/` または `experiments/` の
focused harness。通常 message の宛先契約と role / setup script は触らない。

`started` / `completed` だけを受ける task event API と MCP client tool を作る。room が定型本文と現在の
recipient set を生成し、送信者以外の全席・親へ一行注入する。同一 transition id の冪等性、未知 kind、
自由本文、通常 message の broadcast reject を正負で測る。room ログ / Web UI で task event と通常発言を
区別できる typed field を保つ。

### a2 着手操作へ自動アナウンスを組み込む

- [x] a2の実装・試験・証跡化を完了した。後続の現行実装方針を正とする。

依存: a1、および main campaign t3。所有: `skill/scripts/setup.sh`、着手用の template / generated script、
対応する新規 harness。終了 script と role 本文は触らない。

Lattice / standalone の正規着手入口を作り、着手成功後だけ `started` を一度送る。Lattice の
`--parallel-frontier` 等の正規引数を失わず、失敗・既着手・競合では虚偽通知を出さない。setup が入口を
自動生成し、diagnostics が配布漏れを検出する。announce を別の二手目としてAIへ要求しない。

### a3 本当の終了へ自動アナウンスを組み込む

- [x] a3の実装・試験・証跡化を完了した。後続の現行実装方針を正とする。

依存: a1、および companion fix campaign 2 の f6。所有: `skill/templates/done.sh` と生成物、task event
連携の focused harness。着手 script と role 本文は触らない。

f6 が確立する「未 accept を done / landing 成功に見せない」契約の後段へ `completed` を接続する。
peer audit / evidence / done、実行層利用時の accepted receipt / canonical landing の不足では通知せず、
本当の完了後だけ一度送る。再試行・再open後の新しい完了は別 transition として一度送れることを測る。

### a4 受信後に返信せず自律ループへ戻る role を生成する

- [x] a4の実装・試験・証跡化を完了した。後続の現行実装方針を正とする。

依存: a1、および main campaign t3。所有: `skill/templates/member.md`、
`skill/templates/member-standalone.md`、`skill/templates/parent.md`、必要な role harness。transport / script は
触らない。

`started` 受信時はclaim競合を避けて active / ready / audit / wait を読み直し、`completed` 受信時は新しく
開いた ready と監査候補を探す。通知への「了解」返信は禁止する。親は started で工程管理へ降りず、
completed でだけ黙った工程完了後照合へ入る。三 role の生成物をfixtureで突合する。

### a5 Wave 1 を MS-A2 へ deploy し transport を実動確認する

- [x] a5の実装・試験・証跡化を完了した。後続の現行実装方針を正とする。

依存: a1、および既存 companion fix campaign の f2 / f3。所有: この task の evidence と、実動で見つけた
欠陥を工程化するための新規 companion planだけ。先行 task の product code は直接直さない。

未監査WIPを含まない origin/main の祖先 commitだけをMS-A2へdeployする。使い捨てroomで started / completed
の保存、全席注入、送信者除外、冪等性、自由broadcast reject を実動確認する。欠陥が出たら発見者がその場で
修理ToDo化し、a6の前提へ接続する。npm publishは行わない。

### a6 実円卓の着手・終了ループを統合し Wave 2 を deploy する

- [x] a6の実装・試験・証跡化を完了した。後続の現行実装方針を正とする。

依存: a2 / a3 / a4 / a5。所有: 本task用の `experiments/`、evidence、必要なdeploy smoke記録。

使い捨てLattice planと複数の実席で、着手成功による一回の全体注入、他席の自律的な別ready claim、
peer audit前には終了通知が出ないこと、accepted / landed後の一回の終了注入、新しく開いた工程への自律着手、
受信者が「了解」を返さないこと、親がstartedで工程を奪わずcompleted後だけ黙って照合することを一連で測る。
成立したcommitをMS-A2へ再deployし公開roomで同じsmokeを行う。欠陥は即時工程化し、全修理後に再smokeする。

## 4. 依存グラフ

```text
main t3 ───────┬──> a2 ──┐
               └──> a4 ──┤
a1 ────────────┬──> a2   │
               ├──> a3 ──┼──> a6 ──> main t4
               ├──> a4   │
               └──> a5 ──┘
fx2 f6 ───────────> a3
fx f2 / f3 ───────> a5
```

## 5. 完了条件

1. a1〜a6と途中で追加した欠陥ToDoが、実装者以外の文脈近接一席によるpeer audit後にdoneである。
2. 全体注入は started / completed の二種類、各遷移一回だけで、自由本文・通常broadcastを通さない。
3. 着手・終了のcallerが、宛先列挙や追加announce操作を手作業で行わない。
4. 受信した席が定型返信を返さず、工程正本から次の行動を自律的に選ぶことを実席で確認する。
5. MS-A2へWave 1 / Wave 2の二回以上deployし、それぞれ公開roomを使った実動smokeを記録する。
6. npm version bump / publishは行わない。通常pushは各accepted batchの既定とする。
