import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('phone', Path(__file__).with_name('phone.py'))
phone = importlib.util.module_from_spec(spec)
spec.loader.exec_module(phone)


class EndLoop(Exception):
    pass


class PhoneTests(unittest.TestCase):
    def exercise(self, bonded, requested=False, connected=False, reported_pair=False, held=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / 'settings.json'
            config.write_text(json.dumps({'phone': 'AA:BB:CC:DD:EE:FF'}))
            state = root / 'state/phone.json'
            request = root / 'request'
            hold = root / 'hold'
            if held:
                hold.touch()
            if requested:
                request.touch()
            process = MagicMock()
            process.__enter__.return_value = process
            process.stdout = iter(['confirm this code on the iPhone: 001234\n'] +
                                  (['paired with AA:BB:CC:DD:EE:FF\n'] if reported_pair else []))
            process.wait.return_value = 1
            paired = subprocess.CompletedProcess([], 0, 'AA:BB:CC:DD:EE:FF iPhone' if bonded else '', '')
            with patch.multiple(phone, ROOT=root, STATE=state, CONFIG=config, REQUEST=request, HOLD=hold), \
                 patch.object(phone.subprocess, 'run', return_value=paired), \
                 patch.object(phone.subprocess, 'Popen', return_value=process) as start, \
                 patch.object(phone, 'carplay_connected', return_value=connected), \
                 patch.object(phone.time, 'sleep', side_effect=EndLoop), \
                 patch.object(phone, 'status') as status:
                with self.assertRaises(EndLoop):
                    phone.main()
                if not requested:
                    start.assert_not_called()
                    self.assertEqual(hold.exists(), held, 'Startup must preserve a user-requested manual handoff')
                    self.assertEqual(status.call_args.args[0], ('enrolling' if held else 'paired') if bonded else 'idle')
                    if bonded:
                        self.assertEqual(status.call_args.args[1], 'CarPlay connected.' if connected else
                                         'Bluetooth saved on the Pi. Tap Finish pairing, then select PlayPort on your iPhone.' if held else
                                         'Bluetooth pairing saved. Waiting for CarPlay connection.')
                elif bonded and not held:
                    start.assert_not_called()
                    self.assertFalse(request.exists())
                    self.assertFalse(hold.exists())
                    self.assertTrue(any(call.args[0] == 'connecting' for call in status.call_args_list))
                else:
                    self.assertEqual(start.call_count, 1, 'A failure must wait for another press')
                    self.assertEqual(start.call_args.args[0][-2:], ['--pair-window', 'AA:BB:CC:DD:EE:FF'])
                    self.assertEqual(start.call_args.kwargs['env']['PLAYPORT_OUTBOUND_HOLD_FILE'], str(hold))
                    self.assertTrue(any(call.kwargs.get('code') == '001234' for call in status.call_args_list))
                    if reported_pair:
                        enrollment = next(call for call in status.call_args_list
                                          if call.args[1].startswith('Bluetooth paired.'))
                        self.assertEqual(enrollment.args[0], 'pairing', 'Keep the button disabled during enrollment')
                        self.assertNotIn('code', enrollment.kwargs, 'Clear the already-approved code')
                    self.assertFalse(request.exists())
                    self.assertTrue(hold.exists(),
                                    'A new bond must wait for the phone to initiate the first iAP connection')

    def test_saved_bond_is_reused_without_pairing(self):
        self.exercise(True)

    def test_missing_bond_waits_for_button(self):
        self.exercise(False)

    def test_live_carplay_is_reported_without_repairing(self):
        self.exercise(True, connected=True)

    def test_button_initiates_one_pair_attempt_and_exposes_code(self):
        self.exercise(False, requested=True)

    def test_connect_button_keeps_the_existing_bond(self):
        self.exercise(True, requested=True)

    def test_finish_pairing_reopens_target_window_without_deleting_bond(self):
        self.exercise(True, requested=True, held=True)

    def test_bond_success_keeps_enrollment_busy_and_clears_approved_code(self):
        self.exercise(False, requested=True, reported_pair=True)

    def test_manual_handoff_keeps_saved_bond_and_waits_for_user(self):
        self.exercise(True, held=True)

    def test_saved_connect_stops_waiting_on_live_carplay(self):
        with tempfile.TemporaryDirectory() as directory:
            hold = Path(directory) / 'hold'
            hold.touch()
            with patch.object(phone, 'HOLD', hold), patch.object(phone, 'status') as status, \
                 patch.object(phone, 'carplay_connected', side_effect=[False, True]), \
                 patch.object(phone.time, 'sleep') as sleep:
                self.assertTrue(phone.connect_saved())
                self.assertFalse(hold.exists())
                self.assertEqual(status.call_args.args[0], 'connecting')
                sleep.assert_called_once_with(1)

    def test_saved_connect_has_a_bounded_wait(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(phone, 'HOLD', Path(directory) / 'hold'), patch.object(phone, 'status'), \
                 patch.object(phone.time, 'monotonic', side_effect=[0, 31]), \
                 patch.object(phone.time, 'sleep') as sleep:
                self.assertFalse(phone.connect_saved())
                sleep.assert_not_called()

    def test_old_numeric_code_clears_without_claiming_carplay(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'phone.json'
            with patch.object(phone, 'STATE', state):
                phone.status('pairing', 'Confirm this code on your iPhone', code='437735')
                phone.clear_stale_code('437735')
                current = json.loads(state.read_text())
                self.assertEqual(current['state'], 'pairing')
                self.assertNotIn('code', current)
                self.assertIn('Waiting', current['message'])
