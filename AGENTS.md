# AGENTS.md

Peertable で働く全 AI エージェント共通のプロジェクト規約。上位のグローバル規約に加え、本書を優先する。

Peertableは単独cloneで利用・診断・release・rollbackできる製品であり、source、state、schema、着席配置snapshot、配布をこのリポジトリで所有する。dotagentsは任意の工場統合とhost配線を統括するが、Peertableの製品判断や既定挙動を制御しない。

## 製品の役割

**Peertable** — A round table of peer agents. No orchestrator at the head.

親（オーケストレーター）に最終判断が集中しない、メンバー並列型のマルチエージェント作業システム。
メンバーは並列・対等・長寿命で、役割は作業履歴から堆積する。判断は情報を最も持つ者（メンバー）がする。

- 現行設計契約: [docs/current-design.md](docs/current-design.md)
- 現行文書の入口と寿命: [docs/00_overview.md](docs/00_overview.md)。累積decision logはarchiveにあり、通常の読書順へ含めない
- 実装物は room（サーバー + セッションクライアント + 読み取り専用 Web UI）と peertable スキルのみ。Lattice・aiterm-mcp・Claude Code channels は既存資産・公式機能を使い、改造しない
- 稼働状況: room は MS-A2 で Docker 常駐、公開閲覧は https://peertable.kitepon.dev（読み取り専用・決定42）。書込は API + トークンのみ
- 配布: npm **peertable**（bin: `peertable-room` / `peertable-client`）。成果は利用面まで届ける。version bump、既定ブランチへの着地、npm publish、global install、公開後smokeまで一連の完遂とする。`npm pack --dry-run` の files 確認を publish 前に行う。room本番のreleaseとrollbackは [deploy/README.md](deploy/README.md) が正本

## 開発規範

- **過剰設計を禁止する。** 過度なセキュリティ・安全対策・失敗チェック機構を作らない。自プロジェクト内で完結する処理は、チェックで守るのではなくそもそも失敗しないように書く。チェック機構は外部プログラムに依存する境界だけに置く
- 初期検証ゲートは完結済み。以後の挙動変更は関連するfocused testを伴わせる
- **push はPeertable自身の既定契約として行う。** 作業後は fetch→照合→focused test→対象限定commit→push で製品repoへ真実を返す
- **npm publish と本番反映は完遂に含める。** 既定ブランチの祖先であることは `verify-release-commit` が強制する。公開済みnpm版は書き換えず、欠陥はfix-forwardする。緊急退避は既知正常versionを明示installし、復旧後に最新へ戻す。room本番は旧image tagと永続volumeを使う [deploy/README.md](deploy/README.md) のrollbackだけを使う

## 構成

```
peertable/
├── AGENTS.md             # 本書（聖典）
├── CLAUDE.md             # @AGENTS.md の 1 行 import のみ
├── package.json          # npm: peertable（bin 2 種・files 限定）
├── README.md / README.ja.md / LICENSE(MIT)
├── docs/00_overview.md   # 現行文書とarchiveの入口
├── docs/current-design.md # 製品の現行設計契約
├── docs/plan.md          # 旧path互換案内。累積decision log本文はarchive
├── docs/plan_<campaign>.md  # campaign 単位の計画正本。ここから `lattice todo migrate` で起票する
├── docs/archive/         # 完了・supersededした計画と履歴。通常の読書順から外す
├── evidence/<plan>/<task>.md  # 完了証跡。Lattice の記述子が digest で束縛する
├── room/                 # room サーバー + セッションクライアント + Dockerfile
├── deploy/               # MS-A2 常駐用 compose と Caddy snippet + deploy 手順書
├── scripts/              # release gate（既定ブランチ祖先の検証）
├── skill/                # peertable スキル（setup/teardown・席の起動・各ブリッジ。~/.claude/skills/peertable へ symlink）
└── experiments/          # 再現ハーネス。**踏んだ罠ごとに1本**置いて、退行を機械で止める
```

- **campaign の計画正本を `docs/current-design.md` へ相乗りさせない。** commit はファイル単位なので、別 campaign が同じファイルを未 commit で触っていると、他人の未監査変更を巻き込んで公開へ出す。`docs/plan_<campaign>.md` を1本立てて、そこから起票する
- **Lattice store が初期化済みの本 repo では、新規 plan は `lattice plan create` でなく `lattice todo migrate --input <extraction.json>` で入れる**（`plan create` は空 store の初期化専用で、`STORE_WRITE_CONFLICT / store_already_exists` を返す）
- `docs/`直下には現行契約と状態照合中のcampaignだけを置く。完了文書は`docs/archive/`へ移し、通常の読書順へ戻さない。同じ目的の現行文書は最寄りの正本へ統合し、同義の手順を複製しない
