# CLIの終了・設定解除・本人相関の修理

取得日: 2026-09-29。確度: 再現とfocused試験は確認済み。修理後の全必須面の正式製品受入は未完了。

## Linuxの実行中binary更新

Claudeの更新で実行中binaryが削除され、`/proc/<pid>/exe`のリンク名に` (deleted)`が付いた。basenameをそのまま比較した旧実装は、存命中のClaudeを別processとして扱った。[Linux man-pagesの一次仕様](https://man7.org/linux/man-pages/man5/proc_pid_exe.5.html)は削除後のsuffixと、存命中processの実行fileをリンク経由で参照できることを説明する。

製品のOS adapterはnative名と存命inodeの参照先を分ける。Codexの公式app-serverも、PID・開始identityが一致する実親の現在の実行fileを解決して起動する。Linuxで実Node ELFをコピー・起動・unlinkしたfocused試験は合格した。これは認証済みClaude/Codexの配送合格の代替にはしない。

## Windows CodexのMCP Job

Codex 0.158.0の通常CLIで、`/quit`時にMCP Jobとその子watcherが一緒に終了した。`detached:true`とbreakawayの比較でも同じだった。保存した上流`job.rs`・`stdio_server_launcher.rs`とlibuvのWindows実装に、Job終了と子の所属の原因を確認した。

[MicrosoftのJob Objects仕様](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)によると、`Win32_Process.Create`で起動するprocessは呼出元のJobへ所属しない。[ProcessStartup仕様](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-processstartup)の環境blockとUnicode flag、[Create仕様](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/create-method-in-class-win32-process)のcwdと戻り値を使う。

`parent-process.mjs`はWindowsでPowerShell 7のstdinから起動specを渡し、WMI bootstrapが同じwatcherを起動する。env値をargvへ載せない。stdin、cwd、log、watcherの状態遷移は他OSと共通。壊れた外部応答と起動失敗はtyped errorにし、別経路で起動しない。

Windows実診断ではCodex/MCP終了後もwatcherが存命で、`/quit`から12.6秒で自分で終了し索引を撤去した。診断は`startEndpoint`を呼ぶ専用MCPとCursor種別のspoolを使い、Codex queue配送を避けた。正式`parent_join`試験でも525件の合格でもない。生timeline/eventsは診断scratchpadへ保存し、私物processは終了した。起動契約と失敗経路の3 focused試験はmacOS・Linux・Windowsで合格した。LinuxはNode 24.14.1で実行し、専用の一時fileとprocessを回収した。

## 設定解除

Codexのowned tableだけを手で取り除くと、公式APIの追加した区切り空行が残った。解除も公式`config/batchWrite`へ統一した。認証・model呼出しのない専用configで、外部hook key・承認を残し元のLF本文との一致を確認した。改行なし末尾やCRLFには公式formatterによる変更があるため、任意の字面を完全保持できたとは報告しない。

Claudeの解除では、導入した空eventが残りJSONの意味が元と異なった。導入前のkey/event名だけを記録し、導入した空event・容器を解除する。利用者の値や後から行った編集をbackup全体で戻さない。元から存在した空eventも保持する。Cursorの導入時versionとMCP容器も同じ所有契約で扱う。Grokの追加blockに不要な先頭空行があり、解除後に残る再現も確認し、追加blockの先頭空行を取り除いた。

runnerの空eventを除く意味比較は廃止した。Codexの試験dir信頼解除はWindowsのpath表記差と区切りを照合し、隣の同prefixのprojectを消さない。

## 本人相関と試験の再開条件

Claude/Cursor/Grokの事前hookはharness・名前・入力digest・PID開始identityを照合する。照合記録の30秒期限切れは`PARENT_BIND_TIMEOUT`として本人不一致と区別し、endpoint作成前に失敗する。Codexは公式thread metadataと実processを直接照合する。

旧候補`43348b8`の6 audienceと18本文の独立監査は、元のsource・本文・判定を保った[snapshot](snapshots/43348b8/rag/parent-delivery/product-acceptance.json)へ保存した。現行manifestに算入しない。修理後の配布sourceと試験controllerをcommitへ固定し、Git blob・digest・版を照合して全必須面の正式試験を行う。main着地、npm公開、registry導入、本番反映はまだ行っていない。
