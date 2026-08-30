# Peertable 文書地図

Peertableは単独cloneで動作し、自身のsource、state、schema、着席配置、診断、release、rollbackをこのリポジトリで所有する。dotagentsは任意の工場統合とhost配線を統括するが、Peertableの製品判断や既定挙動を制御しない。

## 現行正本

- [README.md](../README.md) / [README.ja.md](../README.ja.md) — 利用者向け導入、操作、現行状態。
- [AGENTS.md](../AGENTS.md) — 開発、文書寿命、releaseの製品規約。
- [skill/SKILL.md](../skill/SKILL.md) — setup、resume、teardownと円卓運用の正規入口。
- [docs/current-design.md](current-design.md) — 製品境界、正本、協働、配送、runtime、releaseの現行設計契約。
- [deploy/README.md](../deploy/README.md) — room本番のreleaseとrollback。
- [skill/02_models.snapshot.md](../skill/02_models.snapshot.md) — provenance付き着席配置の製品内既定値。外部表は明示opt-in時だけ使う。

## Campaign・証拠・履歴

- `docs/plan_<campaign>.md` — 現行または状態照合中のcampaignだけ。着手前にLattice storeの状態と照合する。
- [evidence/](../evidence/) — 完了証拠。記録済み内容を現行手順として読まない。
- [docs/archive/](archive/) — 完了・supersededした計画と履歴。通常の読書順には含めない。
- [docs/archive/plan.md](archive/plan.md) — 累積decision log。過去の根拠を調べる時だけ読む。

完了した文書は`docs/archive/`へ移す。固定consumerが実在する場合だけ元の場所へ短い互換案内を残す。同じ目的の現行文書が複数ある場合は上の最寄りの正本へ統合し、同義の説明を並立させない。製品固有の操作・状態・release判断をdotagentsへ正本化しない。

## 検証

- runtime contract: `node --test skill/scripts/runtime-contract.test.mjs`
- 着席配置: `node experiments/seat-placement-repro.mjs`
- package gate: `npm pack --dry-run` と `npm run prepublishOnly`
- native診断: `peertable-client diagnostics --json`
