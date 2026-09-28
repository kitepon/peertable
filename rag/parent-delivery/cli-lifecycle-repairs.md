# CLIの終了・設定解除・本人相関の修理

取得日: 2026-09-29。確度: 再現とfocused試験は確認済み。修理後の全必須面の正式製品受入は未完了。

## Linuxの実行中binary更新

Claudeの更新で実行中binaryが削除され、`/proc/<pid>/exe`のリンク名に` (deleted)`が付いた。basenameをそのまま比較した旧実装は、存命中のClaudeを別processとして扱った。[Linux man-pagesの一次仕様](https://man7.org/linux/man-pages/man5/proc_pid_exe.5.html)は削除後のsuffixと、存命中processの実行fileをリンク経由で参照できることを説明する。

製品のOS adapterはnative名と存命inodeの参照先を分ける。Codexの公式app-serverも、PID・開始identityが一致する実親の現在の実行fileを解決して起動する。Linuxで実Node ELFをコピー・起動・unlinkしたfocused試験は合格した。これは認証済みClaude/Codexの配送合格の代替にはしない。

## Windows CodexのMCP Job

Codex 0.158.0の通常CLIで、`/quit`時にMCP Jobとその子watcherが一緒に終了した。`detached:true`とbreakawayの比較でも同じだった。保存した上流`job.rs`・`stdio_server_launcher.rs`とlibuvのWindows実装に、Job終了と子の所属の原因を確認した。

[MicrosoftのJob Objects仕様](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)によると、`Win32_Process.Create`で起動するprocessは呼出元のJobへ所属しない。[ProcessStartup仕様](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-processstartup)の環境blockとUnicode flag、[Create仕様](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/create-method-in-class-win32-process)のcwdと戻り値を使う。

`parent-process.mjs`はWindowsでPowerShell 7のstdinから起動specを渡し、WMI bootstrapが同じwatcherを起動する。env値をargvへ載せない。stdin、cwd、log、watcherの状態遷移は他OSと共通。壊れた外部応答と起動失敗はtyped errorにし、別経路で起動しない。

Windows実診断ではCodex/MCP終了後もwatcherが存命で、終了要求の送信開始から12.6秒で自分で終了し索引を撤去した。診断は`startEndpoint`を呼ぶ専用MCPとCursor種別のspoolを使い、Codex queue配送を避けた。正式`parent_join`試験でも525件の合格でもない。生timeline/eventsは診断scratchpadへ保存し、私物processは終了した。起動契約と失敗経路の3 focused試験はmacOS・Linux・Windowsで合格した。LinuxはNode 24.14.1で実行し、専用の一時fileとprocessを回収した。

## 設定解除

Codexのowned tableだけを手で取り除くと、公式APIの追加した区切り空行が残った。解除も公式`config/batchWrite`へ統一した。認証・model呼出しのない専用configで、外部hook key・承認を残し元のLF本文との一致を確認した。改行なし末尾やCRLFには公式formatterによる変更があるため、任意の字面を完全保持できたとは報告しない。

Claudeの解除では、導入した空eventが残りJSONの意味が元と異なった。導入前のkey/event名だけを記録し、導入した空event・容器を解除する。利用者の値や後から行った編集をbackup全体で戻さない。元から存在した空eventも保持する。Cursorの導入時versionとMCP容器も同じ所有契約で扱う。Grokの追加blockに不要な先頭空行があり、解除後に残る再現も確認し、追加blockの先頭空行を取り除いた。

runnerの空eventを除く意味比較は廃止した。Codexの試験dir信頼解除はWindowsのpath表記差と区切りを照合し、隣の同prefixのprojectを消さない。

## 本人相関と試験の再開条件

macOSのCursor通常CLI試験では、Throughlineの短命なprompt-submit用`/bin/zsh`を走査する間に終了競合を再現した。元の`ps`は開始identityを正常に返し、3ms後の`lsof`は終了code 0・空出力を返した。25ms後の両APIの再照会では本人が消失していた。旧adapterは成功した空出力を`PARENT_PROCESS_API_SCHEMA_INVALID`として伝播していた。

OS adapterは形式異常でも本人の消失を`ps`で確認し、確認できた場合だけ終了を返す。存命中の形式異常と、生存確認APIの権限異常は引き続きtyped errorにする。macOS境界のfocused 2件と修理moduleを使った実Cursor join・自己回収を確認した。実joinの再試行では同じ終了競合自体の再発火は観測していないため、正式受入合格としては扱わない。

Linux Grokは公式installerの実体名`grok-1.0.41-linux-x86_64`を旧判定が認識せず、事前hookが相関なしの`{}`を返し、実MCPのjoinが`PARENT_CALLER_UNBOUND`で失敗した。同じ公式実体の再起動で、実PID・開始identity・実pathと判定`null`を確認した。失敗当時の`/proc`原記録は取得できていない。版なしの公式実体名に加えて版を含む公式命名形式を認識し、未知のOS名は引き続き拒否する。正式Linux配送は新候補で再測定する。

[修理moduleのLinux実診断](linux-grok-native-name-diagnosis.json)では、公式Grokの実PID・開始identityを維持して`processHarness`と`harnessProcess`が一致した。rootは修理moduleのSHAを現行commitのfileと独立照合した。他harnessと未知の実体名は本人へ割り当てない。診断用Node自身の祖先照会は`/proc`の権限異常で停止しており、その経路の成功は主張しない。この記録は`product_live:false`の準備診断であり、正式配送の合格へ算入しない。

修理前`017bf2c`の受入manifest・Mac2件の原証拠は[snapshot](snapshots/017bf2c/product-acceptance.json)へbyte単位で保存した。[追加3件の独立監査](snapshots/017bf2c/additional-cli-independent-review.json)はWindows Claude/Codex・Linux Claudeのroom原文、実会話、後続返答、spool、SQLite receipt、controllerのGit blobを照合した。各3通は一致した。Linux packの全131entryは凍結packと本文・modeとも一致した。Windows packの全file本文は一致したが27fileのmodeが異なり、圧縮byte列だけの差ではなかった。いずれも修理後の候補へ流用しない。

長時間leaseはMac Claudeの公式slotまで成立したが、controllerのpath関数とendpoint再join関数の名前衝突で開始処理が失敗し、24時間の検証は成立しなかった。Mac Cursor/GrokとWindows Cursor/Grokも準備段階で失敗し、Linux Cursorは未ログインで開始できなかった。私物processは回収済みで、長時間受信の合格は0件である。controllerの名前衝突、Grokの完了task全文reader入力、実応答・途中page・Codex task完了記録を待つ処理を修理し、正式試験と区別してfocused確認した。

Claude/Cursor/Grokの事前hookはharness・名前・入力digest・PID開始identityを照合する。照合記録の30秒期限切れは`PARENT_BIND_TIMEOUT`として本人不一致と区別し、endpoint作成前に失敗する。Codexは公式thread metadataと実processを直接照合する。

## Codex初回probeの期限

初回Codex joinでは公式receiver検証後に作るspoolへprobe期限が設定されず、最初の公式app-server接続の失敗後も`receiving/armed`が残った。診断は専用watcherの実childをPID・開始identity・実binary・argvで限定してSIGSTOPし、製品の実15秒RPC timeoutと2秒close後の消失を観測した。時計・spool・RPC応答を改変していない。joinは成功した公式receiver検証後、watcher起動前に`armParentState`で30秒の期限を設定するよう修理し、実joinEndpointのfocused試験が合格した。

期限設定後の[実OS障害診断の原結果](codex-probe-deadline-diagnosis.json)では、30秒期限から14.478秒後に`PARENT_PROBE_TIMEOUT`とroomのfailed healthを観測した。[製品moduleとOS障害入口の指紋](codex-probe-deadline-fingerprints.json)をrootが実fileへ独立照合した。SSEのraw frameは採取していないため、心拍到着時刻との相関は直接観測として扱わない。コードでは期限判定が非同期queue処理後の`maintainReceiver`にあり、次の呼出しは25秒のSSE心拍まで待つ構造だった。これは30秒の期限合格ではなく、`product_live:false`の修理診断である。

watcherは所有spoolのdirectoryを監視し、atomic renameによる更新後の実期限へtimerを張る。期限到達時は同じatomic状態で再武装・成功・停止を照合してからfailedを保存し、healthを公開する。RPC待機とSSE心拍から期限を独立させた。心拍も新投稿も無い実SSE接続で、成功済みprobeの維持と後続の再武装・期限失敗を含む関連3試験が合格した。

[修理後の同じ実OS障害診断](codex-probe-timer-repair-diagnosis.json)では、実deadlineの10ms後にroomへfailed/PARENT_PROBE_TIMEOUTのhealthが記録され、最初のspool観測も332ms後に同じfailedとなった。rootは生timelineのGET members・spool・実親/child PIDを照合し、[指紋](codex-probe-timer-repair-fingerprints.json)の6実fileと製品3moduleのGit blobを照合した。停止したapp-serverは製品の実timeoutで消失し、自己fixture/serverの回収も確認した。修理診断であり、正式525件の受入には算入しない。

旧候補`43348b8`の6 audienceと18本文の独立監査は、元のsource・本文・判定を保った[snapshot](snapshots/43348b8/rag/parent-delivery/product-acceptance.json)へ保存した。現行manifestに算入しない。修理後の配布sourceと試験controllerをcommitへ固定し、Git blob・digest・版を照合して全必須面の正式試験を行う。main着地、npm公開、registry導入、本番反映はまだ行っていない。

Cursorのidle確認には[公式stop仕様](https://cursor.com/docs/hooks#stop)のcompletedと、同じconversation/generationを持つ専用observerを使う。公式資料とCLI実装の確認は、実機発火の合格と分ける。observerの起動時PID・開始identityを保存し、その本人の終了を照合する。親が先に終了した故障試験でも、停止時の所有証拠で私物receiverを再開・回収する。

## Codexの同会話での明示再登録

[実診断](codex-probe-rejoin-diagnosis.json)は初回app-serverを1回だけOS停止し、製品の自然timeoutと期限失敗の後に、同じ会話から正規`parent_join`を1回呼んだ。watcher本人とendpointは維持されたが、失敗probeのIDと記録が不変で、更新した30秒の期限でも再度failedになった。製品state・時計・RPC応答を変更していない。rootは[開始時bytesと製品Git blob](codex-probe-rejoin-fingerprints.json)を照合した。実装継続で変更されたcontrollerについては、診断開始時に保存したbytesを照合対象にした。

`startEndpoint`の生存watcherによる早期returnより前にprobeを保存し、明示joinでは現在の既知failed probeだけを新しい符号へ更新する。新probeの実受信完了後に旧failed synthetic probeへ`resolved_by`を追加する。原文・失敗状態・cursorを保持し、結果不明のprobeやDMの失敗を解決しない。配送29件、実join内部契約1件、watcher継続3件の関連focused試験が合格した。修正版の正規MCPによる再登録・新probe受信・後続DM・healthは再測定待ちであり、正式合格を増やしていない。

## Claudeの自己会話でのhook故障

[専用診断](claude-own-session-hook-diagnosis.json)は公式`--settings`の`disableAllHooks`だけで、同じ会話の自己CLIを停止・resumeした。正常joinと確認符号のモデル返答、無効化中の`PARENT_CALLER_UNBOUND`、復帰後の同endpoint・`verified`を、同CIDの公式MCP tool IDと対応するuser tool_resultへrootが独立照合した。専用controllerはglobalのbytes不変更を報告しているが、rootの独立監査は保存済み原transcriptと開始関数へ限定する。復帰後の新本文配送はこの診断では試していない。撤回候補の準備診断であり、正式受入へ算入しない。
