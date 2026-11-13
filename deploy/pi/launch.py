#!/usr/bin/env python3
"""Launch the current PlayPort/browser services; never invoke a build at boot."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time

ROOT = Path.home() / '.local/share/round-carplay-pi'
CONFIG = Path.home() / '.config/round-carplay-deploy/settings.json'
NETWORK_FILE = Path('/etc/round-carplay/network.json')


def load():
    return json.loads(CONFIG.read_text())


def configure():
    old = load() if CONFIG.exists() else {}
    ssid = input(f"Wi-Fi name [{old.get('ssid', '')}]: ").strip() or old.get('ssid', '')
    password = getpass.getpass('Wi-Fi password (blank keeps saved value): ') or old.get('password', '')
    phone = input(f"iPhone Bluetooth address [{old.get('phone', '')}]: ").strip() or old.get('phone', '')
    if not ssid or not re.fullmatch(r'(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}', phone):
        raise SystemExit('A Wi-Fi name and valid paired iPhone Bluetooth address are required.')
    data = {**old, 'ssid': ssid, 'password': password, 'phone': phone,
            'token': old.get('token') or secrets.token_hex(32)}
    CONFIG.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = CONFIG.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(CONFIG)
    print('Saved private configuration. Pair/trust the phone with bluetoothctl, then reboot.')


def lan_address():
    """Resolve at each start; never bake the Mac's old DHCP address into Pi."""
    for _ in range(60):
        wifi = subprocess.run(['ip', '-j', '-4', 'address', 'show', 'dev', 'wlan0'], capture_output=True, text=True)
        try:
            for info in json.loads(wifi.stdout)[0].get('addr_info', []):
                if info.get('scope') == 'global':
                    return info['local']
        except (ValueError, IndexError):
            pass
        result = subprocess.run(['ip', '-j', '-4', 'route', 'get', '1.1.1.1'], capture_output=True, text=True)
        try:
            address = json.loads(result.stdout)[0]['prefsrc']
            if not address.startswith('127.'):
                return address
        except (ValueError, KeyError, IndexError):
            pass
        time.sleep(1)
    raise SystemExit('No LAN address after 60 seconds; check network connection.')


def wifi_channel():
    result = subprocess.run(['nmcli', '-t', '-f', 'IN-USE,CHAN', 'device', 'wifi', 'list', '--rescan', 'no'],
                            capture_output=True, text=True)
    match = re.search(r'^\*:(\d+)$', result.stdout, re.MULTILINE)
    return match.group(1) if match else '0'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('service', choices=['configure', 'host', 'backend', 'kiosk'])
    args = parser.parse_args()
    if args.service == 'configure':
        configure()
        return
    data = load()
    current = ROOT / 'current'
    env = os.environ.copy()
    if args.service == 'host':
        if NETWORK_FILE.exists():
            data.update(json.loads(NETWORK_FILE.read_text()))
        os.chdir(current / 'playport')
        env['PLAYPORT_WIFI_PASSPHRASE'] = data['password']
        # Limit heap on the 1GB Pi; these are initial budgets, not Pi benchmarks.
        env.setdefault('JAVA_OPTS', '-Xms32m -Xmx256m -XX:ActiveProcessorCount=2 -XX:+UseSerialGC')
        # An old saved PlayPort config may omit its passphrase. A fresh ephemeral
        # config is written from our private settings on every start; identity,
        # pairing keys and TLS stay in the persistent state directory.
        state = ROOT / 'state/playport'
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        (state / 'config.json').write_text(json.dumps({'wifiPassphrase': data['password']}))
        (state / 'config.json').chmod(0o600)
        command = [str(current / 'playport/bin/server'), '--wireless', '--round',
                   '--diameter', '512', '--ui-scale', '100', '--main-render-scale', '200',
                   '--fps', '60', '--wifi-ssid', data['ssid'], '--bt-address', data['phone'],
                   '--wifi-channel', wifi_channel(),
                   '--bt-bridge', str(current / 'deploy/round-carplay-bt-bridge.py'),
                   '--bind', lan_address(), '--mdns', 'jmdns',
                   '--identity-dir', str(ROOT / 'private/identity'),
                   '--state-dir', str(state), '--token', data['token']]
    elif args.service == 'backend':
        env.update({'NODE_ENV': 'production', 'NODE_OPTIONS': '--max-old-space-size=128',
                    'ROUND_CARPLAY_DEPLOYMENT': 'playport-pi', 'ROUND_CARPLAY_PORT': '4000',
                    'ROUND_CARPLAY_UI_DIR': str(current / 'dashboard/ui'),
                    'ROUND_CARPLAY_DATA_DIR': str(ROOT / 'state/dashboard'),
                    'PLAYPORT_WS_URL': 'wss://127.0.0.1:8080/ws?token=' + data['token'],
                    'PLAYPORT_ALLOW_SELF_SIGNED': '1',
                    'CN5_BRIGHTNESS_PROFILE': str(ROOT / 'private/brightness.json')})
        release_file = current / 'release.json'
        if release_file.exists():
            env['ROUND_CARPLAY_VERSION'] = json.loads(release_file.read_text())['version']
        command = ['/usr/bin/node', str(current / 'dashboard/backend.cjs')]
    else:
        import urllib.request
        for _ in range(60):
            try:
                with urllib.request.urlopen('http://127.0.0.1:4000/health', timeout=1) as response:
                    if json.load(response).get('playportConfigured'):
                        break
            except (OSError, ValueError):
                pass
            time.sleep(1)
        else:
            raise SystemExit('Dashboard health check failed')
        command = ['/usr/bin/cage', '-s', '--', '/usr/bin/chromium', '--ozone-platform=wayland',
                   '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream',
                   '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
                   '--disable-notifications', '--password-store=basic',
                   '--user-data-dir=' + str(ROOT / 'state/chromium'),
                   '--kiosk', '--app=http://127.0.0.1:4000/']
    os.execvpe(command[0], command, env)


if __name__ == '__main__':
    main()
