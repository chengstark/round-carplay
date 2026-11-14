import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('diagnose', Path(__file__).with_name('diagnose-connection.py'))
diagnose = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnose)


class ConnectionDiagnosisTests(unittest.TestCase):
    def exercise(self, current, journal):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'settings.json'
            config.write_text(json.dumps({'phone': 'AA:BB:CC:DD:EE:FF', 'ssid': 'test-network'}))

            def command(args, **_kwargs):
                if args[:2] == ['bluetoothctl', 'show']:
                    return ('Powered: yes\n'
                            f'UUID: {diagnose.IAP_ACCESSORY}\n'
                            f'UUID: {diagnose.CARPLAY_DISCOVERY}\n')
                if args[:2] == ['bluetoothctl', 'info']:
                    return 'Paired: yes\nBonded: yes\nTrusted: yes'
                if args[0] == 'journalctl':
                    return journal
                if args[0] == 'systemctl':
                    return 'active'
                if args[0] == 'hostname':
                    return '192.168.1.2'
                if args[0] == 'iwgetid':
                    return 'test-network'
                return ''

            with patch.object(diagnose, 'CONFIG', config), \
                 patch.object(diagnose, 'command', side_effect=command), \
                 patch.object(diagnose.Path, 'is_file', return_value=True), \
                 patch.object(diagnose.urllib.request, 'urlopen') as http, \
                 contextlib.redirect_stdout(io.StringIO()) as output:
                http.return_value.__enter__.return_value.read.return_value = json.dumps(current).encode()
                result = diagnose.main()
                return result, output.getvalue()

    def test_old_success_does_not_hide_current_disconnect(self):
        result, output = self.exercise({'sessionActive': False},
            'bt-bridge: RFCOMM channel open\nwireless bootstrap accepted by the iPhone\n'
            'CarPlay session active\nCarPlay session ended\n')
        self.assertEqual(result, 1)
        self.assertIn('WAIT CarPlay: no active session reported by host', output)

    def test_live_session_does_not_require_recent_bootstrap_logs(self):
        result, output = self.exercise({'sessionActive': True}, '')
        self.assertEqual(result, 0)
        self.assertIn('PASS CarPlay: session active now', output)

    def test_missing_session_flag_does_not_report_ready(self):
        result, output = self.exercise({}, 'CarPlay session active\n')
        self.assertEqual(result, 1)
        self.assertNotIn('RESULT ready', output)
