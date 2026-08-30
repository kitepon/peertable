# Peertable Codex席のLattice環境配達 — companion fix 5

## 工程

### j1 Codex席のshellへLattice actorとCLIを確実に配達する

`launch-seat.sh`はtmux shellで`PEERTABLE_MEMBER`・`PEERTABLE_PLAN`・`LATTICE_CLI`・
`LATTICE_TODO_ACTOR_*`をexportしてからCodexを起動するが、着任後のCodex tool shellでは
これらが全て未設定だった。room MCPだけはclosed envへ明示列挙しているため会話できる一方、
役割文書が要求するLattice `todo start`を正規CLI/actorで実行できず、全席がreadyのまま止まった。

Codexの実tool shellへ、秘密を複製せずにmember identity、plan、source-tree `LATTICE_CLI`、
actor 3点を確実に渡す。着席判定はUIヘッダだけでなく、席自身のshellから各値と
`$LATTICE_CLI todo status --json`を実測できることまで含める。Claude席、room MCPのclosed env、
seat identityのraw argv非保存を壊さない。旧版の負のcontrol、修正版の実Codex席claim、担当外peer audit、
Peertable配備後smokeまでを本taskの受入とする。
