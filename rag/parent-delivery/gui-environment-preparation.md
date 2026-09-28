# GUI実機試験の環境準備

GUIの配送試験は未合格である。この記録は公式アプリと拡張の準備を示し、親へのnative配送の証拠には数えない。

LinuxとWindowsのCodex Appは正式なpackageと稼働processを確認した。Linuxはseat0のactiveなWayland session、Windowsはactiveなconsole sessionを確認している。SSHでDISPLAYが空でもGUI sessionの不存在とは判定しない。認証情報・個人の会話は読んでいない。

macOSのVS CodeとCodex拡張は導入済みである。不足していたLinuxのVS Code/Cursor Desktop、WindowsのVS Codeと両OSのCodex拡張を導入した。Linuxは[VS Code公式手順](https://code.visualstudio.com/docs/setup/linux)と[Cursor公式手順](https://cursor.com/docs/get-started/quickstart)のapt repositoryと署名keyを使い、WindowsはwingetのMicrosoft.VisualStudioCode user installerを使った。拡張は[VS Code公式CLI](https://code.visualstudio.com/docs/configure/command-line)のinstall-extensionでOpenAIのopenai.chatgptを導入した。拡張の用途は[OpenAI公式IDE案内](https://learn.chatgpt.com/docs/codex/ide)を参照する。

導入処理は既存のCodex設定・Peertableの接続・他のhookを編集していない。今回の導入ではGUIアプリを起動していない。残る観測は、対象アプリと拡張のサインイン、専用projectの実会話、背景配送後の同じ会話の継続と原文確認である。Jevの画面取得が停止しているため、GUI試験に限る操作ツール変更についてオーナーの回答を待っている。
