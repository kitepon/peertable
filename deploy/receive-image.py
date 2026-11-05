#!/usr/bin/env python3
"""Receive a docker-save stream on QNAP; never load or restart a service."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys

spec = importlib.util.spec_from_file_location('deployment', Path(__file__).with_name('deploy-room.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


def receive(image, stream):
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image['id']) or not re.fullmatch(r'peertable-(room|sec021):[A-Za-z0-9_][A-Za-z0-9_.-]*', image['ref']):
        raise ValueError('invalid room image identity')
    if not os.path.ismount(deployment.QNAP):
        raise ValueError('QNAP is not mounted')
    deployment.BACKUPS.mkdir(parents=True, exist_ok=True, mode=0o700)
    stage = deployment.BACKUPS / '.receive-image'
    # The caller holds the same deployment lock, so no other receiver owns this stage.
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(mode=0o700)
    try:
        incoming = stage / 'image.tar'
        digest = hashlib.sha256()
        with incoming.open('xb') as target:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                target.write(chunk)
                digest.update(chunk)
        checksum = incoming.with_suffix('.tar.sha256')
        checksum.write_text(digest.hexdigest() + '\n')
        deployment.verify_archive(image, archive=incoming)
        archive = deployment.BACKUPS / (image['id'][7:] + '.tar')
        if not os.path.ismount(deployment.QNAP):
            raise ValueError('QNAP mount changed')
        reused = archive.exists()
        if reused:
            deployment.verify_archive(image)
        else:
            incoming.chmod(0o600)
            checksum.chmod(0o600)
            checksum.replace(archive.with_suffix('.tar.sha256'))
            incoming.replace(archive)
        return {'image': image, 'archive': str(archive), 'reused': reused}
    finally:
        shutil.rmtree(stage)


def main():
    if len(sys.argv) != 3:
        raise ValueError('usage: receive-image.py sha256:<image ID> peertable-room:<tag>')
    with (deployment.ROOT / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(receive({'id': sys.argv[1], 'ref': sys.argv[2]}, sys.stdin.buffer)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('image reception stopped: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
