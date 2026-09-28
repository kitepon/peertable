# 事前hookと背景完了の成立probe

取得日: 2026-09-28。確度: macOSの公式CLIと通常TUIで実測。製品版の受入と3 OS全行の合格は未実施。

## 確認できた範囲

`experiments/parent-caller-hook-probe.mjs`は使い捨てprojectに製品専用MCPとhookを置く。通常HOMEと認証を保持し、Aitermのmodule・内部stateは使わない。Grokのproject hookはgit rootと公式`/hooks-trust`による信頼登録を必要とした。fixtureのglobal hookは追加していない。

| 対象 | 実測 |
| --- | --- |
| Cursor CLI `2026.09.26-dd393fe` | 事前hookの相関をMCP引数へ追加。join、同じ入力のread 2件、leaveが同じ実会話で成立。別会話のread/leaveは両方`PARENT_CALLER_MISMATCH`。実CLIのread 2件は逐次実行であり、並行呼出し成立へ数えない |
| Grok Build `1.0.41 (4220f3b224a6)` | 相関追加後にjoin、同じ入力の並行read 2件、leaveが成立。別会話のread/leaveは両方`PARENT_CALLER_MISMATCH` |
| Cursor通常TUI、model Auto | 同じ会話`b66e8d43-7732-425a-b36d-6877cc7c5bfa`でnative背景完了からidle起床。親が2件目の背景taskを登録し、2件ともseqと日本語符号を回答。3件目の待機は起動していない |
| Grok通常TUI、model Grok 4.6 (high) | 同じ会話`01a0e84a-238b-76e1-b7cd-c14069a20945`でnative背景完了からidle起床。完了済みtaskを`get_command_or_subagent_output`でtimeoutなしに回収し、2件目の背景taskを登録。2件目のseqと日本語符号を回答。Stopの`backgroundTasks`は再武装後1件 |

生の公式hookから配送に必要なfieldだけを投影した記録は[JSON証拠](phase1-macos-caller-background.json)に保存した。callerのPreToolUse、実MCP引数、結果、背景taskの起動・完了回収・Stopを照合できる。TUIの回答はAiterm公開`pty_read(screen:true)`でも照合した。利用者のemailと認証は記録へ含めない。

## 固定するpayload

- Cursor CLIのMCP `clientInfo`は`{name: "Cursor", version: "1.0.0"}`。MCP要求の`_meta`に会話IDはなかった。
- Cursor CLIの`preToolUse.tool_name`は`MCP:parent_join`等で、サーバー名を含まない。`tool_input`はMCPの引数object。`updated_input`へ元の全引数と`hook_context_id`を返すと、実MCPへ渡る。事後`afterMCPExecution`は`mcp_server_name`を含み、`tool_input`と`result_json`はJSON文字列である。製品はCLI client名をDesktopの`cursor-vscode`と同一視しない。
- Cursorで対象外の`preToolUse`へ`{}`を返すとschema不一致によりtoolが拒否された。対象外も公式の`{permission: "allow"}`を返す。実MCP未到達をcaller拒否の成立証拠に数えない。
- Grokの実hookは`hookEventName: "pre_tool_use"`と`hook_event_name: "PreToolUse"`を併記する。`sessionId`と`toolUseId`が実caller相関である。
- GrokのMCP dispatchでは`toolName`が`peertable_probe__parent_join`、`toolInput`が`{tool_name, tool_input}`である。完全な外側objectを保持し、内側`tool_input`へ相関fieldを付加する。外側へのfield追加だけではMCPへ渡らず`PARENT_CALLER_UNBOUND`になった。MCP client名は`grok-shell-peertable_probe`、versionは`1.0.41`だった。
- Cursorの背景toolは`Shell`。`tool_input`には`command`と`cwd`があり、起動結果はJSON文字列の`{shell_id, pid}`だった。本文回収は背景終了の通知後、公式`Read`でterminal出力を読む。元のShell入力には背景指定fieldがなかったため、完成済みnative tool入力の製品adapterは別途確定する。
- Grokは`run_terminal_command`の`background: true, timeout: 0`で起動し、`toolResult.type: "BackgroundTaskStarted"`に`task_id`と`pid`が返る。完了回収の`task_ids`はこのIDを使い、`timeout_ms`を省略した。

caller相関fixtureはhookごとに発行IDを変え、tool名・元入力digest・実会話を保存してMCPで一回だけ消費する。別会話の判定は本文返却やleaveより先に行う。これは機構成立を調べるfixtureであり、製品版の世代・process本人性・失敗保存を実装済みとするものではない。

## 残件と非合格の観測

Codex CLI `0.155.1`の公式App Serverへ通常HOMEで接続し、`hooks/list`は応答した。一時git projectの`.codex/hooks.json`を置き、CLIの`projects.<path>.trust_level`を与えてもproject hookが一覧へ出なかった。canonical pathと空のproject configも試したが未成立であり、原因は未確定。次は公式APIによるproject信頼とhookの実効source・hashを確認する。ephemeral threadへの`thread/queue/add`は公式APIが`ephemeral thread does not support queued submissions`として拒否した。永続threadのqueue受付・同一turnへの同期hook・idle起床は未検証である。これらの試行にAiterm内部のreceiverや偽HOMEを代用していない。

pick-modelはCursor/Grok probe用の2呼出しとも`JEV_HTTP_520`で失敗した。モデル選定は未成立と報告し、公式CLIの既定モデルで機構を実測した。ハーネスの利用上限によるskip-successは行っていない。

このcheckpointの残りは、Codexのqueue＋同期hook、Cursorの実並行caller試験、Cursor Desktop、Linux/Windowsのcallerと背景受信、作業中到着・競合・timeout/再武装、製品spoolとの統合である。Claude Stopとleaseの3 OS観測は親が担当する。製品のreceiver、connect、setup/resume/doctor/teardown、unknown receipt、長文継続回収、package更新、12組合せの受入は未実装・未実施。

## 再現入口

```sh
node experiments/parent-caller-hook-probe.mjs init cursor
node experiments/parent-caller-hook-probe.mjs init grok
node --test experiments/parent-caller-hook-probe.test.mjs
node --test experiments/parent-background-wait-probe.test.mjs
```

initが返すrootで公式CLIを起動する。Grokはrootをgit projectとして初期化した後、公式`/hooks-trust`で信頼する。通常HOMEを変えない。caller fixtureのpromptはrootの`prompt.txt`にある。背景fixtureは親自身のnative背景toolへ`node experiments/parent-background-wait-probe.mjs wait <root>`を登録する。外部から`inject <root> <seq> <本文>`を呼ぶと1件を出して終了する。親が次のnative背景toolを登録してから2件目を投入する。

背景fixtureのslotは起動重複と本文保持を観測するための小fixtureであり、製品runtimeのPID＋開始identityの所有処理を代替しない。製品版では共通spool、process本人性、1slot、receiptを統合して再受入する。

一次資料: [Cursor hooks](https://cursor.com/docs/hooks)、Grok公式配布資料`~/.grok/docs/user-guide/10-hooks.md`・`20-background-tasks.md`、[Codex hooks](https://learn.chatgpt.com/docs/hooks)。
