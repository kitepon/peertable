# Peertable 親Goal継続監視・Codex親liveness修理（peertable-parent-goal-runtime-fx-20260812）— 計画正本

## 0. 縮小決定（2026-08-12）

本計画で想定した durable Goal、watch generation、heartbeat、typed runtime receipt、親livenessの
再定義は実装しない。DM到着時だけ親へ制御を返す一秒pollの `parent-watch` が Codex / Claude の
両方で成立し、今回必要な親DM受信を満たしたためである。

`pgr-01` は重い案を採用しなかった記録として完了する。成果は既存の単純な番犬経路
（`skill/scripts/parent-watch.mjs`、`skill/scripts/codex-parent-watch.sh`、`parent-join.sh`）とその
focused testである。Goal管理、親liveness表示、capacity意味変更は非採用・非実装とする。

## 1. 背景

2026-08-12 の実円卓で、既存の `parent-watch` プロセスは生存し、room DM を cursor へ蓄積できている一方、非Aitermの Codex 親は通常ターンを final/DONE で閉じると、次の監視用tool callへ戻らない事象が確認された。DM は親へ処理可能な形で再注入されず、全席が idle になる。watcher が生きていることだけでは、親の判断ターンが継続している証拠にならない。

同時に、非Aiterm Codex 親の room member liveness は tmux pane を前提にしているため、常時 `dead` と表示される。親が実際には active Goal と処理可能な parent-watch を持っていても死席扱いになり、worker の capacity 契約を誤らせる。

## 2. 目的と境界

親が Peertable campaign の開始から teardown まで同じ durable Goal を維持し、parent-watch の DM／turn-completed を受けた時に判断ターンを継続できることを、実測可能な typed runtime receipt として保証する。親の liveness は tmux pane ではなく、active Goal と parent-watch の generation/cursor heartbeat、およびその処理可能性から判定する。

本 companion は g1 の実装を奪わない。g1 の既存 writer boundary（`skill/SKILL.md`）と、spr-01 が検証する構造 provenance が確定するまで、親runtimeの製品実装へ着手しない。Claude の既存 Monitor 契約、通常 wakeup bridge、worker capacity の契約は保持する。

## 3. 工程

### pgr-01 親Goalを維持したCodex親ランタイムとlivenessを修理する

#### 根本原因と設計

- setup の parent-join が返す親識別子・Goal識別子・watch generation/cursor を、同一 campaign の durable runtime receipt に束縛する。
- 明示的な durable campaign の setup request を受けたら Goal を開始し、parent-join 後に一秒周期の watch wait を維持する。空のwait結果では終わらず、DM または turn-completed の判定を受けた時だけ必要な席を起こし、同じ Goal の親判断へ戻す。
- context compaction、親のrestart、接続断から復帰した場合は cursor から一度だけ catch-up し、watcher の生存だけを成功扱いしない。Goal-less join、親の final による監視終了、duplicate watcher、cursor欠落は typed failure とする。
- 非Aiterm Codex 親の status は、active Goal があり、watch generation/cursor heartbeat が期限内で、DMを処理可能な watcher がある場合だけ `alive`／`busy`／`idle` とする。Goal停止またはheartbeat期限切れだけを `dead` とする。処理不能なDMを `alive` と偽装しない。
- capacity の worker 数から親を dead worker として数えない既存契約は維持し、親の表示改善を worker capacity の意味変更にしない。

#### 入力・処理・出力

入力は setup/parent-join の結果、host=`codex` の Goal identity/status、parent-watch の generation/cursor/heartbeat、room の seat status、Lattice の active/ready/audit 状態とする。

処理は「explicit durable campaign → Goal start → parent-join → watch wait → DM／turn-completed judgement → 必要な席だけ wake → 同じ Goal を継続」の順にする。Goal continuation または compaction catch-up でも cursor と generation の相関を失わない。

出力は Goal identity、status、watch generation/cursor、liveness 判定、monitoring／blocked／teardown の理由を含む typed parent-runtime receipt とする。watcher process の生存、DM保存、親判断ターン継続を別々に記録する。

#### 受入条件

1. 親が一度応答しても Goal は active のままで、DM 到着後に同じ親runtimeが継続処理する。
2. 全席 idle で active WIP が残る場合は、必要な席を再起床して親判断へ戻る。
3. 正当な待機状態では不要な席を起こさない。
4. compaction または restart 後に cursor から未処理DMを一度だけ catch-up する。
5. teardown または Goal complete で watcher と親runtimeが停止する。
6. Claude の既存 Monitor 契約を壊さず、Codex の親Goal経路だけが継続監視を得る。
7. active Goal と処理可能な watcher がある非Aiterm Codex 親は room で `dead` にならず、heartbeat期限切れまたはGoal停止時だけ dead になる。
8. 親を worker capacity に混入させず、既存の worker 数・capacity 判定を変えない。
9. watcher 生存だけ、Goal-less join、DM蓄積だけを成功扱いしない。各状態が typed receipt と focused harness で区別される。

#### 依存・所有境界

- `structure-provenance-repair-20260812/spr-01` の構造検証を前提にする。spr-01 の worktree、証跡、writer boundary は変更しない。
- g1 の `skill/SKILL.md` 実装は spr-01 完了まで待つ。g1 と競合する product file はこの起票では変更しない。
- 登録後に `structure-provenance-repair-20260812/spr-01 → pgr-01`、`pgr-01 → peertable-task-announcements-20260811/a6` を canonical Lattice の dependency edge として接続する。後者の a6 は同名の別campaignではない。
- Claude Monitor、通常 wakeup bridge、capacity worker 契約、room の読み取り専用UI、Lattice 本体は非対象とする。

#### 実装後の検証

親Goalを保持した正常DM、全席idleでの再起床、正当な待機、compaction/restart catch-up、teardown停止、Goal-less／duplicate watcher／heartbeat期限切れの負例を focused harness で測る。実装前に `spr-01` の受入と g1 の所有境界を確認し、コード変更前に本 task を claim/start する。
