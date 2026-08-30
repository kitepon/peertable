# peertable room の deploy 手順（image-pull 型）

MS-A2（`192.168.1.2` / ssh 名 `main-server`）で常駐している room サーバーの入れ替え手順。

**本番ホストでは build しない。** image は開発マシン（Mac）で焼き、`docker save | ssh docker load` で運んで、MS-A2 では `compose up` だけを叩く。2026-08-08 の ext4 障害で build 同居のコストが顕在化したことへの構造対処（因果は未確定だが、build と本番常駐を同じホストに置く理由は元から無い）。

## 前提

- MS-A2 の `~/peertable/` は **git 管理外**。`deploy/`（`compose.yaml`・`.env`）と `room/` がファイルとして置かれているだけで、**`git pull` は使えない**（2026-08-08 実測）
- 書込トークンは MS-A2 の `~/peertable/deploy/.env`（`PEERTABLE_POST_TOKEN=…`）。**触らない**
- 会話ログは named volume `peertable_room-data`。**image を入れ替えても消えない**（2026-08-08 の deploy で実証済み）
- Mac は Apple Silicon、MS-A2 は amd64。**`--platform linux/amd64` の指定が要る**

## 手順

### 1. Mac で image を焼く

```bash
cd <peertable repo>
TAG=$(date +%Y%m%d)-$(git rev-parse --short HEAD)
docker-buildx build --platform linux/amd64 --load -t peertable-room:$TAG room/
```

**`docker buildx`（CLI プラグイン経由）ではなく `docker-buildx`（standalone）を叩く。** この開発機では **`docker buildx` が `unknown command` を返し**、実在するのは `/opt/homebrew/bin/docker-buildx`（v0.36.0・Homebrew）だけ（2026-08-09 実測）。プラグイン配置を前提にすると新しい環境変更が要るので、**現ホストの正規入口をそのまま書く**。

**`--load` を明示する。** 直後に `docker save` するので、**driver 差に依存せずローカルの image store へ載せる**必要がある（`--load` = `--output=type=docker`）。付けないと build は成功しても `docker save` で image が見つからない。

タグは `日付-短sha`（例 `20260809-4605744`）。**`latest` は使わない**——どの commit が本番に居るかが分からなくなる。

**`docker build` で代用しない。`docker buildx build` を直接叩く。** Apple Silicon + Colima では **legacy builder の `docker build --platform linux/amd64` が信頼できない**（罠DB `docker-legacy-builder-on-apple-silicon-cannot-reliably-emit-linux-amd64-images-invoke-buildx-directly`）。「同じことだから」と書き換えたくなる場所なので明記する。

### 2. 運搬（registry 無し・LAN 直送）

```bash
docker save peertable-room:$TAG | ssh main-server docker load
ssh main-server "docker images peertable-room --format '{{.Repository}}:{{.Tag}}'"   # 載ったか確認
```

**registry を使わないのは認証を増やさないため。** 将来 GHCR へ移すならこの手順だけを差し替える（`docker push ghcr.io/…` → MS-A2 で `docker compose pull`）。compose 側は `image:` を参照しているので、そのまま乗る。

### 3. compose のタグを上げて入れ替える

**repo の `deploy/compose.yaml` を「本番で今動いている image」の情報源にしない。** MS-A2 の
`~/peertable/` は git 管理外なので、compose.yaml は scp で運ぶ運用になっている。**運んだ後に
repo 側へ commit し忘れると、repo と本番が静かに食い違う。** 2026-08-10 の実測では、repo が
`20260809-d44d435` を指したまま本番は `20260809-918d660` で動いていた。ロールバック先を repo から
読んだ人は、存在しない「直前の版」へ戻そうとすることになる。

今動いている版を知りたい時は、必ず実物を見る:

```bash
ssh main-server "docker ps --filter name=peertable-room --format '{{.Image}}'"
ssh main-server "grep image: ~/peertable/deploy/compose.yaml"
```

`deploy/compose.yaml` の `image:` を新しいタグへ書き換え、MS-A2 の `~/peertable/deploy/compose.yaml` へ反映してから:

```bash
ssh main-server "cd ~/peertable/deploy && docker compose up -d room"
ssh main-server "docker ps --filter name=peertable-room --format '{{.Names}}\t{{.Status}}\t{{.Image}}'"
curl -sS -o /dev/null -w "%{http_code}\n" http://192.168.1.2:18860/api/<room>/members
```

**この操作で room が数秒落ちる。** 卓が動いている時は、**実施時刻を事前に room へ宣言してから**叩く。オーナー在席時間帯に行う。

### 4. 公開面の確認

```bash
curl -sS -D- -o /dev/null https://peertable.kitepon.dev/api/<room>/members | grep -iE '^HTTP|access-control'
curl -sN --max-time 30 https://peertable.kitepon.dev/api/<room>/events | head -6   # event: ping が25秒以内に来るか
```

## ロールバック

**旧タグの image が MS-A2 に残っている限り、`compose.yaml` の `image:` を戻して `up -d` するだけで戻る。**

```bash
ssh main-server "docker images peertable-room --format '{{.Tag}}'"   # 戻り先が在るか **先に** 確認する
# compose.yaml の image: を旧タグへ戻して
ssh main-server "cd ~/peertable/deploy && docker compose up -d room"
```

**戻り先が無い状態で切り替えない。** 入れ替え前に必ず `docker images` を見る。古いタグは容量を圧迫しない限り消さない。

戻り先は日付や文書中の固定タグから選ばず、切替直前に実機で確認した稼働image tagを記録して使う。会話ログの`peertable_room-data` volumeはimage rollbackの対象にせず、そのまま保持する。旧imageが無い場合は切替を始めない。

## 検証用に room サーバーを立てる時の注意

deploy の前後で使い捨ての room を立てて確かめることがある。その時に2回踏まれた罠:

- **`PEERTABLE_POST_TOKEN` は「空文字」と「未設定」が別物。** server は `?? null` で見ているので、**空文字を渡すと「空文字のトークンを要求する」**状態になり、全書込が 403 になる。子プロセスへ渡さないなら `delete env.PEERTABLE_POST_TOKEN`（環境変数を空にするのではなく消す）
- **落ちた検証 server がポートを掴んだまま残ることがある。** 次に立てた server が bind に失敗しても、`stdio` を捨てていると `EADDRINUSE` が画面に出ず、**curl は「前の壊れた server」へ当たる**。測る前に `lsof -ti:<port>` で確認するか、ポート 0（OS 任せ）で起こして実ポートを受け取る

## やらないこと

- **MS-A2 で `docker compose build` を叩かない**（この手順の目的そのもの）
- `caddy` コンテナ・`deploy/.env`・`room-data` volume には触らない
- 他サービス（mmobank・bingo・root-site）は各 repo の管轄
