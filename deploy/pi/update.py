#!/usr/bin/env python3
"""Stage as the kiosk user; apply/recover via a fixed root-owned service."""
import contextlib
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import ssl

USER_FILE = Path('/etc/round-carplay/pi-user')
SERVICES = ['round-carplay-playport.service', 'round-carplay-backend.service', 'round-carplay-browser-kiosk.service']


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, data):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def replace_link(path, target):
    temporary = path.with_name(path.name + '.new')
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    temporary.replace(path)


def release_path(root, value):
    path = Path(value).resolve()
    if path.parent != (root / 'releases').resolve() or not path.is_dir():
        raise ValueError('Invalid update release path')
    return path


def extract(archive, destination):
    """Never extract links, devices, private credentials, or paths outside payload."""
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        total = 0
        allowed = {'dashboard', 'playport', 'deploy', 'manifest.json', 'release.json'}
        for member in members:
            parts = Path(member.name).parts
            if not parts or parts[0] != 'round-carplay-update' or '..' in parts or Path(member.name).is_absolute():
                raise ValueError('Unsafe update archive path')
            if len(parts) > 1 and parts[1] not in allowed:
                raise ValueError('Unexpected update payload; private files are not accepted')
            if not (member.isfile() or member.isdir()):
                raise ValueError('Update archives cannot contain links or special files')
            total += member.size
            if total > 512 * 1024 * 1024:
                raise ValueError('Expanded update exceeds size limit')
        if shutil.disk_usage(destination).free < total * 2 + 64 * 1024 * 1024:
            raise ValueError('Not enough free space for a recoverable update')
        for member in members:
            relative = Path(*Path(member.name).parts[1:])
            target = destination / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as source, target.open('wb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if member.mode & 0o111 else 0o600)


def backend_health(port, version=None):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=2) as response:
            health = json.load(response)
        return health.get('runtime') == 'browser' and (version is None or health.get('version') == version)
    except (OSError, ValueError):
        return False


def stage(directory):
    if os.geteuid() == 0:
        raise ValueError('Staging must run as the normal kiosk user')
    root = Path.home() / '.local/share/round-carplay-pi'
    metadata = read_json(directory / 'release.json')
    releases = root / 'releases'
    releases.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.update-', dir=releases) as temporary:
        candidate = Path(temporary) / 'candidate'
        candidate.mkdir()
        extract(directory / 'update.tar.gz', candidate)
        for name in ['dashboard/backend.cjs', 'dashboard/ui/index.html', 'playport/bin/server',
                     'playport/linux/bt-bridge/bt-bridge', 'deploy/launch.py']:
            if not (candidate / name).is_file():
                raise ValueError('Incomplete update payload')
        bridge = (candidate / 'playport/linux/bt-bridge/bt-bridge').read_bytes()[:20]
        if len(bridge) < 20 or bridge[:6] != b'\x7fELF\x02\x01' or struct.unpack('<H', bridge[18:20])[0] != 183:
            raise ValueError('Bluetooth bridge must be a Linux ARM64 executable')
        (candidate / 'playport/bin/server').chmod(0o755)
        (candidate / 'playport/linux/bt-bridge/bt-bridge').chmod(0o755)
        write_json(candidate / 'release.json', metadata)
        # Smoke-test in an isolated data directory before changing current.
        with socket.socket() as reserve:
            reserve.bind(('127.0.0.1', 0))
            port = reserve.getsockname()[1]
        env = {**os.environ, 'ROUND_CARPLAY_PORT': str(port), 'ROUND_CARPLAY_VERSION': metadata['version'],
               'ROUND_CARPLAY_DEPLOYMENT': 'playport-pi', 'ROUND_CARPLAY_DISABLE_AUTO_UPDATE': '1',
               'ROUND_CARPLAY_UI_DIR': str(candidate / 'dashboard/ui'),
               'ROUND_CARPLAY_DATA_DIR': str(Path(temporary) / 'test-data'),
               'CN5_BRIGHTNESS_PROFILE': str(Path(temporary) / 'no-controller.json')}
        process = subprocess.Popen(['/usr/bin/node', str(candidate / 'dashboard/backend.cjs')], env=env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(30):
                if process.poll() is not None:
                    raise ValueError('The new backend did not start')
                if backend_health(port, metadata['version']):
                    break
                time.sleep(1)
            else:
                raise ValueError('The new backend failed its health check')
        finally:
            process.terminate()
            try:
                process.wait(timeout=6)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        release = releases / ('ota-' + metadata['version'] + '-' + str(time.time_ns()))
        candidate.rename(release)
        print(release)


def systemctl(*args):
    subprocess.run(['systemctl', *args], check=True, timeout=60, stdout=subprocess.DEVNULL)


@contextlib.contextmanager
def as_user(account):
    old_uid, old_gid = os.geteuid(), os.getegid()
    os.setegid(account.pw_gid)
    os.seteuid(account.pw_uid)
    try:
        yield
    finally:
        os.seteuid(old_uid)
        os.setegid(old_gid)


def recover(root, account):
    with as_user(account):
        pending = root / 'pending-update.json'
        if not pending.exists():
            return
        data = read_json(pending)
        if data.get('previous'):
            previous = release_path(root, data['previous'])
            replace_link(root / 'current', previous)
        write_json(root / 'update-result.json', {'state': 'error', 'failedVersion': data['version'],
                   'message': 'An interrupted update was cancelled. The previous dashboard was restored.'})
        pending.unlink()


def apply(root, account):
    with as_user(account):
        pending = root / 'pending-update.json'
        data = read_json(pending)
        candidate = release_path(root, data['candidate'])
        previous = release_path(root, str((root / 'current').resolve()))
        data['previous'] = str(previous)
        write_json(pending, data)
    if data.get('automatic'):
        try:
            with urllib.request.urlopen('https://127.0.0.1:8080/api/status', timeout=2,
                                        context=ssl._create_unverified_context()) as response:
                idle = json.load(response).get('sessionActive') is False
        except (OSError, ValueError):
            idle = False
        if not idle:
            with as_user(account):
                pending.unlink()
                if candidate != (root / 'current').resolve():
                    shutil.rmtree(candidate)
                write_json(root / 'update-result.json', {'state': 'idle',
                           'message': 'Update postponed because CarPlay connected. It will retry while idle.'})
            return
    try:
        systemctl('stop', *reversed(SERVICES))
        with as_user(account):
            replace_link(root / 'previous', previous)
            replace_link(root / 'current', candidate)
        systemctl('start', *SERVICES[:2])
        deadline = time.monotonic() + 90
        healthy = False
        while time.monotonic() < deadline:
            if backend_health(4000, data['version']):
                try:
                    with urllib.request.urlopen('https://127.0.0.1:8080/api/status', timeout=2,
                                                context=ssl._create_unverified_context()) as response:
                        if 'deviceName' in json.load(response):
                            healthy = True
                            break
                except (OSError, ValueError):
                    pass
            time.sleep(1)
        if not healthy:
            raise RuntimeError('Updated services did not become healthy')
        systemctl('start', SERVICES[2])
        time.sleep(5)
        systemctl('is-active', '--quiet', *SERVICES)
        with as_user(account):
            write_json(root / 'update-result.json', {'state': 'success',
                       'message': 'Updated to v3 ' + data['version'], 'version': data['version']})
            pending.unlink()
    except Exception:
        try:
            systemctl('stop', *reversed(SERVICES))
        except Exception:
            pass
        with as_user(account):
            replace_link(root / 'current', previous)
            write_json(root / 'update-result.json', {'state': 'error', 'failedVersion': data['version'],
                       'message': 'The update failed its health check. The previous dashboard was restored.'})
            pending.unlink(missing_ok=True)
        systemctl('start', *SERVICES)
        raise


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else ''
    if action == 'stage' and len(sys.argv) == 3:
        stage(Path(sys.argv[2]))
        return
    if os.geteuid() != 0 or action not in ('schedule', 'apply', 'recover'):
        raise SystemExit('Invalid update action')
    account = pwd.getpwnam(USER_FILE.read_text().strip())
    root = Path(account.pw_dir) / '.local/share/round-carplay-pi'
    if action == 'schedule':
        systemctl('start', '--no-block', 'round-carplay-apply-update.service')
    elif action == 'apply':
        # Let the button's response reach the browser before its service stops.
        time.sleep(3)
        apply(root, account)
    else:
        recover(root, account)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Update failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
