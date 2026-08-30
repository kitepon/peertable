# Windows teardown run ref CRLF 修理

## 結論

Windows nativeで`teardown.sh`がWindows版PythonのCRLF出力を行単位で読むと、最後以外の`run_ref`へ末尾`\r`が残り、Lattice `run landing`が`INVALID_RUN_REF`で拒否する。共通teardownはWindows adapterを呼ぶ薄いdispatchだけを持ち、CR除去は`skill/scripts/platform/windows/normalize-read-line.mjs`が所有する。

## 受入条件

- CR付きrun refとCR無しrun refをWindows adapterが同じ正規形へする。
- POSIXではadapterを通さず従来値を維持する。
- OpenLogicoolの実teardownで複数run refの末尾CRが消え、全landing照会がtyped入力として受理される。
- OpenLogicoolの実setupでWindows Lattice CLI pathを持つ`setup-state.json`がvalid JSONになり、bridgeが起動する。
- focused test、release gate、npm公開、global install、OpenLogicoolのteam再構成と稼働ランプまで確認する。

## 非目標

- Latticeのrun storeやrun ref契約を変更しない。
- 共通fileへWindows固有のCR除去処理を直書きしない。
- 共通fileへWindows pathのJSON escape処理を直書きしない。
- Mac／POSIXのPython・改行契約を変更しない。
