"""Host-side tests; no Bluetooth, network or brightness hardware is contacted."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('launch', Path(__file__).with_name('launch.py'))
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)


class LaunchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.root = root / 'install'
        self.config = root / 'settings/settings.json'
        self.config.parent.mkdir()
        self.config.write_text(json.dumps({'ssid': 'network with spaces', 'password': 'private-test-secret',
                                          'phone': '00:11:22:33:44:55', 'token': 't' * 64}))
        for name, value in [('ROOT', self.root), ('CONFIG', self.config),
                            ('BLUETOOTH_AUDIO_CONFIG', root / 'wireplumber/no-audio.conf')]:
            mock = patch.object(launch, name, value)
            mock.start()
            self.addCleanup(mock.stop)

    def test_host_keeps_current_stream_geometry_and_private_configuration(self):
        (self.root / 'current/playport').mkdir(parents=True)
        with patch('sys.argv', ['launch.py', 'host']), patch.object(launch, 'lan_address', return_value='192.168.2.9'), \
             patch.object(launch, 'wifi_channel', return_value='6'), patch.object(launch.os, 'chdir'), \
             patch.object(launch.os, 'execvpe') as execute, patch.object(launch.subprocess, 'Popen'), \
             patch.object(launch, 'configure_display_only_audio'), patch.dict(os.environ, {}, clear=True):
            launch.main()
        command, argv, env = execute.call_args.args
        self.assertTrue(command.endswith('/playport/bin/server'))
        self.assertEqual(argv[argv.index('--diameter') + 1], '512')
        self.assertEqual(argv[argv.index('--main-render-scale') + 1], '200')
        self.assertEqual(argv[argv.index('--bind') + 1], '192.168.2.9')
        self.assertIn('--no-audio', argv)
        self.assertEqual(env['PLAYPORT_WIFI_PASSPHRASE'], 'private-test-secret')
        self.assertEqual(env['PLAYPORT_OUTBOUND_HOLD_FILE'], str(self.root / 'state/phone-connect-hold'))
        self.assertNotIn('private-test-secret', argv)
        self.assertIn('-Xmx256m', env['JAVA_OPTS'])
        state = self.root / 'state/playport/config.json'
        self.assertEqual(state.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(state.read_text())['wifiPassphrase'], 'private-test-secret')

    def test_bluetooth_audio_policy_is_applied_once_without_restarting_bluez(self):
        with patch.object(launch.subprocess, 'run') as run:
            run.return_value.returncode = 0
            launch.configure_display_only_audio()
            launch.configure_display_only_audio()
        self.assertIn('monitor.bluez = disabled', launch.BLUETOOTH_AUDIO_CONFIG.read_text())
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0], ['systemctl', '--user', 'try-restart', 'wireplumber.service'])

    def test_backend_uses_local_authenticated_bridge_and_bundle_update_path(self):
        with patch('sys.argv', ['launch.py', 'backend']), patch.object(launch.os, 'execvpe') as execute:
            launch.main()
        command, argv, env = execute.call_args.args
        self.assertEqual(command, '/usr/bin/node')
        self.assertTrue(argv[1].endswith('/dashboard/backend.cjs'))
        self.assertEqual(env['ROUND_CARPLAY_DEPLOYMENT'], 'playport-pi')
        self.assertEqual(env['PLAYPORT_WS_URL'], 'wss://127.0.0.1:8080/ws?token=' + 't' * 64)
        self.assertNotIn('private-test-secret', str(argv))

    def test_configure_preserves_access_token_and_does_not_echo_password(self):
        with patch('builtins.input', side_effect=['', '']), \
             patch.object(launch.getpass, 'getpass', return_value=''), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            launch.configure()
        data = json.loads(self.config.read_text())
        self.assertEqual(data['token'], 't' * 64)
        self.assertEqual(data['password'], 'private-test-secret')
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('private-test-secret', output.getvalue())

    def test_kiosk_waits_for_health_and_runs_browser_without_forced_gpu_flags(self):
        with patch('sys.argv', ['launch.py', 'kiosk']), \
             patch('urllib.request.urlopen') as health, patch.object(launch.os, 'execvpe') as execute:
            health.return_value.__enter__.return_value.read.return_value = b'{"playportConfigured": true}'
            launch.main()
        command, argv, _env = execute.call_args.args
        self.assertEqual(command, '/usr/bin/cage')
        self.assertIn('-s', argv)
        self.assertIn('/usr/bin/chromium', argv)
        self.assertIn('--app=http://127.0.0.1:4000/', argv)
        self.assertNotIn('--no-sandbox', argv)
        self.assertNotIn('--ignore-gpu-blocklist', argv)


if __name__ == '__main__':
    unittest.main()
