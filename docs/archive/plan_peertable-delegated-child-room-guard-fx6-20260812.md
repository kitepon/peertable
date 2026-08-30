# Peertable 委譲子のroom着席防止 companion fix（peertable-delegated-child-room-guard-fx6-20260812）— 計画正本

日付: 2026-08-12

## 1. 発見した欠陥

既存の h7 は「正式着席したメンバーはサブエージェントを自由に使える」「メンバーが呼んだ子は
自動的に円卓メンバーにならない」と文書・role・fixtureへ定義した。しかし実円卓では、メンバーが
監査用に呼んだ `h6audit` が `launch-seat.sh` による正式席としてroomへ登録された。案内だけでは
呼び出し元の違いを機械的に止められず、内部委譲の子と親が増員した正規席が混ざる。

## 2. 契約

規則は一つだけとする。

> 円卓メンバーが呼んだサブエージェントはroomへ参加させない。成果・工程所有・統合・room報告は、
> 呼び出した円卓メンバーが保持する。

サブエージェントの利用手段、人数、vendorは制限しない。親が円卓を増員する正規入口も変更しない。
正式席にある `PEERTABLE_MEMBER` を呼び出し元の識別に使い、その環境を継承したプロセスが
`launch-seat.sh` から別の席を作ろうとした場合だけ、外部副作用より前にtyped errorで拒否する。

## 3. 工程

### c1 メンバー起点の子をPeertable席へ登録させない

入力は、呼び出し元環境の `PEERTABLE_MEMBER`、通常の着席引数、`.team/setup-state.json` である。
`skill/scripts/launch-seat.sh` の最初のpreflightで呼び出し元を分類し、`PEERTABLE_MEMBER` が空なら
親による正式増員として既存処理へ渡す。値がある場合は
`SEAT_LAUNCH_DELEGATED_CHILD_FORBIDDEN` を返し、credential生成、tmux作成、seat identity作成、
room member登録、brief送信を一切行わない。

`skill/SKILL.md` と member role templateは、子をroomへ参加させず、呼び出したメンバーが成果を
引き取って報告する一文へ揃える。複数種の委譲席・表示階層・昇格制度は作らない。

focused harnessでは次を実測する。

1. `PEERTABLE_MEMBER=tsubaki` を継承した呼び出しはtyped rejectされ、room member、tmux、identity、
   credentialの全てが増えない。
2. `PEERTABLE_MEMBER` の無い親呼び出しでは、従来どおり正式席を起動できる。
3. メンバー自身のnative sub-agent／Aiterm外部agent／相談agent利用は引き続き許され、工程所有・統合・
   room報告だけが着席メンバーに残る。
4. 現在の実円卓で誤登録された `h6audit` は、担当中の作業が無いことを確認してから正規退席させる。

## 4. 構造データ

- 入力: 呼び出し元の席ID（`PEERTABLE_MEMBER`）と着席要求。
- 整理: `launch-seat.sh` の副作用前preflightで、親の正式増員か、メンバーから継承された委譲子かを分類する。
- 出力: 正式増員だけを既存の着席処理へ渡す。委譲子はtyped rejectし、roomと端末へ何も作らない。
- 利用先: `launch-seat.sh`、生成member role、委譲境界fixture、実円卓の席一覧。

## 5. 完了条件

1. c1が実装者以外の文脈近接な正規円卓メンバーによるpeer audit後にdoneである。
2. 正負の実物fixtureで副作用ゼロの拒否と親からの正式着席成功を確認する。
3. 現在の `h6audit` がroom・tmux・identityから退席し、正規席だけが残る。
4. 成立commitを通常pushし、Peertableの実利用面へdeployして実動smokeを行う。npm publishは行わない。
