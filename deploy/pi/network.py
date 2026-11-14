#!/usr/bin/env python3
"""Fixed NetworkManager operations for the local kiosk. Passwords use stdin."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.request

NETWORK_FILE = Path('/etc/round-carplay/network.json')
USER_FILE = Path('/etc/round-carplay/pi-user')
INTERFACE = 'wlan0'
PENDING_RESTART = Path('/run/round-carplay-network-restart-pending')


def run(*args, input=None, timeout=40):
    result = subprocess.run(args, input=input, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Network command failed; check network availability and password')
    return result.stdout.rstrip('\n')


def nm(*args, **kwargs):
    return run('nmcli', *args, **kwargs)


def fields(line):
    result, escaped = [''], False
    for char in line:
        if escaped:
            result[-1] += char
            escaped = False
        elif char == '\\':
            escaped = True
        elif char == ':':
            result.append('')
        else:
            result[-1] += char
    return result


def active_uuid():
    value = nm('-e', 'no', '-g', 'GENERAL.CON-UUID', 'device', 'show', INTERFACE)
    return value if value and value != '--' else None


def saved_profiles():
    profiles = []
    for line in nm('-t', '-f', 'UUID,TYPE', 'connection', 'show').splitlines():
        uuid, kind = fields(line)[:2]
        if kind != '802-11-wireless':
            continue
        ssid = nm('-e', 'no', '-g', '802-11-wireless.ssid', 'connection', 'show', 'uuid', uuid)
        timestamp = nm('-g', 'connection.timestamp', 'connection', 'show', 'uuid', uuid)
        profiles.append({'uuid': uuid, 'ssid': ssid, 'timestamp': int(timestamp or 0)})
    return sorted(profiles, key=lambda item: item['timestamp'], reverse=True)


def addresses():
    devices = json.loads(run('ip', '-j', '-4', 'address', 'show'))
    return [{'interface': d['ifname'], 'address': a['local']} for d in devices
            for a in d.get('addr_info', []) if a.get('scope') == 'global']


def snapshot(scan=True):
    if scan:
        try:
            nm('--wait', '10', 'device', 'wifi', 'rescan', 'ifname', INTERFACE, timeout=15)
        except (RuntimeError, subprocess.TimeoutExpired):
            pass  # A scan must never disconnect a working connection.
    saved = {p['ssid'] for p in saved_profiles()}
    networks = {}
    output = nm('-t', '-e', 'yes', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list',
                'ifname', INTERFACE, '--rescan', 'no')
    for line in output.splitlines():
        if not line:
            continue
        used, ssid, signal, security = fields(line)
        if not ssid:
            continue
        item = {'ssid': ssid, 'signal': int(signal or 0), 'security': '' if security == '--' else security,
                'connected': used == '*', 'saved': ssid in saved}
        previous = networks.get(ssid)
        if previous is None or item['connected'] or item['signal'] > previous['signal']:
            networks[ssid] = item
    return {'available': True, 'networks': sorted(networks.values(), key=lambda n: (not n['connected'], -n['signal'])),
            'ipAddresses': addresses()}


def carplay_active():
    # During boot the phone can be streaming before the status API is ready.
    # Only an explicit idle response permits the recovery timer to restart it.
    try:
        with urllib.request.urlopen('https://127.0.0.1:8080/api/status', timeout=2,
                                    context=ssl._create_unverified_context()) as response:
            return json.load(response).get('sessionActive') is not False
    except (OSError, ValueError, AttributeError):
        return True


def sync_network(restart=True):
    uuid = active_uuid()
    if not uuid:
        return False
    ssid = nm('-e', 'no', '-g', '802-11-wireless.ssid', 'connection', 'show', 'uuid', uuid)
    mode = nm('-g', '802-11-wireless.mode', 'connection', 'show', 'uuid', uuid)
    if mode != 'infrastructure':
        return False
    try:
        password = nm('-e', 'no', '--show-secrets', '-g', '802-11-wireless-security.psk',
                      'connection', 'show', 'uuid', uuid)
    except RuntimeError:
        password = ''  # Open networks have no security setting.
    if password == '--':
        password = ''
    properties = nm('-g', '802-11-wireless.powersave,connection.autoconnect,connection.autoconnect-retries',
                    'connection', 'show', 'uuid', uuid).splitlines()
    if [value.split(' ')[0] for value in properties] != ['2', 'yes', '0']:
        nm('connection', 'modify', 'uuid', uuid, '802-11-wireless.powersave', '2',
           'connection.autoconnect', 'yes', 'connection.autoconnect-retries', '0')
    try:
        run('iw', 'dev', INTERFACE, 'set', 'power_save', 'off', timeout=5)
    except (RuntimeError, subprocess.TimeoutExpired):
        pass
    ips = [a['address'] for a in addresses() if a['interface'] == INTERFACE]
    if not ips:
        raise RuntimeError('Wi-Fi has no IPv4 address yet')
    data = {'ssid': ssid, 'password': password, 'address': ips[0]}
    old = json.loads(NETWORK_FILE.read_text()) if NETWORK_FILE.exists() else None
    changed = data != old
    if changed:
        account = pwd.getpwnam(USER_FILE.read_text().strip())
        # Only a fixed root-owned directory is written by this privileged helper.
        fd, temporary = tempfile.mkstemp(dir=NETWORK_FILE.parent, prefix='.network-')
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream)
        os.chmod(temporary, 0o640)
        os.chown(temporary, 0, account.pw_gid)
        os.replace(temporary, NETWORK_FILE)
        if restart:
            PENDING_RESTART.touch(mode=0o600, exist_ok=True)
    # The recovery timer also runs during active CarPlay. Restarting PlayPort
    # here kills its AirPlay streams even if only Wi-Fi metadata changed.
    # Keep the pending marker and let the next timer tick restart when idle.
    if restart and PENDING_RESTART.exists() and not carplay_active():
        run('systemctl', '--no-block', 'try-restart', 'round-carplay-playport.service', timeout=10)
        PENDING_RESTART.unlink(missing_ok=True)
    return changed


def connect(request):
    ssid, password = request.get('ssid'), request.get('password', '')
    if not isinstance(ssid, str) or not 1 <= len(ssid.encode()) <= 32 or any(c in ssid for c in '\0\r\n'):
        raise ValueError('Enter a Wi-Fi name of 1–32 bytes')
    if not isinstance(password, str) or len(password.encode()) > 128 or any(c in password for c in '\0\r\n'):
        raise ValueError('Invalid Wi-Fi password')
    previous = active_uuid()
    saved = next((p for p in saved_profiles() if p['ssid'] == ssid), None)
    run('systemctl', 'stop', 'round-carplay-playport.service', timeout=25)
    created = None
    try:
        if saved and not password:
            nm('--wait', '30', 'connection', 'up', 'uuid', saved['uuid'], 'ifname', INTERFACE)
        else:
            # NetworkManager's secret agent receives the password on stdin,
            # never through command arguments or the renderer's saved settings.
            name = 'RoundCarPlay-' + hashlib.sha256(ssid.encode()).hexdigest()[:12]
            name += '-' + str(time.time_ns())
            nm('connection', 'add', 'type', 'wifi', 'ifname', INTERFACE, 'con-name', name,
               'ssid', ssid, 'connection.autoconnect', 'no')
            created = nm('-g', 'connection.uuid', 'connection', 'show', 'id', name)
            if password:
                nm('connection', 'modify', 'uuid', created, 'wifi-sec.key-mgmt', 'wpa-psk')
            nm('--ask', '--wait', '30', 'connection', 'up', 'uuid', created, 'ifname', INTERFACE,
               input=password + '\n' if password else None)
        current = active_uuid()
        if not current:
            raise RuntimeError('The network did not connect')
        nm('connection', 'modify', 'uuid', current, 'connection.autoconnect-priority', '100')
        sync_network(restart=False)
        return {'ok': True, 'message': f'Connected to {ssid}. CarPlay is reconnecting.', 'ipAddresses': addresses()}
    except (RuntimeError, subprocess.TimeoutExpired):
        restored = False
        if previous:
            try:
                nm('--wait', '20', 'connection', 'up', 'uuid', previous, 'ifname', INTERFACE, timeout=25)
                sync_network(restart=False)
                restored = True
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
        if created:
            try:
                nm('connection', 'delete', 'uuid', created)
            except RuntimeError:
                pass
        return {'ok': False, 'message': 'Could not join the network. ' + (
            'Restored the previous connection.' if restored else 'Check the network name and password, then retry.'),
            'ipAddresses': addresses()}
    finally:
        run('systemctl', '--no-block', 'start', 'round-carplay-playport.service', timeout=10)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or sys.argv[1] not in ('scan', 'connect', 'sync', 'recover'):
        raise SystemExit('Use the installed privileged network helper')
    command = sys.argv[1]
    if command == 'scan':
        print(json.dumps(snapshot()))
        return
    with open('/run/lock/round-carplay-network.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if command == 'connect':
            request = json.loads(sys.stdin.read(4097))
            print(json.dumps(connect(request)))
        else:
            if command == 'recover' and not active_uuid():
                nm('--wait', '20', 'device', 'connect', INTERFACE, timeout=25)
            sync_network()


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
