# Peertable elastic capacity — companion fix 9

## 工程

### h9 frontierに応じた増員・縮退をowner催促なしで起動する

2026-08-11の実円卓で、Peertable側はCodex 3席が全てbusyかつready 4件、Lattice側は3席中2席が
idleかつready 4件だった。それでも親はオーナーから「未着手工程が多いなら増員してよい」と明示される
まで席数を見直さなかった。親roleには既に「ready＋active実装ToDo数に合わせて起こす／畳む」とある
ため、文書の存在だけでは自然な運用へ接続できていない。減員も同じく、席が余った状態を放置するか、
逆にWIPを持つ席を早く畳む危険がある。

Latticeのdispatch frontier、active／ready、independence、roomのlive member状態（busy／idle／dead）を
同じ容量面へ投影する。**目標席数は、着手済みのactive工程数と、現在のactive工程群・先行claim・書込み
境界に競合せず着手可能なready工程数の合計**とする。independence未検査は「競合なし」に含めない。この
目標席数が前回観測値から変わった瞬間を容量見直しの主triggerとし、親へ合計の旧値→新値、active／
競合なしreadyの内訳、稼働worker席数、推奨する増減数、次の正規操作をtypedに通知する。親席は目標席数へ
含めない。同じ合計の反復pollや競合なしready→activeへの単純遷移では通知しない。増員が必要なら安全な
`launch-seat.sh`入口と必要席数を提示し、オーナーの催促を待たず親が実行する。増員は工程の配車を意味せず、
新席はrole・room・工程正本から自分でclaimする。合計が減った時は縮退判断を起こすが、対象席がidleで、
本人と工程正本の双方からWIPなしを確認した後だけroom履歴を残して退役させる。

新しく起こした席または次工程を探した席が、Latticeの競合判定から`wait`／`hold`／競合による待機指示を
受けた場合は、待機席として保持しない。競合結果と未着手であることをroomへ一度記録し、未受理intake等の
一時状態を解放して直ちに退席する。親はmember登録と外部PTYを畳み、再び作業面の総数が増えた時に新しく
起こす。既存WIPがある席だけは成果を失わないhandoffを工程正本へ残してから畳む。競合解除を待つpollや
「そのうち空くかもしれない」という理由での席保持は行わない。

同じ状態を反復pollしても重複通知やturn浪費を起こさず、capacity差が変わった時だけ再通知する。Latticeを
使わない単独卓では`.team/tasks.md`とroom claimを正本として同じ判断語彙を使う。負例は今回の「3 busy＋
ready 4でも増員なし」「2 idle＋ready 4でも再claimなし」を固定し、修理後の実円卓でowner催促なしの
増員、frontier収束後の安全な縮退、task割当なしの自律claimまでを実測する。
