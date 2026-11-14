#!/usr/bin/env python3
"""Run upstream PR #4 pairing only after a dashboard button request."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
import ssl
import urllib.request

ROOT = Path.home() / '.local/share/round-carplay-pi'
STATE = ROOT / 'state/phone.json'
REQUEST = ROOT / 'state/phone-pair-request'
HOLD = ROOT / 'state/phone-connect-hold'
CONFIG = Path.home() / '.config/round-carplay-deploy/settings.json'


def status(state, message, **extra):
    temporary = STATE.with_suffix('.tmp')
    temporary.write_text(json.dumps(dict(state=state, message=message, **extra)))
    temporary.chmod(0o600)
    temporary.replace(STATE)


def carplay_connected():
    try:
        with urllib.request.urlopen('https://127.0.0.1:8080/api/status', timeout=1,
                                    context=ssl._create_unverified_context()) as response:
            return json.load(response).get('sessionActive') is True
    except (OSError, ValueError, AttributeError):
        return False


def clear_stale_code(code):
    try:
        current = json.loads(STATE.read_text())
        if current.get('state') == 'pairing' and current.get('code') == code:
            status('pairing', 'Waiting for the iPhone to finish pairing and open CarPlay.')
    except (OSError, ValueError):
        pass


def connect_saved():
    HOLD.unlink(missing_ok=True)
    status('connecting', 'Connecting to CarPlay using the saved Bluetooth pairing…')
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if carplay_connected():
            return True
        time.sleep(1)
    return False


def main():
    STATE.parent.mkdir(parents=True, exist_ok=True)
    with (STATE.parent / 'phone.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        run()


def run():
    last_failure = False
    last_connection_failed = False
    while True:
        try:
            address = json.loads(CONFIG.read_text())['phone'].upper()
            if not re.fullmatch(r'(?:[0-9A-F]{2}:){5}[0-9A-F]{2}', address):
                raise ValueError('Invalid configured phone address')
            bridge = ROOT / 'current/playport/linux/bt-bridge/bt-bridge'
            paired = subprocess.run([str(bridge), '--list'], capture_output=True, text=True, timeout=15)
            if paired.returncode:
                raise RuntimeError(paired.stderr.strip())
            bonded = address in paired.stdout
            if not REQUEST.exists():
                if bonded:
                    active = carplay_connected()
                    if active:
                        last_connection_failed = False
                        message = 'CarPlay connected.'
                    elif HOLD.exists():
                        message = ('Pairing window ended before CarPlay connected. Tap Finish pairing to retry.'
                                   if last_failure else
                                   'Bluetooth saved on the Pi. Tap Finish pairing, then select PlayPort on your iPhone.')
                    elif last_connection_failed:
                        message = 'CarPlay did not respond. Your saved Bluetooth pairing has been kept.'
                    else:
                        message = 'Bluetooth pairing saved. Waiting for CarPlay connection.'
                    status('enrolling' if HOLD.exists() and not active else 'paired', message)
                elif last_failure:
                    status('error', 'Pairing did not complete. Open iPhone Bluetooth settings and tap Pair iPhone to try again.')
                else:
                    status('idle', 'Open iPhone Settings → Bluetooth, then tap Pair iPhone.')
                time.sleep(2)
                continue
            REQUEST.unlink()
            if bonded and not HOLD.exists():
                last_connection_failed = not connect_saved()
                time.sleep(2)
                continue
            # Initial enrollment must be initiated by the iPhone. The Pi opens
            # a target-only pairing window while its accessory listener waits.
            HOLD.touch(mode=0o600, exist_ok=True)
            last_failure = False
            status('pairing', 'On your iPhone, select PlayPort in Bluetooth settings and approve the code.')
            with subprocess.Popen([str(bridge), '--pair-window', address], stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, text=True, bufsize=1,
                                  env={**os.environ, 'PLAYPORT_OUTBOUND_HOLD_FILE': str(HOLD)}) as process:
                last = ''
                code_timer = None
                try:
                    for line in process.stdout:
                        last = line.strip()
                        print(last, flush=True)
                        code = re.search(r'confirm this code on the iPhone: (\d{6})', last)
                        if code:
                            if code_timer:
                                code_timer.cancel()
                            status('pairing', 'Confirm this code on your iPhone', code=code[1])
                            code_timer = threading.Timer(30, clear_stale_code, args=(code[1],))
                            code_timer.daemon = True
                            code_timer.start()
                        elif last.startswith('paired with '):
                            if code_timer:
                                code_timer.cancel()
                            status('pairing', 'Bluetooth paired. Waiting for the iPhone to open CarPlay.')
                    result = process.wait()
                finally:
                    if code_timer:
                        code_timer.cancel()
            last_failure = result != 0
        except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
            print(str(error), flush=True)
            status('error', 'Phone connection unavailable. Check Bluetooth on the Pi.')
            time.sleep(10)


if __name__ == '__main__':
    main()
