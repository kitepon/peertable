"""Host deployment boundaries; no 1Password calls or production changes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="peertable-deploy-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in ("up.sh", "restore-env.py"):
            shutil.copyfile(SOURCE / name, self.root / name)
        self.env = os.environ.copy()
        self.env.pop("PEERTABLE_POST_TOKEN", None)
        self.env["PYTHON"] = shutil.which("python3")

    def restore(self, *args):
        return subprocess.run([self.env["PYTHON"], str(self.root / "restore-env.py"), *args],
                              env=self.env, capture_output=True, text=True)

    def test_restore_roundtrip_permissions_no_overwrite_and_check_cleanup(self):
        self.env["PEERTABLE_POST_TOKEN"] = "fixture-token-123"
        result = self.restore("--check")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(list(self.root.glob(".restore-check-*")), [])
        self.assertFalse((self.root / ".env").exists())
        self.assertEqual(self.restore().returncode, 0)
        target = self.root / ".env"
        self.assertEqual(target.read_text(), "PEERTABLE_POST_TOKEN=fixture-token-123\n")
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.restore("--check").returncode, 0)
        self.env["PEERTABLE_POST_TOKEN"] = "different-fixture"
        self.assertNotEqual(self.restore().returncode, 0)
        self.assertNotEqual(self.restore("--check").returncode, 0)
        self.assertEqual(target.read_text(), "PEERTABLE_POST_TOKEN=fixture-token-123\n")
        self.assertNotIn("fixture-token-123", result.stdout + result.stderr)

    def test_restore_rejects_missing_empty_reference_and_dotenv_syntax(self):
        for token in (None, "", "op://vault/item/credential", "a\nb", "a#b", "a$b", "a b"):
            with self.subTest(token=token):
                if token is None:
                    self.env.pop("PEERTABLE_POST_TOKEN", None)
                else:
                    self.env["PEERTABLE_POST_TOKEN"] = token
                self.assertNotEqual(self.restore().returncode, 0)
                self.assertFalse((self.root / ".env").exists())

    def test_up_uses_resolved_environment_and_stops_if_op_fails(self):
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        fake_op = bin_dir / "op"
        fake_op.write_text('''#!/bin/sh
[ "$PWD" = "$EXPECTED_CWD" ] || exit 91
[ "$1" = run ] && [ "$2" = --env-file=op.env ] && [ "$3" = -- ] || exit 92
[ "${OP_FAIL:-0}" = 0 ] || exit 17
shift 3
export PEERTABLE_POST_TOKEN=resolved-fixture
exec "$@"
''')
        fake_docker = bin_dir / "python3"
        fake_docker.write_text('''#!/bin/sh
[ "$PEERTABLE_POST_TOKEN" = resolved-fixture ] || exit 93
printf '%s\\n' "$@" > "$EXPECTED_CWD/docker-called"
''')
        fake_op.chmod(0o700)
        fake_docker.chmod(0o700)
        self.env.update(PATH=str(bin_dir) + os.pathsep + self.env["PATH"], EXPECTED_CWD=str(self.root))
        (self.root / ".env").write_text("PEERTABLE_POST_TOKEN=stale-fixture\n")
        command = ["sh", str(self.root / "up.sh")]
        self.assertEqual(subprocess.run(command, env=self.env, capture_output=True).returncode, 0)
        marker = self.root / "docker-called"
        self.assertEqual(marker.read_text().splitlines(),
                         ["./deploy-room.py"])
        marker.unlink()
        self.env["OP_FAIL"] = "1"
        self.assertEqual(subprocess.run(command, env=self.env, capture_output=True).returncode, 17)
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
