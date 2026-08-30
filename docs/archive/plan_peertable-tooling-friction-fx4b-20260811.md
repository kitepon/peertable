# Peertable tooling friction — h5 companion fix

## 工程

### h5 archive-room-logとteardown内のUnicode room pathを正しく送る

`teardown.sh`のroom URL表示修正をASCII roomで確認した後、日本語roomの実teardownで、
ログ控えの取得と解散区切りPOSTがraw Unicode pathのままPythonへ渡されて失敗することを
実測した。`archive-room-log.py`の取得pathと`teardown.sh`の解散POSTだけを、API pathの
percent-encodeで直す。ASCII path・room原本保持・member解除・archive modeの挙動は変えない。

`experiments/teardown-room-url-repro.mjs`の日本語ケースを正の受入に使い、修正前の
UnicodeEncodeError／解散POST失敗を負のcontrolとして固定する。h1（同じharnessのASCII/
日本語room URL表示）は本工程の完了を前提にする。

実装後は担当外の文脈近接一席が、実diff・ASCII/日本語の実room fixture・負のcontrolを監査し、
証跡へ所見を束縛してからdoneする。publishや本番deployは含めない。
