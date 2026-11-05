import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('receiver', Path(__file__).with_name('receive-image.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
d = r.deployment


def fixture():
    config, layer = b'{"fixture":true}', b'layer bytes'
    blobs = {hashlib.sha256(value).hexdigest(): value for value in (config, layer)}
    descriptor = lambda value: {'digest': 'sha256:' + hashlib.sha256(value).hexdigest(), 'size': len(value)}
    manifest = json.dumps({'config': descriptor(config), 'layers': [descriptor(layer)]}).encode()
    blobs[hashlib.sha256(manifest).hexdigest()] = manifest
    # Include an index, as Docker/buildx exports can have a manifest-list image ID.
    index_blob = json.dumps({'manifests': [descriptor(manifest)]}).encode()
    blobs[hashlib.sha256(index_blob).hexdigest()] = index_blob
    image = {'id': descriptor(index_blob)['digest'], 'ref': 'peertable-room:fixture'}
    index = {'manifests': [{**descriptor(index_blob), 'annotations': {'io.containerd.image.name': 'docker.io/library/' + image['ref']}}]}
    files = {'index.json': json.dumps(index).encode(), 'manifest.json': json.dumps([{'Config': 'blobs/sha256/'+hashlib.sha256(config).hexdigest(), 'Layers': ['blobs/sha256/'+hashlib.sha256(layer).hexdigest()], 'RepoTags': [image['ref']]}]).encode(), **{'blobs/sha256/'+key: value for key, value in blobs.items()}}
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w') as archive:
        for name, value in files.items():
            member = tarfile.TarInfo(name); member.size = len(value)
            archive.addfile(member, io.BytesIO(value))
    return image, raw.getvalue()


class Receive(unittest.TestCase):
    def test_receive_reuse_stale_stage_and_unknown_preservation(self):
        image, raw = fixture()
        with tempfile.TemporaryDirectory() as td, patch.object(d, 'BACKUPS', Path(td)), patch.object(d.os.path, 'ismount', return_value=True):
            stage = Path(td)/'.receive-image'; stage.mkdir(); (stage/'partial').write_bytes(b'partial')
            other = Path(td)/'unknown.tar'; other.write_bytes(b'keep')
            self.assertFalse(r.receive(image, io.BytesIO(raw))['reused'])
            self.assertTrue(r.receive(image, io.BytesIO(raw))['reused'])
            self.assertEqual(other.read_bytes(), b'keep')
            self.assertFalse(stage.exists())
            self.assertEqual(len(list(Path(td).glob('*.tar'))), 2)

    def test_interruption_corruption_wrong_identity_leave_no_stage_or_archive(self):
        image, raw = fixture()
        class Broken(io.BytesIO):
            def read(self, size): raise OSError('input interrupted')
        with tempfile.TemporaryDirectory() as td, patch.object(d, 'BACKUPS', Path(td)), patch.object(d.os.path, 'ismount', return_value=True):
            for candidate, stream in [(image, Broken(raw)), (image, io.BytesIO(raw.replace(b'layer bytes', b'bad!! bytes'))), ({**image, 'id': 'sha256:'+'0'*64}, io.BytesIO(raw)), ({**image, 'ref': 'peertable-room:wrong'}, io.BytesIO(raw))]:
                with self.assertRaises((OSError, ValueError)):
                    r.receive(candidate, stream)
                self.assertEqual(list(Path(td).iterdir()), [])

    def test_unmounted_qnap_does_not_create_fallback(self):
        image, raw = fixture()
        with tempfile.TemporaryDirectory() as td, patch.object(d, 'BACKUPS', Path(td)/'images'), patch.object(d.os.path, 'ismount', return_value=False):
            with self.assertRaises(ValueError): r.receive(image, io.BytesIO(raw))
            self.assertFalse(d.BACKUPS.exists())


if __name__ == '__main__': unittest.main()
