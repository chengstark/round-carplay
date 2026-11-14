import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('network', Path(__file__).with_name('network.py'))
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)


class NetworkRestartTests(unittest.TestCase):
    def test_recovery_defers_restart_until_carplay_session_ends(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            network_file = root / 'network.json'
            pending = root / 'pending'
            user_file = root / 'pi-user'
            user_file.write_text('pi')
            network_file.write_text(json.dumps({
                'ssid': 'test-network', 'password': 'test-password', 'address': '192.0.2.20',
            }))

            def nm(*args, **_kwargs):
                values = {
                    '802-11-wireless.ssid': 'test-network',
                    '802-11-wireless.mode': 'infrastructure',
                    '802-11-wireless-security.psk': 'test-password',
                    '802-11-wireless.powersave,connection.autoconnect,connection.autoconnect-retries': '2\nyes\n0',
                }
                return next(values[arg] for arg in args if arg in values)

            commands = []
            def run(*args, **_kwargs):
                commands.append(args)
                return ''

            with patch.multiple(network, NETWORK_FILE=network_file, PENDING_RESTART=pending, USER_FILE=user_file), \
                 patch.object(network, 'active_uuid', return_value='test-uuid'), \
                 patch.object(network, 'nm', side_effect=nm), \
                 patch.object(network, 'addresses', return_value=[{'interface': 'wlan0', 'address': '192.0.2.63'}]), \
                 patch.object(network, 'run', side_effect=run), \
                 patch.object(network, 'carplay_active', side_effect=[True, False]), \
                 patch.object(network.pwd, 'getpwnam', return_value=SimpleNamespace(pw_gid=1000)), \
                 patch.object(network.os, 'chown'):
                self.assertTrue(network.sync_network())
                self.assertTrue(pending.exists())
                self.assertFalse(any(c[0] == 'systemctl' for c in commands))
                self.assertFalse(network.sync_network())
                self.assertFalse(pending.exists())
                self.assertEqual([c for c in commands if c[0] == 'systemctl'], [
                    ('systemctl', '--no-block', 'try-restart', 'round-carplay-playport.service'),
                ])


if __name__ == '__main__':
    unittest.main()
