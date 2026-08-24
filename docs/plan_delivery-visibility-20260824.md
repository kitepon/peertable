# campaign: delivery-visibility-20260824 — 稼働状況不可視インシデントの根治

出典: 2026-08-24 オーナー報告「Peertable稼働状況不可視インシデント」。
OpenLogicool 円卓への依頼 #937 が、席・bridge 全停止の room へ `sent [937]` とだけ返り、
親（Codex）が room 保存を配達成功と誤認した。原因は Peertable の契約（MCP が実効状態を返さない・
保存と配達の receipt が未分離・bridge 障害が親へ伝わらない・開始ゲートなし・resume 入口なし）。

修正対象は Peertable 単独。dotagents / OpenLogicool 製品コードは変更しない。

## 設計方針

- **実効状態の生成点は room server ただ一つ**。`GET /members` が各 member へ
  `status_effective` / `status_reason` / `status_age_ms` を付け、Web UI と MCP は同じ欄を読むだけにする
  （Web UI 側の独自 staleness 計算は廃止）。鮮度閾値 90 秒（bridge 心拍 30 秒の3倍）は server 定数。
- **bridge 台帳**: server に `bridges` 表（room×kind）。seat-status / wakeup 両 bridge が
  30 秒心拍を `POST /api/<room>/bridges` へ送る。心拍が 90 秒途絶＝`status_bridge_down` /
  `wakeup_bridge_down`。書込 403 は server 自身が観測して `bridge_auth_failed` として実効表示する
  （403 を返した server が唯一の確実な観測点。bridge 側は書けないので自己申告できない）。
- **配送 receipt 台帳**: server に `deliveries` 表（room×seq×recipient）。wakeup-bridge が
  TUI 投入の成立確認後にだけ `delivered` を書く。席不在系（`SEAT_TUI_GONE` / `MEMBER_MISSING` /
  `DESCRIPTOR_MISSING`）は `seat_unavailable`、送信不成立は `failed` を書き、再試行成功で上書きする。
- **post の二段化**: `POST /messages` 応答へ `room_saved: true` と宛先別 `delivery` を付ける。
  receipt 未着の宛先は server が member 台帳と bridge 台帳から
  `pending` / `seat_unavailable` / `bridge_unavailable` を導出する。MCP `post` は
  `sent [n]` をやめ、`room_saved [n]` ＋宛先別 delivery を返す。照会は `GET /api/<room>/deliveries?seq=` と
  MCP `delivery_status` ツール。
- **kickoff-gate**: `skill/scripts/kickoff-gate.mjs` が3条件（fresh 状態・kickoff の delivered receipt・
  席の引受発言）を機械判定し、揃うまで `pending`。親の推測・待ち時間判定を置き換える。
- **resume**: `skill/scripts/resume.sh` が既存 room を保ったまま、plan 再束縛・死記録掃除・
  台帳からの席再起動・bridge 再起動・fresh heartbeat 読戻し・probe DM の delivered receipt 確認までを一回で行う。

## 工程

1. **t1 server**: bridges / deliveries 表、実効状態生成、403 観測、`POST /bridges`・`POST /deliveries`・
   `GET /deliveries`、`POST /messages` 応答拡張、Web UI の server 実効状態化＋bridge 障害表示。
2. **t2 client(MCP)**: members / read_unread へ実効状態と bridge 健全性、post 応答二段化、`delivery_status` ツール。
3. **t3 bridges**: seat-status / wakeup の心拍送信、wakeup の receipt 書込（席不在系の typed 化を含む）。
4. **t4 gate**: kickoff-gate.mjs ＋ SKILL.md / templates への焼き込み。
5. **t5 resume**: resume.sh（doctor --repair を土台に再利用）＋ SKILL.md。
6. **t6 検証・出荷**: experiments へ罠別 repro（実効状態・receipt・gate）、focused test 一式、
   version 0.7.0、push、npm publish、本番 room 入替（deploy/README.md 手順）、公開後 smoke。

## 受入条件（オーナー報告の10項をそのまま採用）

1. 席が存在しない場合、MCP で `seat_unavailable` と分かる
2. 状態 bridge 停止から 90 秒以内に `unknown` / `status_bridge_down`
3. HTTP 403 が `bridge_auth_failed` として親と UI の両方に見える
4. `post` 成功だけでは `delivered` にならない
5. TUI 投入後にのみ配送 receipt が作られる
6. 配送 receipt なしでは円卓 task が `active` にならない（kickoff-gate）
7. 既存 `OpenLogicool` room を維持して resume できる
8. resume 後、各席の fresh status と引受応答を確認できる
9. focused test で Web UI と MCP の状態判定が一致（＝両者が server 生成の同一欄を読む）
10. dotagents と OpenLogicool 製品コードを変更せず成立する

注: 7・8 の本番実施（OpenLogicool room の実 resume）は OpenLogicool 側の運用で行う。
本 campaign では resume 機構の実装と repro による検証までを完遂範囲とする。

## 決定

- **決定101**: 実効稼働状態は room server が生成する唯一の判定であり、Web UI・MCP・script は
  `status_effective` / `status_reason` を読むだけとする。閲覧面ごとの独自判定を禁止する。
- **決定102**: room 保存と TUI 配達は別の事実として扱う。`post` の応答は `room_saved` と
  宛先別 `delivery` の二段で返し、`delivered` は wakeup-bridge の投入成立 receipt だけが作る。
- **決定103**: bridge の生死・認証失敗は server の bridge 台帳が実効表示する。心拍途絶は
  `*_bridge_down`、書込 403 は server 自身の観測から `bridge_auth_failed`。
- **決定104**: 円卓 kickoff は kickoff-gate の3条件（fresh 状態・delivered receipt・引受発言）が
  揃うまで `pending`。親の推測・経過時間による稼働判定を禁止する。
- **決定105**: 既存 room の再開は `resume.sh` を正規入口とする。手書き member 一覧・個別再起動 script に依存しない。
