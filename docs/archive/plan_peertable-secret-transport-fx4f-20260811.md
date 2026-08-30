# Peertable secret transport — companion fix 11

## 工程

### k2 書込トークンを画面・argv・transcriptへ出さず席へ渡す

2026-08-11 の実円卓で、`launch-seat.sh` が `PEERTABLE_POST_TOKEN` を含む `export` 文を
`tmux send-keys` で対話 shell へ入力し、さらに Codex の `mcp_servers.room.env` を作る起動引数へ値を
埋め込んでいることを確認した。値を表示しない一致判定でも、複数の実 Codex 席について process argv と
tmux scrollback の双方にトークン値が存在した。seat identity は raw argv を保存しないが、秘密はその前に
端末履歴・process観測面へ露出しているため、複製防止が成立していない。

秘密を対話 shell へ文字入力せず、Codex／Claude の起動引数へも埋め込まない。Peertable client が必要な
時だけ読める、席ごとに分離した権限 `0600` の runtime credential file など、**値をargvと端末描画へ
載せない一つの正規経路**へ置き換える。file path のような非秘密だけを席へ配達し、client はそこから値を
読む。値が欠落・読取不能なら環境変数やargvへfallbackせず、書込不能をtypedに報告する。launcher自身も
tokenをexport済み環境として子processへ継承せず、短命launcherを含むprocess環境の観測面へ残さない。

credential file は席の作成前に安全に用意し、起動rollback、設定変更、退席、teardownで対象席のものだけを
確実に消す。複数席の同時起動で共有fileを上書きせず、別room／別projectの資格情報を混ぜない。既存の
room API認証方式そのものやserver token管理は変更しない。実際に露出した境界だけを直し、新しい秘密管理
基盤は作らない。

受入は次の通り。

1. sentinel token を使った fixture で、`tmux capture-pane`、全scrollback、Codex／Claude起動argv、
   `ps eww` のprocess環境、Aitermの画面／transcript、seat identity、通常ログのどこにも値が現れない。
2. Codex席とClaude席のroom clientが、明示宛DMの送信と未読取得を従来どおり行える。
3. token fileまたは同等物は席ごとに分離され、directoryは `0700`、fileは `0600` である。
4. 起動失敗rollback、席設定変更、通常退席、teardown後に対象credentialが残らない。
5. token欠落・file読取不能はtyped errorとなり、平文env／argvへのfallbackを行わない。
6. 実 Codex席を起動して、秘密値を表示しない一致検査で全観測面が陰性、room投稿が成功することを測る。

`peertable-tooling-friction-fx4-20260811/h2` が同じ `launch-seat.sh` を変更中なので、h2の実装・peer auditが
閉じるまで本工程は共有fileへ書き込まない。`peertable-codex-lattice-env-fx5-20260811/j1` が配達する
member identity、plan、Lattice actor、CLIは非秘密として扱い、本工程へ巻き込まない。
