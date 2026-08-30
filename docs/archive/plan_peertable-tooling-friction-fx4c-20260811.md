# Peertable tooling friction — companion fixes 6–8

## 工程

### h6 Claude→Codexのvendor交代を原子的なfirst-class操作にする

`change-seat.sh`は現在同一vendor内のmodel/effort変更だけを受け付け、Claude席からCodex席への交代を
`SEAT_CHANGE_VENDOR_UNSUPPORTED`で拒否する。そのため親がidle確認後に旧席を手動で畳み、
`launch-seat.sh`とroom履歴を別々に手組みしている。

親が自然文から確定したtarget（member、vendor、model、effort、reason）を渡した時、live preflightを
旧席終了前に実行する。busyな席は副作用ゼロでtyped拒否し、成功時は新vendorのmetadataと交代履歴を
一回だけ実測する。新席の起動失敗時は旧vendor・model・effortへ明示rollbackし、contextを継承せず、
正規のroom read/postと工程正本から再着任する入口を返す。h2のlaunch atomic修理と共有する境界は
依存をLatticeへ接続し、旧版のvendor拒否・busy無変更・新vendor成功・失敗rollbackを実物fixtureで
落とす負のcontrolを置く。

### h7 Peertable席の委譲入口をaiterm外部PTYへ固定する

Peertableの正規メンバーは既存のaiterm外部PTYに長寿命で着席する。`.team/roles/member.md`、
`skill/templates/member.md`、`skill/templates/charter.md`、`skill/SKILL.md`および着任briefが、
同じroomと工程正本を読む席間分担を案内し、Codex/Claude native sub-agent・Task・Agentを円卓席の
代用として起動しない具体的な入口を示す。通常shell用aitermと席間分担のaitermを混同しない。

Codexの`ultra`はmax推論に加えてproactiveなnative multi-agentを有効にするため、Peertable席では
拒否するかmax以下へ明示誘導する。親と席の両方が誤入口を選ばない負例harnessを置き、正規の
aiterm外部PTY着席・room参加・Lattice正本参照が通ることを実測する。

### h8 Web member avatarの色識別を安定・高距離にする

`room/server.mjs`のmember avatar色生成は名前hashをそのままhueへ写像するため、同時表示席で近似色が
連続し、色だけで識別しづらい。表示中メンバーへ高コントラストpaletteを先に割り当て、枯渇時は
知覚距離が最大の色を再利用する。同一room・同一ログでrefreshしても名前への割当は安定し、背景上の
文字可読性と既存の名前表示は維持する。近似色が連続する旧生成を落とすfixtureと、同一メンバーの
refresh安定性を確認する実物Web/UI検証を追加する。
