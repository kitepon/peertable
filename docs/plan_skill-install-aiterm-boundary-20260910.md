# skill導入とAiterm公開依存の整理

## 目的と範囲

Peertable repoと製品が所有するskill導入先だけを変更する。npm配布、初回・再実行・更新、明示projectのsetup/resume/診断を製品入口へまとめる。global installは既存projectやroomを変更しない。dotagents、Aitermを含む別製品repoへ書き込まない。

永続PTY、tty、TUI方言、tmux/psmux、内部namespaceと内部stateはAitermが所有する。Peertableは公開APIを呼び、roomの配送・member状態へ反映する。公開API不足は最小再現と必要契約をAiterm担当へ渡す。内部実装の複製や機能削減で完了にしない。

## 現在地

- 2026-09-10着手。fetch後のmainとorigin/mainは`cb738a4f9e49290c024558b432a4b84944f3b1e0`で一致。公開npmは0.8.55。
- 元worktreeの既存dirtyは`room/server.mjs`、`docs/brand-landing-refresh-20260905.md`。今回へ混入させず、専用worktreeで実装する。
- ベースライン: `node --test skill/scripts/runtime-contract.test.mjs`、20件成功。
- 着手時は配布packageにskill配置入口がなく、seat-usageのnamespace式、seat-status/doctor/resumeのbackend操作、launchのTUI補完が残っていた。
- 専用worktreeでinstall/CLI、setup/resume、席の起動・変更・退席・診断・解散、3 bridgeを公開APIへ接続した。namespace/socket/TUI分類器を製品runtimeから撤去した。mainはまだ変更していない。
- Grokによる読取専用反証を回収。判定不能と死亡の区別、登録前残骸の撤去、席ごとの身元不一致、Claudeの公開承認接続を補った。Grok起動表示とnative SIGSTOP判定はAiterm所有者へ移管し、対応の実測報告を受領した。
- install・scaffold・退席・観測・承認・解散・resume・launch・changeのfocused試験は成功。公開PTYを使う3 bridgeの初回・同一PID保持・版更新・過去失敗後の再実行はMacで確認した。これは公開npm版のSSH導入確認を代替しない。
- README、同梱SKILL、member/charter template、製品境界文書を更新。旧backend試験を公開契約の試験へ移し、実機用は実harnessを使う公開API試験として残した。文書gateは6件成功。
- 反証で見つかったsetup記録順序と、実機で再現した初回bridge資格不足を修理し、focused試験を通した。旧shellの文字列に依存する配置試験と版番号宣言を更新後、最終CIはruntime 59件・CI/文書契約10件・OS別CLI・配置・構文・配布診断まで成功した。
- Aiterm担当から0.33.0のnpm公開・取得可能、3OS CI成功の報告を受領。担当がMac/Linuxへ導入中。Peertableのcommit/push、release gate、npm公開、公開版の実機導入は未完了。
- Aitermは3OSへ0.33.0導入と公開後smokeを完了。共有設定の更新終了を確認した。Windows SSHも復旧した。MacはOS標準sshdを一時的にloopback限定で起動し、Aiterm PTYから実SSHログインを確認した。
- MacのSSH sessionでsource版Peertableの実Codex lifecycleが成功。Peertable 0.8.56を準備中で、公開npm版の3OS導入はこれから。詳細は`evidence/skill-install-aiterm-boundary-20260910/`に記録する。

## 合意した公開依存契約

| 操作 | Peertableが使う公開面 |
|---|---|
| 席と預け仕事の帰属 | `pty_list`の構造化sessionsと明示した`PEERTABLE_MEMBER`/`PEERTABLE_ROOM`、公開`AITERM_SESSION_ID` |
| 生存・状態・本人性 | `pty_observe`のstate/reason、pane/harnessの生存、native PID・起動識別子・argv digest |
| 稼働ランプ | `pty_observe`のopaque cursor、出力・CPU差分、足場を除いたbackground CPU、token hint |
| 起動準備 | `agent_launch`の`trust_project: true`と`startup.status: ready`。promptなしでroom登録を待ち、その後送信 |
| 指示・配達 | `pty_send`/`agent_steer`の構造化receipt。返されたwait_processをそのまま別processへ渡す |
| 既知承認 | Codexは`agent_approval`、Claudeは`blocked/tool_approval`に限り`claude_approval`。digest付き単発応答 |
| 停止・設定変更 | `pty_close`と消失読返し、`agent_configure`と設定・履歴の読返し |

`harness_alive: null`は`unknown/harness_process_unresolved`として送信を止める。native SIGSTOPは`blocked/harness_stopped`であり、tool承認に回さない。起動案内の選択、Grok表示の補正env、namespace式はAitermへ閉じる。

## 実施順と受入

1. 公開APIと現行導入経路を照合し、依存不足を最小再現にする。
2. skill配置・更新・再実行と診断の入口を実装する。ユーザー設定、独自skill、明示project選択を保持する。
3. 公開APIの能力を前提としてsetup/resume/runtime/席操作を統合し、backendとTUI方言の補完を撤去する。
4. 初回・再実行・更新・既存設定保持とroom/runtimeのfocused試験を通す。
5. Mac/Linux/WindowsへAiterm永続PTYでSSHし、公式導入・setup・実動作を同じsessionで確認する。WindowsはPowerShell 7。同一端末の共有設定更新は他製品と重ねない。
6. 全文書の関連記述を点検・更新し、別ベンダー反証、製品release gate、main統合、対象限定commit/push、npm公開を完了する。
7. 公開版を対応実機へ公式導入し、公開APIからsmokeする。commit・版・正規コマンド・OS実測・依存契約・残件を報告する。

## 既知の罠と非目標

- npm公開直後はlatestキャッシュに遅延があり、実機導入は公開した版を明示する。
- 同一projectへ別roomを推測して作らない。未知の既存`.team`やskillを所有物とみなさない。
- Aiterm内部ファイル・namespace・backendコマンドをPeertableの代替手段にしない。
- 紹介ページ刷新、過去campaignの監査、他製品の修理を今回へ追加しない。

## 作業配置

公開依存の判断と実装は密接なためwriterは親一人で直列実施する。独立反証だけGrokの読取専用sessionへ委譲し、同時に導入経路を調査する。今回の工程管理にLatticeの新規適用は行わない。既存campaignのControlとLattice工程は変更しない。

契約・本番操作・公開・受入は親が担当する。外部API能力待ちだけを依存待ちとし、未達の受入を成功へ丸めない。
