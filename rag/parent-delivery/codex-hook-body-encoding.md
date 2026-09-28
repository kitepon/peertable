# Codexの公式hook本文の符号化

出典は下記のOpenAI公式source。2026-09-29取得。符号化と復号の契約はsourceで確認済みで、実機照合の適用範囲はPeertableの受入判断である。

## 確認対象

Codex CLI 0.155.1の[公式実装 `protocol/src/items.rs`](https://raw.githubusercontent.com/openai/codex/rust-v0.155.1/codex-rs/protocol/src/items.rs)を確認した。`HookPromptXml`はhook本文をXMLのtextへ置き、`build_hook_prompt_message`と`serialize_hook_prompt`は`quick_xml`で符号化する。`parse_hook_prompt_fragment`は逆変換を行い、公式のround-trip testも往復を確認する。AitermのCodex受信hookもPeertableと同じ公式hook出力を使う。

## 実機照合

hook由来の本文は、公式XML textの符号化だけを一度復号してroom原文と比較する。元の本文に含まれる文字列`&gt;`を二重に復号しない。queueから直接入った本文にはこの変換を適用しない。

証拠には生の記録、`raw_body_equal`、`encoding: codex_hook_prompt_xml_text`、復号後の本文と照合結果を残す。任意の改行・空白・引用符の補正、末尾補完、抜粋の合格扱いは行わない。この規則は公式プロトコルの復号に限り、配送本文をPeertableで変更する許可ではない。
