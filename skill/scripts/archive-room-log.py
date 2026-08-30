#!/usr/bin/env python3
"""room の会話ログを Markdown へ書き出す（teardown の archive モード用）。

usage:
  archive-room-log.py <server_url> <room> <out.md>   ログを書き出す
  archive-room-log.py --members [--json] <server_url> <room>  member を出す（席を畳む相手）

本文は投稿時の Markdown をそのまま置く（引用ブロックで包むと表とコードが崩れる）。
本文の無い発言（過去に本文なし POST が着地した分）は、欠落と分かる形で残す——
消すと「そこに発言があった」ことまで消える。
"""
import json
import sys
import urllib.request
from urllib.parse import quote


def fetch(url, path):
    encoded_path = quote(path, safe="/")
    with urllib.request.urlopen(f"{url.rstrip('/')}{encoded_path}", timeout=15) as r:
        return json.load(r)


def main(argv):
    if argv[:1] == ["--members"]:
        as_json = argv[1:2] == ["--json"]
        url, room = argv[2:4] if as_json else argv[1:3]
        members = fetch(url, f"/api/{room}/members")["members"]
        if as_json:
            print(json.dumps([{"name": m["name"], "observe": m.get("observe")} for m in members]))
        else:
            print(" ".join(m["name"] for m in members))
        return 0

    url, room, out = argv[0], argv[1], argv[2]
    messages = fetch(url, f"/api/{room}/messages")["messages"]
    lines = [
        f"# 円卓ログ — room `{room}`（全{len(messages)}発言）",
        "",
        "teardown（archive モード）が、解散の区切りを投稿する前までの room ログを書き出した控え。"
        "room と過去ログの原本はサーバー側に残り、次の卓も同じ room で続く。",
        "",
        "---",
        "",
    ]
    for m in messages:
        body = m.get("body")
        if body is None:
            body = "（本文欠落——本文なし POST が着地した発言。欠落そのものを記録として残す）"
        names = m.get("to_names")
        audience = ", ".join(names) if isinstance(names, list) else m.get("to", "all")
        lines += [f"## [{m['seq']}] {m['from']} → {audience} ・ {m['ts']}", "", body, ""]
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return 0


if __name__ == "__main__":
    # 生の traceback を出さない。teardown の画面へ出るのは「何が起きたか」の1行であるべきで、
    # stack trace は読む側に原因を伝えない（呼び出し側は非ゼロだけを見る）
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001 — 入口なので型を絞らない
        print(f"ARCHIVE_ROOM_LOG_FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
