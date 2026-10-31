#!/usr/bin/env python3
"""MS-A2 deployment: acceptance before conservative, archive-backed retention."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import re
import tarfile
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parent
QNAP = Path('/var/mnt/qnap-backups')
BACKUPS = QNAP / 'main-server/products/peertable/images'
STATE = ROOT / 'image-retention.json'


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.PIPE).strip()


def inspect(kind, ref):
    return json.loads(docker(kind, 'inspect', ref))[0]


def save_state(state):
    temp = STATE.with_suffix('.tmp')
    temp.write_text(json.dumps(state, indent=2) + '\n')
    temp.chmod(0o600)
    temp.replace(STATE)


def image_ref(container):
    ref = container['Config']['Image']
    if not ref.startswith('peertable-room:') or inspect('image', ref)['Id'] != container['Image']:
        raise ValueError('unrecognized or moved room image reference')
    return {'id': container['Image'], 'ref': ref}


def read_api(base, path):
    with urllib.request.urlopen(base + path, timeout=35) as response:
        return json.load(response)


def histories(base):
    from urllib.parse import quote
    index = read_api(base, '/api/rooms')
    if index['schema'] != 'peertable.rooms.v1':
        raise ValueError('room API schema')
    return {name: read_api(base, '/api/' + quote(name, safe='') + '/messages')['messages']
            for name in index['rooms'] + index['archived']}


def accept(before, expected):
    live = inspect('container', 'peertable-room')
    if not live['State']['Running'] or live['Image'] != expected:
        raise ValueError('unexpected running image')
    after = histories('http://192.168.1.2:18860')
    for name, messages in before.items():
        if after.get(name, [])[:len(messages)] != messages:
            raise ValueError('room history prefix changed')
    public = read_api('https://peertable.kitepon.dev', '/api/rooms')
    if public['schema'] != 'peertable.rooms.v1' or set(public['rooms'] + public['archived']) != set(after):
        raise ValueError('public room API mismatch')
    from urllib.parse import quote
    if after:
        endpoint = '/api/' + quote(next(iter(after)), safe='')
        for token, status in [(os.environ['PEERTABLE_POST_TOKEN'], 400), ('invalid-retention-probe', 403)]:
            request = urllib.request.Request('http://192.168.1.2:18860' + endpoint + '/messages',
                data=b'{}', headers={'Content-Type': 'application/json', 'X-Peertable-Token': token})
            try:
                urllib.request.urlopen(request, timeout=10)
                raise ValueError('authentication probe unexpectedly accepted')
            except urllib.error.HTTPError as error:
                if error.code != status:
                    raise ValueError('authentication probe failed')
        with urllib.request.urlopen('https://peertable.kitepon.dev' + endpoint + '/events', timeout=35) as events:
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline:
                line = events.readline()
                if not line:
                    raise ValueError('public SSE ended')
                if line.strip() == b'event: ping':
                    break
            else:
                raise ValueError('public SSE heartbeat absent')
    return image_ref(live)


def verify_archive(image):
    # The incoming archive is staged on QNAP before load; never docker-save to SSD.
    archive = BACKUPS / (image['id'].removeprefix('sha256:') + '.tar')
    checksum = archive.with_suffix('.tar.sha256').read_text().split()[0]
    digest = hashlib.sha256()
    with archive.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != checksum:
        raise ValueError('archive checksum mismatch')
    with tarfile.open(archive) as bundle:
        manifest = json.load(bundle.extractfile('manifest.json'))
        for entry in manifest:
            for layer in entry['Layers']:
                if not bundle.getmember(layer).isfile():
                    raise ValueError('archive layer missing')
        matched = False
        for entry in manifest:
            config = bundle.extractfile(entry['Config']).read()
            if 'sha256:' + hashlib.sha256(config).hexdigest() == image['id']:
                matched = image['ref'] in entry.get('RepoTags', [])
                if matched:
                    break
        if not matched:
            raise ValueError('archive does not contain recorded image/tag')


def removable(images, containers, accepted, keep):
    known = {x['id']: x['ref'] for x in accepted}
    used = {x['Image'] for x in containers}
    result = []
    for image in images:
        image_id = image['Id']
        ref = known.get(image_id)
        if image_id in keep or image_id in used or ref is None:
            continue
        # Any other tag or digest may belong to another product or unfinished candidate.
        if image.get('RepoTags') != [ref] or image.get('RepoDigests'):
            continue
        result.append({'id': image_id, 'ref': ref})
    return result


def inventory(kind):
    ids = docker(kind, 'ls', '-aq', '--no-trunc').splitlines()
    return [inspect(kind, ref) for ref in sorted(set(ids))]


def cleanup(state):
    if state.get('pending') or not state.get('current') or not state.get('previous'):
        raise ValueError('incomplete deployment history')
    if not os.path.ismount(QNAP):
        raise ValueError('QNAP is not mounted; cleanup deferred')
    current, previous = state['current'], state['previous']
    for image in [current, previous, *state['accepted']]:
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', image['id']) or not re.fullmatch(r'peertable-room:[A-Za-z0-9_][A-Za-z0-9_.-]*', image['ref']):
            raise ValueError('invalid deployment record')
    live = inspect('container', 'peertable-room')
    if image_ref(live) != current or not live['State']['Running']:
        raise ValueError('live deployment changed')
    for image in (current, previous):
        if inspect('image', image['ref'])['Id'] != image['id']:
            raise ValueError('rollback/current tag moved')
    images, containers = inventory('image'), inventory('container')
    candidates = removable(images, containers, state['accepted'], {current['id'], previous['id']})
    # Validate every required archive before the first deletion.
    for image in [current, previous, *candidates]:
        verify_archive(image)
    receipt = BACKUPS.parent / ('accepted-' + current['id'][7:] + '.json')
    payload = json.dumps(state, sort_keys=True) + '\n'
    receipt.write_text(payload)
    receipt.chmod(0o600)
    if receipt.read_text() != payload:
        raise ValueError('QNAP deployment receipt verification failed')
    for image in candidates:
        if not os.path.ismount(QNAP) or inspect('container', 'peertable-room')['Image'] != current['id']:
            raise ValueError('deployment or mount changed')
        fresh = removable(inventory('image'), inventory('container'), state['accepted'],
                          {current['id'], previous['id']})
        if image not in fresh:
            raise ValueError('image references changed; cleanup stopped')
        docker('image', 'rm', image['ref'])
    return candidates


def deploy():
    state = json.loads(STATE.read_text()) if STATE.exists() else {'accepted': []}
    if state.get('pending'):
        raise ValueError('previous deployment unfinished; resolve image-retention.json before deploying')
    old = image_ref(inspect('container', 'peertable-room'))
    expected_ref = docker('compose', '--env-file', '/dev/null', 'config', '--images').splitlines()
    if len(expected_ref) != 1 or not expected_ref[0].startswith('peertable-room:'):
        raise ValueError('unexpected Compose image')
    expected = inspect('image', expected_ref[0])['Id']
    before = histories('http://192.168.1.2:18860')
    state['pending'] = {'previous': old, 'expected': expected}
    save_state(state)
    docker('compose', '--env-file', '/dev/null', 'up', '-d', 'room')
    for attempt in range(15):
        try:
            current = accept(before, expected)
            break
        except (OSError, ValueError):
            if attempt == 14:
                raise
            time.sleep(2)
    state.pop('pending')
    if current != old:
        state['previous'] = old
    state['current'] = current
    for image in (old, current):
        if image not in state['accepted']:
            state['accepted'].append(image)
    save_state(state)
    try:
        deleted = cleanup(state)
        print(json.dumps({'deployment': 'accepted', 'cleanup': 'done', 'deleted': deleted}))
        return 0
    except Exception as error:
        # Cleanup failure never rolls back an accepted service.
        print(json.dumps({'deployment': 'accepted', 'cleanup': 'deferred', 'reason': type(error).__name__}))
        return 3


def main():
    os.chdir(ROOT)
    with (ROOT / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if sys.argv[1:] == ['--cleanup']:
            print(json.dumps(cleanup(json.loads(STATE.read_text()))))
            return 0
        if sys.argv[1:]:
            raise ValueError('unknown arguments')
        return deploy()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print('room deployment/cleanup stopped: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
