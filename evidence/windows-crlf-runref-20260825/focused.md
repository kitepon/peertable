# Windows teardown run ref CRLF focused evidence

- 実再現: OpenLogicoolの0.7.1 teardownでactive run 8件中、最後以外の7件が末尾CRを含み`INVALID_RUN_REF`。最後の1件だけ受理された。
- 原因: Windows版PythonのCRLFをGit Bashの`read`がLFだけ除去した。
- 実装: 共通teardownはWindows adapterへのdispatchだけ。CR除去は`skill/scripts/platform/windows/normalize-read-line.mjs`。
- focused test: `node experiments/windows-crlf-run-ref-repro.mjs` 2/2 green。
- syntax: Git for Windows Bashによる`bash -n skill/scripts/teardown.sh` green。
- 追加再現: 0.8.0 setupで`lattice_cli`のWindows backslashが未escapeとなり、`setup-state.json`をNodeがparseできず3 bridgeが起動不能。
- 追加実装: 共通setupはWindows writerへのdispatchだけ。JSON serializationは`skill/scripts/platform/windows/write-setup-state.mjs`。
