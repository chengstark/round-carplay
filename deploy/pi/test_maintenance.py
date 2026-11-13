import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


network, update = load('network'), load('update')


class NetworkTests(unittest.TestCase):
    def test_nmcli_escaping(self):
        self.assertEqual(network.fields(r'*:A\:B\\C:80:WPA2'), ['*', 'A:B\\C', '80', 'WPA2'])

    def test_saved_network_reconnects_without_a_password_and_restarts_host(self):
        with patch.object(network, 'active_uuid', return_value='old'), \
             patch.object(network, 'saved_profiles', return_value=[{'ssid': 'saved', 'uuid': 'saved-id'}]), \
             patch.object(network, 'nm') as nm, patch.object(network, 'run') as run, \
             patch.object(network, 'sync_network') as sync, patch.object(network, 'addresses', return_value=[]):
            self.assertTrue(network.connect({'ssid': 'saved'})['ok'])
        nm.assert_any_call('--wait', '30', 'connection', 'up', 'uuid', 'saved-id', 'ifname', 'wlan0')
        sync.assert_called_once_with(restart=False)
        self.assertEqual(run.call_args.args[:3], ('systemctl', '--no-block', 'start'))

    def test_failed_join_restores_previous_profile_and_never_places_password_in_arguments(self):
        calls = []
        def nm(*args, **kwargs):
            calls.append((args, kwargs))
            if args[:3] == ('-g', 'connection.uuid', 'connection'):
                return 'new-id'
            if '--ask' in args:
                raise RuntimeError('failed')
            return ''
        with patch.object(network, 'active_uuid', return_value='old-id'), \
             patch.object(network, 'saved_profiles', return_value=[]), patch.object(network, 'nm', side_effect=nm), \
             patch.object(network, 'run'), patch.object(network, 'sync_network'), \
             patch.object(network, 'addresses', return_value=[]):
            result = network.connect({'ssid': 'new network', 'password': 'private-test-password'})
        self.assertFalse(result['ok'])
        self.assertIn('Restored', result['message'])
        self.assertTrue(any(a[:6] == ('--wait', '20', 'connection', 'up', 'uuid', 'old-id') for a, _ in calls))
        self.assertTrue(all('private-test-password' not in a for a, _ in calls))
        self.assertTrue(any(k.get('input') == 'private-test-password\n' for _, k in calls))

    def test_invalid_credentials_do_not_change_network_state(self):
        with patch.object(network, 'run') as run:
            for request in [{'ssid': ''}, {'ssid': 'x' * 33}, {'ssid': 'abc', 'password': 'x\ny'}]:
                with self.assertRaises(ValueError):
                    network.connect(request)
            run.assert_not_called()


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def archive(self, name, kind=tarfile.REGTYPE):
        archive = self.root / 'test.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            entry = tarfile.TarInfo(name)
            entry.type = kind
            entry.linkname = '/etc/passwd' if kind == tarfile.SYMTYPE else ''
            if kind == tarfile.REGTYPE:
                entry.size = 4
                tar.addfile(entry, io.BytesIO(b'test'))
            else:
                tar.addfile(entry)
        return archive

    def test_extraction_rejects_traversal_links_and_private_files(self):
        destination = self.root / 'extract'
        destination.mkdir()
        for name, kind in [('round-carplay-update/../../etc/a', tarfile.REGTYPE),
                           ('round-carplay-update/dashboard/link', tarfile.SYMTYPE),
                           ('round-carplay-update/private/identity', tarfile.REGTYPE)]:
            with self.assertRaises(ValueError):
                update.extract(self.archive(name, kind), destination)

    def releases(self):
        previous = self.root / 'releases/old'
        candidate = self.root / 'releases/new'
        previous.mkdir(parents=True)
        candidate.mkdir()
        (self.root / 'current').symlink_to(previous)
        (self.root / 'pending-update.json').write_text(json.dumps({'candidate': str(candidate), 'version': 'v3-new', 'previous': str(previous)}))
        return previous, candidate

    def test_failed_activation_restores_previous_release_and_preserves_pairing(self):
        previous, _candidate = self.releases()
        (self.root / 'private').mkdir()
        (self.root / 'private/identity').write_text('keep-me')
        def systemctl(*args):
            if args[0] == 'start' and len(args) == 3:
                raise RuntimeError('new backend failed')
        with patch.object(update, 'as_user', return_value=contextlib.nullcontext()), \
             patch.object(update, 'systemctl', side_effect=systemctl), patch.object(update.time, 'sleep'):
            with self.assertRaises(RuntimeError):
                update.apply(self.root, None)
        self.assertEqual((self.root / 'current').resolve(), previous.resolve())
        self.assertEqual((self.root / 'private/identity').read_text(), 'keep-me')
        self.assertEqual(json.loads((self.root / 'update-result.json').read_text())['failedVersion'], 'v3-new')

    def test_interrupted_update_recovers_before_services_start(self):
        previous, candidate = self.releases()
        update.replace_link(self.root / 'current', candidate)
        with patch.object(update, 'as_user', return_value=contextlib.nullcontext()):
            update.recover(self.root, None)
        self.assertEqual((self.root / 'current').resolve(), previous.resolve())
        self.assertFalse((self.root / 'pending-update.json').exists())

    def test_successful_activation_requires_new_version_and_host_health(self):
        previous, candidate = self.releases()
        with patch.object(update, 'as_user', return_value=contextlib.nullcontext()), \
             patch.object(update, 'systemctl') as services, patch.object(update.time, 'sleep'), \
             patch.object(update, 'backend_health', return_value=True) as health, \
             patch.object(update.urllib.request, 'urlopen') as host:
            host.return_value.__enter__.return_value.read.return_value = b'{"deviceName":"PlayPort"}'
            update.apply(self.root, None)
        health.assert_called_with(4000, 'v3-new')
        self.assertEqual((self.root / 'current').resolve(), candidate.resolve())
        self.assertEqual((self.root / 'previous').resolve(), previous.resolve())
        self.assertEqual(json.loads((self.root / 'update-result.json').read_text())['state'], 'success')
        self.assertFalse((self.root / 'pending-update.json').exists())

    def test_last_moment_phone_connection_postpones_automatic_activation(self):
        previous, candidate = self.releases()
        pending = self.root / 'pending-update.json'
        data = json.loads(pending.read_text())
        data['automatic'] = True
        pending.write_text(json.dumps(data))
        with patch.object(update, 'as_user', return_value=contextlib.nullcontext()), \
             patch.object(update, 'systemctl') as services, \
             patch.object(update.urllib.request, 'urlopen') as host:
            host.return_value.__enter__.return_value.read.return_value = b'{"sessionActive":true}'
            update.apply(self.root, None)
        services.assert_not_called()
        self.assertEqual((self.root / 'current').resolve(), previous.resolve())
        self.assertFalse(candidate.exists())
        self.assertEqual(json.loads((self.root / 'update-result.json').read_text())['state'], 'idle')

    def test_release_path_cannot_point_outside_owned_releases(self):
        with self.assertRaises(ValueError):
            update.release_path(self.root, str(self.root))


if __name__ == '__main__':
    unittest.main()
