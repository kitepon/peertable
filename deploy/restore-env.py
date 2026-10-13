"""Restore a private .env from the environment supplied by op run.

--check exercises file creation in a temporary private directory, compares the
result with the current .env if present, and removes the temporary file.
No secret values or digests are printed. Existing .env files are never replaced.
"""
import argparse
import json
import os
from pathlib import Path
import tempfile


def write_private(path, contents):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(contents)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    token = os.environ.get("PEERTABLE_POST_TOKEN", "")
    if not token or token.startswith("op://") or any(c in token for c in "\r\n\x00"):
        raise ValueError("unresolved or invalid token")
    # The deployed token is a single unquoted dotenv value. Reject dotenv syntax
    # rather than silently restoring a different value if that contract changes.
    if any(c.isspace() or c in "#'\"$`\\" for c in token):
        raise ValueError("token needs dotenv escaping")
    contents = ("PEERTABLE_POST_TOKEN=" + token + "\n").encode()
    target = Path(__file__).resolve().parent / ".env"
    if args.check:
        if target.exists() and target.read_bytes() != contents:
            raise ValueError("current env differs from resolved secret")
        with tempfile.TemporaryDirectory(prefix=".restore-check-", dir=target.parent) as directory:
            candidate = Path(directory) / ".env"
            write_private(candidate, contents)
            if candidate.read_bytes() != contents or candidate.stat().st_mode & 0o777 != 0o600:
                raise ValueError("restore verification failed")
        print(json.dumps({"restore_check": True, "mode": "0600", "temporary_file_removed": True}))
    else:
        write_private(target, contents)
        print(json.dumps({"restored": True, "mode": "0600"}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error_type": type(error).__name__}))
        raise SystemExit(1)
