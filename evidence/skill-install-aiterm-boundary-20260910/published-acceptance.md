# 公開版の導入と受入確認

最終受入は完了した。修正版0.8.57をMac・Linux・Windows nativeへ公式導入し、全実機で公開版のlifecycleが成功した。

## 公開と導入

2026-09-10、Peertable 0.8.56を公式npmへ公開した。実装commit `c451ceb983a0bd3f70de65fb9773aba993eefeb7`とCI補正commit `a31515b835511c10db797cec9f7a70b256ed0617`はmainへ統合・push済み。公開前のpackは108 files、shasumは`e36ceaa7d0a6674053f7eca15d34d6fed29b9bf0`。既定ブランチの祖先検証とprepublish試験を通した。

Aiterm担当による0.33.1の3 OS導入と共有設定更新の完了を待ち、Peertable導入直前に設定hashとtarバックアップを取り直した。Aitermの修理・導入は所有者が実施し、Peertableから他製品repoへ書き込んでいない。

3 OSともAiterm永続PTYのSSH sessionから`npm install -g peertable@0.8.56`、`peertable install`、同コマンドの再実行、`peertable diagnostics`を実行した。WindowsはPowerShell 7を使用した。Macのnpmはpostinstallをブロックしたため、製品の明示入口`peertable install`で配置を完了した。

| 実機 | 公開版と配置 | 共有設定 | 実harnessによる受入 |
|---|---|---|---|
| macOS arm64 | 0.8.57、4 clientともcurrent | 導入前後のhash一致 | Codexで成功 |
| Linux amd64 | 0.8.57、4 clientともcurrent | 導入前後のhash一致 | Codexで成功 |
| Windows native | 0.8.57、4 clientともcurrent | 導入前後のhash一致 | Grokで成功 |

Mac/Linuxの実機試験は`PEERTABLE_SMOKE_PACKAGE_ROOT`へnpm global packageを指定し、そこにあるCLI・room server・AitermClientを実行した。sourceの試験ファイルは実行順の指定だけに使用した。setup、再setupによるtasks保存、実着席とroom投稿、同じnative process/sessionを保つeffort変更、DMへの応答、resume配達、teardown後の履歴保存とMCP原文復元が成功した。

Windowsではsetupとroom登録の後、初回`pty_send`がGrokの入力待ち判定で失敗した。通常GROK_HOME・空project・同model/effortの公開API単独対照は成功した。失敗画面と観測から、Peertableが先行配達した参加通知との競合を特定した。修理後のsourceでWindowsの全lifecycleが成功し、修正版0.8.57の公開後も3 OSすべてのlifecycleが成功した。

修理commitは`b34c7c4126908ee431d0753cb080c5b4fee2daf9`。npm 0.8.57のpackは109 files、shasumは`acadba7a19ffb8e35169c8fd99f1eedebc329949`で、配布に起動中の配達保留を実装するmoduleが入ることを確認した。Caveatの共有設定更新終了を確認してから3 OSのバックアップを取り直し、`npm install -g peertable@0.8.57`、`peertable install`、`peertable diagnostics`、導入直後の設定hash比較を実行した。すべて成功した。

0.8.57の実動作確認はMacでローカルAiterm PTY、Linux/WindowsでAiterm PTYからのSSHを使用した。Macの0.8.56確認ではOS標準sshdによる実SSHも実施済みで、使い捨てsshdは停止した。最終確認の実装・server・MCP接続はすべてnpm global packageから読み込んだ。fixtureの席とbridgeはteardownし、既存projectを変更していない。

## room本番

稼働中の卓が0件であることと、直前image `peertable-room:20260830-076df58`が残っていることを確認した。既定ブランチ祖先の`c451ceb`からMacでbuildxにより作成したlinux/amd64 image `peertable-room:20260910-c451ceb`をMS-A2へ運搬し、composeのimageだけを切り替えた。

切替後に新imageの稼働、公開APIのHTTP 200とCORS、SSEの`connected`と`ping`を確認した。既存peertable roomのmessages応答は切替前後でbyte一致した。認証設定と会話volumeは変更していない。旧composeのバックアップと旧imageを保持している。

## 最終CI

0.8.56のGitHub Actions [34410864780](https://github.com/kitepon/peertable/actions/runs/34410864780)、最終0.8.57の[34415518852](https://github.com/kitepon/peertable/actions/runs/34415518852)は、いずれもMac・Linux・Windowsを含め成功。最終ローカルCIではruntime 61件、CI/文書契約10件、OS別CLI、配置、構文、配布診断を確認した。別ベンダー反証と発見時のfocused試験は[反証記録](refutation-and-focused.md)を参照する。
