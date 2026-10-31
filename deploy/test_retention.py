"""Retention boundaries with fake Docker; never operates on a daemon."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deployment', Path(__file__).with_name('deploy-room.py'))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


def image(n):
    return {'id': 'sha256:' + str(n) * 64, 'ref': 'peertable-room:v' + str(n)}


def metadata(n, tags=None, digests=None):
    x = image(n)
    return {'Id': x['id'], 'RepoTags': tags or [x['ref']], 'RepoDigests': digests or []}


class Retention(unittest.TestCase):
    def test_only_accepted_unreferenced_single_product_tag_is_eligible(self):
        images = [metadata(n) for n in range(1, 8)]
        images[3]['RepoTags'].append('other:release')
        images[4]['RepoDigests'] = ['other@sha256:abc']
        images[5]['RepoTags'].append('peertable-room:unfinished')
        accepted = [image(n) for n in range(1, 7)]
        containers = [{'Image': image(3)['id'], 'State': {'Running': False}}]
        self.assertEqual(d.removable(images, containers, accepted, {image(1)['id'], image(2)['id']}), [])
        self.assertEqual(d.removable(images, [], accepted, {image(1)['id'], image(2)['id']}), [image(3)])

    def test_missing_mount_and_pending_history_stop_before_docker(self):
        with patch.object(d, 'docker') as docker, patch.object(d.os.path, 'ismount', return_value=False):
            for state in ({'pending': True}, {'current': image(1), 'previous': image(2)}):
                with self.assertRaises(ValueError): d.cleanup(state)
            docker.assert_not_called()

    def test_archive_failure_prevents_all_deletions(self):
        state = {'current': image(1), 'previous': image(2), 'accepted': [image(n) for n in (1, 2, 3)]}
        live = {'Image': image(1)['id'], 'Config': {'Image': image(1)['ref']}, 'State': {'Running': True}}
        def inspect(kind, ref):
            return live if kind == 'container' else {'Id': next(x['id'] for x in state['accepted'] if x['ref'] == ref)}
        with patch.object(d.os.path, 'ismount', return_value=True), patch.object(d, 'inspect', side_effect=inspect), patch.object(d, 'inventory', side_effect=lambda kind: [metadata(n) for n in (1,2,3)] if kind == 'image' else []), patch.object(d, 'verify_archive', side_effect=ValueError('bad archive')), patch.object(d, 'docker') as docker:
            with self.assertRaises(ValueError): d.cleanup(state)
            docker.assert_not_called()

    def test_cleanup_deletes_only_named_old_tag_after_archive_checks(self):
        state = {'current': image(1), 'previous': image(2), 'accepted': [image(n) for n in (1,2,3)]}
        live = {'Image': image(1)['id'], 'Config': {'Image': image(1)['ref']}, 'State': {'Running': True}}
        def inspect(kind, ref):
            return live if kind == 'container' else {'Id': next(x['id'] for x in state['accepted'] if x['ref'] == ref)}
        with tempfile.TemporaryDirectory() as td, patch.object(d, 'BACKUPS', Path(td)/'images'), patch.object(d.os.path, 'ismount', return_value=True), patch.object(d, 'inspect', side_effect=inspect), patch.object(d, 'inventory', side_effect=lambda kind: [metadata(n) for n in (1,2,3)] if kind == 'image' else []), patch.object(d, 'verify_archive') as verify, patch.object(d, 'docker') as docker:
            self.assertEqual(d.cleanup(state), [image(3)])
            self.assertEqual(verify.call_count, 3)
            docker.assert_called_once_with('image', 'rm', 'peertable-room:v3')

    def test_archive_checksum_and_config_binding(self):
        import hashlib, io, tarfile
        config = b'{"fixture": true}'
        image_id = 'sha256:' + hashlib.sha256(config).hexdigest()
        ref = {'id': image_id, 'ref': 'peertable-room:fixture'}
        with tempfile.TemporaryDirectory() as td, patch.object(d, 'BACKUPS', Path(td)):
            archive = Path(td)/(image_id[7:]+'.tar')
            with tarfile.open(archive, 'w') as bundle:
                values = {'manifest.json': json.dumps([{'Config': 'config.json', 'RepoTags': [ref['ref']], 'Layers': []}]).encode(), 'config.json': config}
                for name, value in values.items():
                    info = tarfile.TarInfo(name); info.size = len(value)
                    bundle.addfile(info, io.BytesIO(value))
            checksum = archive.with_suffix('.tar.sha256')
            checksum.write_text(hashlib.sha256(archive.read_bytes()).hexdigest())
            d.verify_archive(ref)
            with self.assertRaises(ValueError): d.verify_archive({**ref, 'ref': 'peertable-room:wrong'})
            checksum.write_text('0'*64)
            with self.assertRaises(ValueError): d.verify_archive(ref)

    def test_deploy_connects_acceptance_to_cleanup_and_preserves_success_on_cleanup_failure(self):
        old = {'Image': image(2)['id'], 'Config': {'Image': image(2)['ref']}}
        with tempfile.TemporaryDirectory() as td, patch.object(d, 'STATE', Path(td)/'state.json'), patch.object(d, 'inspect', side_effect=lambda kind, ref: old if kind == 'container' else {'Id': image(1)['id']}), patch.object(d, 'image_ref', return_value=image(2)), patch.object(d, 'histories', return_value={}), patch.object(d, 'docker', side_effect=[image(1)['ref'], '']) as docker, patch.object(d, 'accept', return_value=image(1)) as accept, patch.object(d, 'cleanup', side_effect=ValueError('no QNAP')) as cleanup:
            self.assertEqual(d.deploy(), 3)
            accept.assert_called_once()
            cleanup.assert_called_once()
            state = json.loads(d.STATE.read_text())
            self.assertEqual(state['previous'], image(2))
            self.assertNotIn('pending', state)
            self.assertEqual(docker.call_count, 2)

    def test_failed_acceptance_never_calls_cleanup(self):
        old = {'Image': image(2)['id'], 'Config': {'Image': image(2)['ref']}}
        with tempfile.TemporaryDirectory() as td, patch.object(d, 'STATE', Path(td)/'state.json'), patch.object(d, 'inspect', side_effect=lambda kind, ref: old if kind == 'container' else {'Id': image(1)['id']}), patch.object(d, 'image_ref', return_value=image(2)), patch.object(d, 'histories', return_value={}), patch.object(d, 'docker', side_effect=[image(1)['ref'], '']), patch.object(d, 'accept', side_effect=ValueError('failed')), patch.object(d.time, 'sleep'), patch.object(d, 'cleanup') as cleanup:
            with self.assertRaises(ValueError): d.deploy()
            cleanup.assert_not_called()
            self.assertIn('pending', json.loads(d.STATE.read_text()))


if __name__ == '__main__': unittest.main()
