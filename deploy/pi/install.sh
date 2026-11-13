#!/usr/bin/env bash
set -euo pipefail
PACKAGE="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$PACKAGE/deploy/verify.py"
if [[ "${1:-}" == --check ]]; then exit 0; fi
if [[ "$(id -u)" == 0 ]]; then
  echo 'Run as the normal Pi user, without sudo. The installer requests sudo when needed.' >&2
  exit 1
fi
if [[ "$(uname -s)" != Linux || "$(uname -m)" != aarch64 ]]; then
  echo 'Requires Raspberry Pi OS (64-bit), Trixie. A 32-bit OS cannot run this bundle.' >&2
  exit 1
fi
source /etc/os-release
if [[ "${VERSION_CODENAME:-}" != trixie ]] || ! grep -q 'Raspberry Pi' /proc/device-tree/model; then
  echo 'This installer targets Raspberry Pi OS Trixie on a Raspberry Pi.' >&2
  exit 1
fi
KIOSK_USER="$(id -un)"
case "$HOME:$KIOSK_USER" in *[[:space:]%]* ) echo 'Use a home directory and username without spaces or percent signs.' >&2; exit 1;; esac
ROOT="$HOME/.local/share/round-carplay-pi"
CONFIG="$HOME/.config/round-carplay-deploy/settings.json"
if [[ ! -f "$PACKAGE/private/identity/offline-mfi/identity.pk8" && ! -f "$ROOT/private/identity/offline-mfi/identity.pk8" ]]; then
  echo 'Private accessory identity is missing. Use the private bundle built on your Mac.' >&2
  exit 1
fi
sudo -v
if [[ "${1:-}" == --offline ]]; then
  for command in cage chromium node java cc nmcli python3 tesseract curl rfkill iw; do
    command -v "$command" >/dev/null || { echo "Missing runtime: $command; install online first." >&2; exit 1; }
  done
else
  sudo apt-get update
  sudo apt-get install --yes --no-install-recommends \
    cage chromium nodejs openjdk-21-jre-headless bluez libbluetooth-dev build-essential \
    python3 tesseract-ocr tesseract-ocr-eng network-manager dbus-user-session \
    libpam-systemd curl rfkill iw
fi
node -e 'if(Number(process.versions.node.split(".")[0])<20)process.exit(1)'
java -version
umask 077
mkdir -p "$ROOT/releases" "$ROOT/private/identity/offline-mfi" "$ROOT/state"
if [[ -d "$PACKAGE/private" ]]; then
  # Identity and brightness credentials remain outside releases and rollback.
  python3 - "$PACKAGE/private" "$ROOT/private" <<'PY'
from pathlib import Path
import shutil
import sys
source, target = map(Path, sys.argv[1:])
for path in source.rglob('*'):
    if path.is_file():
        destination = target / path.relative_to(source)
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not destination.exists():
            shutil.copyfile(path, destination)
        destination.chmod(0o600)
PY
fi
chmod -R go-rwx "$ROOT/private"
if [[ ! -f "$ROOT/private/identity/offline-mfi/certificate.p7b" ]]; then
  echo 'Accessory certificate is missing.' >&2; exit 1
fi
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["builtAt"].replace(":", "").replace(".", "-"))' "$PACKAGE/manifest.json")-$$"
RELEASE="$ROOT/releases/$VERSION"
mkdir -p "$RELEASE"
cp -R "$PACKAGE/dashboard" "$PACKAGE/playport" "$PACKAGE/deploy" "$PACKAGE/manifest.json" "$RELEASE/"
bash "$RELEASE/playport/linux/bt-bridge/build.sh"
chmod 0755 "$RELEASE/playport/bin/server"
if [[ ! -f "$CONFIG" ]]; then python3 "$RELEASE/deploy/launch.py" configure; fi
# Build and configure successfully before replacing the current release.
if [[ -L "$ROOT/current" ]]; then
  ln -sfn "$(readlink "$ROOT/current")" "$ROOT/previous.new"
  mv -Tf "$ROOT/previous.new" "$ROOT/previous"
fi
ln -sfn "$RELEASE" "$ROOT/current.new"
mv -Tf "$ROOT/current.new" "$ROOT/current"

sudo usermod -a -G video,audio,render,netdev "$KIOSK_USER"
# PlayPort needs BlueZ. Never apply the obsolete display-only Bluetooth lockout.
sudo systemctl unmask bluetooth.service
sudo systemctl enable --now bluetooth.service
sudo rfkill unblock bluetooth
sudo bluetoothctl power on || true
sudo install -d -m 0755 /etc/round-carplay /etc/NetworkManager/conf.d
sudo tee /etc/NetworkManager/conf.d/20-round-carplay-wifi-powersave.conf >/dev/null <<'EOF'
[connection]
wifi.powersave=2
EOF
for helper in round-carplay-scan-wifi round-carplay-connect-wifi; do
  sudo install -m 0755 "$RELEASE/deploy/$helper" "/usr/local/sbin/$helper"
done
printf '%s\n' "$KIOSK_USER" | sudo tee /etc/round-carplay/pi-user >/dev/null
sudo install -d -m 0755 /usr/local/lib/round-carplay /etc/NetworkManager/dispatcher.d
sudo install -m 0755 "$RELEASE/deploy/network.py" /usr/local/sbin/round-carplay-network
sudo install -m 0755 "$RELEASE/deploy/update.py" /usr/local/sbin/round-carplay-update
sudo install -m 0644 "$RELEASE/deploy/update.py" /usr/local/lib/round-carplay/update.py
if [[ -f "$RELEASE/deploy/pi-update.json" ]]; then
  sudo install -m 0644 "$RELEASE/deploy/pi-update.json" /etc/round-carplay/pi-update.json
fi
sudo tee /etc/NetworkManager/dispatcher.d/90-round-carplay >/dev/null <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == wlan0 && ( "$2" == up || "$2" == dhcp4-change ) ]]; then
  systemctl --no-block start round-carplay-network-sync.service
fi
EOF
sudo chmod 0755 /etc/NetworkManager/dispatcher.d/90-round-carplay
sudo tee /etc/pam.d/round-carplay-kiosk >/dev/null <<'EOF'
auth       required pam_unix.so nullok
account    required pam_unix.so
session    required pam_unix.so
session    required pam_systemd.so
EOF
sudo tee /etc/sudoers.d/round-carplay-pi >/dev/null <<EOF
$KIOSK_USER ALL=(root) NOPASSWD: /usr/local/sbin/round-carplay-scan-wifi
$KIOSK_USER ALL=(root) NOPASSWD: /usr/local/sbin/round-carplay-connect-wifi
$KIOSK_USER ALL=(root) NOPASSWD: /usr/local/sbin/round-carplay-network scan
$KIOSK_USER ALL=(root) NOPASSWD: /usr/local/sbin/round-carplay-network connect
$KIOSK_USER ALL=(root) NOPASSWD: /usr/local/sbin/round-carplay-update schedule
$KIOSK_USER ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
$KIOSK_USER ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff
EOF
sudo chmod 0440 /etc/sudoers.d/round-carplay-pi
sudo visudo -cf /etc/sudoers.d/round-carplay-pi

sudo tee /etc/systemd/system/round-carplay-playport.service >/dev/null <<EOF
[Unit]
Description=Round CarPlay PlayPort host
After=network-online.target bluetooth.service
After=round-carplay-update-recover.service
Wants=network-online.target bluetooth.service
StartLimitIntervalSec=0
[Service]
User=$KIOSK_USER
Environment="HOME=$HOME"
Environment="PYTHONDONTWRITEBYTECODE=1"
ExecStart=/usr/bin/python3 $ROOT/current/deploy/launch.py host
Restart=always
RestartSec=5
SuccessExitStatus=143
TimeoutStopSec=15
[Install]
WantedBy=multi-user.target
EOF
sudo tee /etc/systemd/system/round-carplay-backend.service >/dev/null <<EOF
[Unit]
Description=Round CarPlay browser backend
After=network.target round-carplay-playport.service
After=round-carplay-update-recover.service
Wants=round-carplay-playport.service
StartLimitIntervalSec=0
[Service]
User=$KIOSK_USER
Environment="HOME=$HOME"
ExecStart=/usr/bin/python3 $ROOT/current/deploy/launch.py backend
Restart=always
RestartSec=3
TimeoutStopSec=10
[Install]
WantedBy=multi-user.target
EOF
sudo tee /etc/systemd/system/round-carplay-network-sync.service >/dev/null <<'EOF'
[Unit]
Description=Refresh CarPlay after Wi-Fi changes
After=NetworkManager.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/round-carplay-network sync
EOF
sudo tee /etc/systemd/system/round-carplay-network-recover.service >/dev/null <<'EOF'
[Unit]
Description=Reconnect saved dashboard Wi-Fi
After=NetworkManager.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/round-carplay-network recover
TimeoutStartSec=60
EOF
sudo tee /etc/systemd/system/round-carplay-network-recover.timer >/dev/null <<'EOF'
[Unit]
Description=Check dashboard Wi-Fi connection
[Timer]
OnBootSec=60
OnUnitInactiveSec=45
[Install]
WantedBy=timers.target
EOF
sudo tee /etc/systemd/system/round-carplay-apply-update.service >/dev/null <<'EOF'
[Unit]
Description=Apply the staged v3 dashboard update
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/round-carplay-update apply
TimeoutStartSec=360
EOF
sudo tee /etc/systemd/system/round-carplay-update-recover.service >/dev/null <<'EOF'
[Unit]
Description=Restore dashboard after an interrupted update
Before=round-carplay-playport.service round-carplay-backend.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/round-carplay-update recover
[Install]
WantedBy=multi-user.target
EOF
sudo tee /etc/systemd/system/round-carplay-browser-kiosk.service >/dev/null <<EOF
[Unit]
Description=Round CarPlay Chromium kiosk
After=round-carplay-backend.service systemd-user-sessions.service systemd-logind.service
Requires=round-carplay-backend.service
Conflicts=getty@tty1.service display-manager.service
StartLimitIntervalSec=0
[Service]
User=$KIOSK_USER
PAMName=round-carplay-kiosk
Environment="HOME=$HOME"
Environment="XDG_RUNTIME_DIR=/run/user/$(id -u)"
Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus"
Environment="XDG_SESSION_TYPE=wayland"
Environment="WLR_LIBINPUT_NO_DEVICES=1"
ExecStart=/usr/bin/python3 $ROOT/current/deploy/launch.py kiosk
ExecStartPost=+/usr/bin/chvt 1
Restart=always
RestartSec=3
TimeoutStopSec=10
TTYPath=/dev/tty1
StandardInput=tty
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
[Install]
WantedBy=graphical.target
EOF
# Remember the desktop's unit for console recovery; apply kiosk boot next reboot.
DISPLAY_MANAGER="$(systemctl show -p Id --value display-manager.service 2>/dev/null || true)"
if [[ -n "$DISPLAY_MANAGER" && "$DISPLAY_MANAGER" != display-manager.service ]]; then
  printf '%s\n' "$DISPLAY_MANAGER" | sudo tee /etc/round-carplay/pi-display-manager >/dev/null
  sudo systemctl disable "$DISPLAY_MANAGER"
fi
# Prevent an existing old kiosk from competing for the screen, without installing it.
sudo systemctl disable round-carplay-kiosk.service round-carplay-electron.service >/dev/null 2>&1 || true
sudo systemctl daemon-reload
sudo systemctl enable round-carplay-playport.service round-carplay-backend.service round-carplay-browser-kiosk.service
sudo systemctl enable round-carplay-update-recover.service round-carplay-network-recover.timer
sudo systemctl enable getty@tty2.service
if ! sudo /usr/local/sbin/round-carplay-network sync; then
  echo 'Wi-Fi is not ready yet. Use the local Wi-Fi menu or sudo nmtui after installation.'
fi
sudo systemctl set-default graphical.target
echo 'Installed current PlayPort + browser kiosk. Pair/trust the iPhone with bluetoothctl, then reboot.'
echo 'No reboot, display-mode change, phone re-pairing or brightness actuation was performed by this installer.'
