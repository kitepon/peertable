# 親配送の正式受入runner

`scripts/parent-delivery-acceptance.mjs`が要求する`peertable.parent-live-case.v1`の証拠を、通常CLIの実親から取得する。対象はClaude Code/Codexの対話TUIだけで、Desktop/IDE、Cursor、Grokは扱わない。fixture・stream-json・診断app-serverだけの結果を、実親への配送合格にしない。公式queueの受付証拠は実会話への配送・応答と合わせて照合する。

## 実行

```sh
node experiments/parent-product-acceptance/run.mjs --harness claude|codex \
  --source <検証対象commit 40桁> --digest <runtime digest> --version <package version> --runner-commit <controller commit 40桁> \
  [--scenarios audience,idle,original,...] [--out <private作業dir>] [--model <id>]
```

runnerは1回の呼出しで次を連続して行う。

1. HEADが`--source`と一致し、room/skill/package/scriptsに未commit差分がないことを確認する。
2. `npm pack`の正式tarballを`<out>/prefix`へlocal導入し、導入物のruntime digest・package版・client版を指定値と照合する。global installとskill配置は行わない。
3. 対象harnessのglobal設定をtarで退避し、導入物の`peertable connect --target <harness>`でPeertable所有entryだけを登録する。
4. 配布物の`room/server.mjs`で試験専用roomを起動する。tokenは`PEERTABLE_TOKEN_SOURCE_FILE`経由で標準のseat-credential経路へ渡す。
5. Aitermの公開MCP（`aiterm-mcp`）でPTYを開き、通常HOME・通常認証のまま`claude`/`codex`を起動する。Aitermの結果は宣言済みschemaのstructuredContentだけを読み、人間向けtextは解釈しない。`pty_open`は出力schemaを持たないため、指定したnameのsessionを`pty_observe`のstructured結果（`session_id`一致・`exists:true`）で確かめ、確かめられなければ`ACCEPTANCE_AITERM_SESSION_ID_MISSING`で止まる。試験dirの信頼dialogだけを肯定し、未知のdialogでは止まる。
6. 実親に`parent_join`を1回呼ばせ、`verified`を待ってからscenarioを実測する。製品sourceのcommitと、実行controllerのcommit・各fileのSHA-256は別々に記録し、指定commitのGit blobと実行fileを照合する。
7. 後片付けを逆順で行う。harness終了、製品自身のendpoint停止の観測（合格期限30秒、遅延測定は最大120秒）、Codexの試験dir信頼entry削除、PTY close、room停止、`connect --remove`、設定の意味比較。各段の結果は`cleanupFailure`が完了条件と照合する。harness未終了、所有processの残存、endpoint未停止、pane・room processの残存、信頼entryの残存、connect解除の失敗、意味比較の不一致、Codex `config.toml`本文の不一致は、それぞれ原因code付きの`failed`になり、runは失敗で終わる。退避tarは`connect_remove`の完了条件をすべて満たした時だけ消す。製品が親終了後30秒以内にendpointを止めなかった場合（runnerが止める）と、停止済みendpointの索引が残った場合（runnerが自分の試験entryだけを外す）は、後片付け自体は続けるが、`findings`へ記録し、`endpoint_stop`を`PRODUCT_ENDPOINT_NOT_SELF_STOPPED`・`PRODUCT_ENDPOINT_STOPPED_BY_RUNNER`・`PRODUCT_STOPPED_ENDPOINT_INDEX_LEFT`の`failed`にしてrunを失敗で終える。

Codexだけ、session層の`-c`を2つ足す。MCPへtoken参照先を渡す`mcp_servers.peertable_parent.env_vars`と、無人実行で更新dialogを出さない`check_for_update_on_startup=false`である。Codexのtrust dialogは`-c`では回避できないため、起動時に受諾する。書かれた`projects.<試験dir>`は、終了後に公式`config/batchWrite`で削除する。

## 出力

- `<out>/public/rag/parent-delivery/live/<os>/<harness>/cli/<scenario>.json`: 公開投影の証拠。HOMEは`~`に置換し、credential/token系のkeyを落とす。
- `<out>/public/records.jsonl`: `product-acceptance.json`の`records`形式。親が受け入れる時に目録へ移す。
- `<out>/run-log.jsonl`、`<out>/summary.json`: 進行・後片付け・自己監査。
- `<out>/private/`（0700）: room data、token file、自sessionのtranscript複製、config比較。公開しない。

各caseは`evidence.mjs`がgateと同じ`auditAcceptance`で自己照合し、結果を`gate_errors`へ出す。gateが拒否した`passed`は目録へ出さず`ACCEPTANCE_SELF_AUDIT_FAILED`で止まる。観測が欠けたcheckは`failed`のまま目録形式で出し、runの成功には数えない。観測のないscenarioには成績を作らない（`ACCEPTANCE_NO_OBSERVATION`）。`summary.json`の`status`は、error・後片付けの失敗・`passed`以外のcaseが1つでもあれば`failed`になる。

transcript/rolloutは改行で終わった確定行だけを読む。確定行がJSONでなければ`ACCEPTANCE_TRANSCRIPT_CORRUPT`（行番号付き）で止まる。改行の無い末尾は追記中の未確定部分として`pending_tail`に数え、判定には使わない。最終判定の前に未確定末尾が消えるまで最大30秒待ち、消えなければtimeoutで止まる。

## 観測の出典

| 値 | 出典 |
| --- | --- |
| parent_session・実PID/開始identity | 製品spoolの`caller`（hookが実processから記録） |
| turn_id | Claude: transcriptの`promptId`。Codex: rolloutの`turn_context`/`task_started` |
| join相関 | Claude: `caller.use`と同じtool_use_idのturn。Codex: 同じ`endpoint_id`のjoin結果を返したtool出力のturn |
| 配送本文 | 会話へ入ったentryだけ。Claude: `promptId`付きuser entry（hookの`blocking error`表示）。`queue-operation`はnative queue証拠として別記録する。Codex: `response_item`のuser message |
| receipt | room `GET deliveries?seq=`（result、reason、receipt_revision、queued_submission_id、accepted_at） |
| native ACK | Claude: 配送user entryのuuid。Codex: 公式queueの受付ID |

Codexは`Stop`/`PostToolUse` hookの出力を`<hook_prompt>`要素へ入れ、本文をXML文字参照で符号化する。runnerはその要素の中身だけを定義済み実体と数値参照に限って復号し、照合する。証拠には`boundary.encoding`と`raw_body_equal`を残す。queue経由のidle配送は符号化されない。

## 実装済みscenario

`audience`はDM・親を含む複数宛・allを各1回送り、room/from/to/seq/本文一致と同会話の後続返答を測る。他の24 scenarioは`scenarios.mjs`に正本の全手順を持ち、`run.mjs`から`createScenarioContext`/`runScenario`を呼ぶ。contextに操作がなければ`ACCEPTANCE_SCENARIO_ADAPTER_MISSING`で止まり、実装した操作でも公式境界が未確認なら原因code付きの失敗で止まる。手順の存在と実機の合格は別に扱う。

既存contextで実行できるのは`busy`、`idle`、`consecutive`、`no_external_tools`、`no_tools`、`original`、`burst`、`source_reconnect`、`output_interruption`、`receipt_retry`、`package`。残る13 scenarioは`createNativeScenarioContext`で専用project・新しい公式sessionを作る。native操作は実装・実境界の確認を進めており、未確認の操作はtyped errorで止まる。各scenarioは専用nonce、実会話・turn・後続返答、原文一致、receipt、境界artifactを照合し、観測が欠ければ成績を作らない。

`source_reconnect`と`receipt_retry`では、試験親のHTTP/SSE接続だけを専用proxyへ向ける。runnerの投稿・観測APIはroomへ直接接続する。後片付けではproxyの接続を切ってlistenの終了を確認し、未終了なら`ACCEPTANCE_PROXY_NOT_CLOSED`でrunを失敗にする。

focused test: `node --test experiments/parent-product-acceptance/evidence.test.mjs experiments/parent-product-acceptance/scenarios.test.mjs`

lease単独runは`scenarios-lease-run.mjs`へ導入物・tarball SHA・製品source/digest/version・`--runner-commit`を渡す。短時間runとroom/processを分離し、実際の製品期限まで待つ。通常HOMEと公式認証を維持し、global設定や認証を長時間fixtureへ複製しない。実行moduleに未commit差分があればprovenance照合で止まる。
