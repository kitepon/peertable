# 保存と回収の機能・データフロー

対象版はab74745以後のmain。未統合のリファクタ候補7e9f21aをこの版の実装として扱わない。[全体機能図](../README.md)、[現行設計](current-design.md)、[配備入口](../deploy/README.md)から接続する。Ownerの容量是正に合わせ、実装前に以下の変更を設計した。データを保存する責務と回収する責務は同じ製品入口が所有する。

| 機能・入口 | 入力→所有する保存先→出力・後始末 |
| --- | --- |
| room/server.mjs HTTP | 認証済POST→volumeのJSONL/SQLite→応答/SSE。archiveはmarker、明示DELETEだけが会話を削除 |
| setup/resume/launch/leave | 設定→.team/席credential/bridge記録→Aiterm公開API。leaveで本人席資材を撤去、teardownは停止・成果/ログ控え→room解散→所有物撤去。失敗はincompleteで再開足場を保持 |
| parent-connect/parent-delivery | 本人設定→設定tarと接続記録、room event→spool→channel→receipt。設定tarは下記の内容単位で重複を防ぐ。unknown/再送防止/異なる設定の復旧元は利用者データとして保持 |
| package/CI | files指定→npm pack/publish→利用者導入。ci.ymlのUbuntu deployment jobは標準Pythonで受信/保持/復旧のtest_*.pyを実行。試験tempdirはfinally回収、共有runner内部は製品の削除範囲外 |
| image build | room/Dockerfile限定COPY→開発機Docker image。現用/直前/他者参照を保護、共有build cacheは製品がpruneしない |
| 運搬（今回修理） | export-image.sh→開発機docker save→SSH stdin→receive-image.py→QNAP専有stage→hash/identity検証→content-addressed tar/hash→送信元の同ID/全container無参照を確認→その自製品tagだけ撤去。ローカルtarを生成しない |
| 配備 | up.sh→op run→deploy-room.py:deploy→flock/pending→Compose→accept→current/previous/accepted→cleanup |
| 回収（今回修理） | cleanup→全image/container inventory→現用/直前archive検証→受入済で未参照の旧roomタグ削除→再inventory→不存在の旧受入archive/hash/旧receipt回収→履歴圧縮/固定receipt |

## 運搬の正常・異常経路

`receive-image.py`は配備と同じ`.deploy.lock`を非待機で取得し、QNAP実mountを必須とする。固定専有stage `images/.receive-image` はこの入口だけが所有する。前回SIGKILLの残りは次の同入口がlock取得後に回収する。stdin→一時tarとSHA→`verify_archive`でimage ID/tagを照合→checksumを先に、tarを後にrenameして確定する。既存の検証済tarは再利用し、上書きしない。正常・読取失敗・検証失敗はfinallyでstageを回収する。通信切断でも検証前tarを正式控えにしない。mount不足時はSSDへ代替しない。受信はload/Compose/サービス停止を行わない。

送信元の `export-image.sh` はtag/ID検証→pipefail付きsave/受信→受信成功後だけ同tagのIDと全container参照を再確認する。変化・参照ありは保持、参照なしの本人tagだけ通常docker image rm（forceなし）で撤去する。他者tag/共有layerはDockerが保護する。受信失敗/中断時は唯一の未確定build imageを保持し、同tagの正規再送成功後に回収する。通常の新releaseごとに送信元tagを溜めない。KIOXIA上でのdocker saveには使わず、既存archiveの元read制限付き転送を使う。

## imageと控えの保持契約

`cleanup(state)`の入力は受入履歴。`removable`はcurrent/previous・停止中を含む全container参照・他製品tag/digest・未知tag・未完pendingを保護する。自repoの`peertable-room@<そのimage ID>`だけは同一製品の参照と識別する。他者alias/digestのある実体は保護する。削除直前にもmount/現用/全参照を照合する。force/prune/volume削除はない。

`verify_archive`はtar全体SHAに加え、従来のdocker save manifest/config方式、またはOCI indexのtag→descriptor digest→index/manifest/config/layer全blobのsize/SHAを照合する。Dockerが返すIDをconfig digestへ決め打ちしない。旧配備の証明済aliasだけはstateの`archive_refs[id]`で元archive tagを指定し、未知aliasは推測しない。

復旧のload後は、記録したimage IDへ記録した配備tagを明示して付ける。元archiveがSEC021 build tagを持つ場合も、別imageを同じものと推測せず、照合済の同IDだけをretagする。

QNAPもcurrent/previousと参照中・未知の保護対象を保持。回収するのは、受入履歴にあり、全image/containerから消えた旧IDの正確なtar/hash/旧receiptだけ。回収後はacceptedとarchive_refsを圧縮する。途中終了で片方だけ残っても、同入口がmissing_okで残りを回収する。保持2世代のarchiveを検証する前に旧控えを消さない。固定`retention-receipt.json`で世代ごとの重複receiptを増やさない。

受入失敗はexit1/pending保持で削除0。受入後の整理失敗はexit3/accepted-deferredでサービスを戻さず、同じ`--cleanup`で再開する。配備/受信のlockは製品の全writerが守る。第三者の直接Docker操作と同時に整理しない。履歴seedは実切替原本と現物照合を担当が行い、日時やタグだけから作らない。

会話/台帳・spool/receipt/unknown・必要な復旧設定をcacheとして期限削除しない。自席の描画依存/取得cache/証拠はBotの環境手順が所有し、製品CLIから他者の作業領域を回収しない。

## 親接続の設定控え（追加調査後・実装前）

`parent-connect.mjs:connectParent`→`backup(files, directory)`→既存 `withParentLock`→設定pathとbytesのdigest→同内容tarがあれば再利用、無ければ固定専有 `.pending.tar` にtar作成→作成前後の入力digest照合→0600/atomic rename→控えpathを接続記録へ返す。競合・tar失敗時は設定更新へ進まず、finallyで未確定tarを回収する。SIGKILLの残りは次の同lock取得後に回収する。lockのownerは既存PID/開始identityで判断し、稼働中の他writerは保護する。

古いtimestamp名の控えは、一律期限削除しない。現行接続記録が参照するtarと内容の異なる復旧元を保持する。既重複の実整理は担当が端末内でtar内の全entry名/種別/モード/所有者/リンク/内容digest/時刻以外のPAX属性を比較し、同じ復旧内容の組だけ、参照tar・新内容名tarまたは一つを保持して残りを回収する。時刻以外の復旧内容は省略しない。内容や資格値は端末外へ出さない。通常connectは同じ設定に対して新しい控えを増やさず、旧timestamp控えの自動削除は行わない。

公開はpackage/lockと`room/client.mjs`のMCP_VERSIONを同じ0.9.12に揃え、既定branchへ着地後のtagで行う。roomサーバー実装は変更せず、image更新/再配備は不要。4台のglobal package更新と導入診断を確認し、実接続や稼働席再起動は行わない。

権限変更の試験は実際の作成modeから異なるmodeへ変える。ホストのumaskによって最初から0600でも、同じmodeへの再設定を変更試験へ数えない。製品のmode別控え契約は同じ。
