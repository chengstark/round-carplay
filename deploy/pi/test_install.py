import unittest
from pathlib import Path


INSTALLER = Path(__file__).with_name("install.sh").read_text()
KIOSK_UNIT = INSTALLER.split(
    "sudo tee /etc/systemd/system/round-carplay-browser-kiosk.service >/dev/null <<EOF\n",
    1,
)[1].split("\nEOF", 1)[0]


class KioskUnitTests(unittest.TestCase):
    def test_uses_logind_seat_backend(self):
        self.assertIn('Environment="LIBSEAT_BACKEND=logind"', KIOSK_UNIT)

    def test_restart_cannot_force_user_off_another_virtual_terminal(self):
        self.assertNotIn("chvt", KIOSK_UNIT)
        self.assertIn("TTYPath=/dev/tty1", KIOSK_UNIT)
        self.assertIn("sudo systemctl enable getty@tty2.service", INSTALLER)


if __name__ == "__main__":
    unittest.main()
