import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class Export(unittest.TestCase):
    def test_success_reclaims_only_unreferenced_same_tag_and_failures_keep_source(self):
        script = Path(__file__).with_name('export-image.sh')
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            docker = root/'docker'
            docker.write_text('''#!/usr/bin/env python3
import os, sys
from pathlib import Path
args = sys.argv[1:]
if args[:2] == ['image', 'inspect']:
 print('sha256:' + ('2' if os.environ.get('MOVED') and Path(os.environ['MARKER']).exists() else '1')*64)
elif args[0] == 'save': print('archive')
elif args[:2] == ['container', 'ls']:
 if os.environ.get('REFERENCED'): print('protected-container')
elif args[:2] == ['image', 'rm']:
 Path(os.environ['REMOVED']).write_text(' '.join(args))
else: raise SystemExit(9)
''')
            ssh = root/'ssh'
            ssh.write_text('''#!/usr/bin/env python3
import os, sys
from pathlib import Path
sys.stdin.read()
Path(os.environ['MARKER']).touch()
raise SystemExit(int(os.environ.get('SSH_EXIT', '0')))
''')
            docker.chmod(0o755); ssh.chmod(0o755)
            for case in ({}, {'SSH_EXIT': '42'}, {'REFERENCED': '1'}, {'MOVED': '1'}):
                removed, marker = root/'removed', root/'received'
                removed.unlink(missing_ok=True); marker.unlink(missing_ok=True)
                env = {**os.environ, 'PATH': str(root)+os.pathsep+os.environ['PATH'],
                       'REMOVED': str(removed), 'MARKER': str(marker), **case}
                result = subprocess.run(['bash', str(script), 'peertable-room:fixture'], env=env, capture_output=True)
                self.assertEqual(result.returncode, int(case.get('SSH_EXIT', '0')), result.stderr)
                self.assertEqual(removed.exists(), not bool(case))
                if removed.exists(): self.assertEqual(removed.read_text(), 'image rm peertable-room:fixture')


if __name__ == '__main__': unittest.main()
