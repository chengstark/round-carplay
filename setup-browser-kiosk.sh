#!/usr/bin/env bash
set -euo pipefail

if test "$(id -u)" -eq 0; then
  if test -n "${SUDO_USER:-}" && test "$SUDO_USER" != root; then
    INSTALL_USER="$SUDO_USER"
  else
    echo "Run this installer as the kiosk user, not from a root login." >&2
    exit 1
  fi
else
  INSTALL_USER="$(id -un)"
fi

INSTALL_UID="$(id -u "$INSTALL_USER")"
USER_HOME="$(getent passwd "$INSTALL_USER" | cut -d: -f6)"
REPOSITORY="$(cd "$(dirname "$0")" && pwd)"
APPIMAGE="$USER_HOME/round-carplay/round-carplay.AppImage"
RELEASE_ROOT="$USER_HOME/.local/share/round-carplay"
CONFIG_DIR=/etc/round-carplay
PORT=4000

if test -z "$USER_HOME"; then
  echo "Could not determine the home directory for $INSTALL_USER" >&2
  exit 1
fi

CHROMIUM="$(command -v chromium || command -v chromium-browser || true)"
missing_packages=()
command -v cage >/dev/null 2>&1 || missing_packages+=(cage)
command -v curl >/dev/null 2>&1 || missing_packages+=(curl)
command -v node >/dev/null 2>&1 || missing_packages+=(nodejs)
command -v npm >/dev/null 2>&1 || missing_packages+=(npm)
command -v ffmpeg >/dev/null 2>&1 || missing_packages+=(ffmpeg)
if test -z "$CHROMIUM"; then missing_packages+=(chromium); fi

if test "${#missing_packages[@]}" -gt 0; then
  sudo apt-get update
  sudo apt-get --yes install "${missing_packages[@]}"
  CHROMIUM="$(command -v chromium || command -v chromium-browser || true)"
fi
if test -z "$CHROMIUM"; then
  echo "Chromium was not found after installation." >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if test "$node_major" -lt 20; then
  echo "Node.js 20 or newer is required; found $(node --version)." >&2
  exit 1
fi

echo "Building browser backend and UI"
cd "$REPOSITORY"
if ! test -d node_modules || ! node -e 'require("usb")' >/dev/null 2>&1; then
  npm install --no-audit --legacy-peer-deps --ignore-scripts
  npm rebuild usb
fi
npm run build:browser
ROUND_CARPLAY_RELEASE_ROOT="$RELEASE_ROOT" npm run install:browser-release

sudo install -d -m 0755 "$CONFIG_DIR"
printf '%s\n' "$USER_HOME" | sudo tee "$CONFIG_DIR/install-user-home" >/dev/null
CAMERA_PASSWORD_FILE="$CONFIG_DIR/eeye-camera-wifi-password"
if ! sudo test -s "$CAMERA_PASSWORD_FILE"; then
  camera_password="${ROUND_CARPLAY_CAMERA_WIFI_PASSWORD:-}"
  if test -z "$camera_password" && test -t 0; then
    read -r -s -p "E-Eye camera Wi-Fi password: " camera_password
    echo
  fi
  if test -z "$camera_password"; then
    echo "Set ROUND_CARPLAY_CAMERA_WIFI_PASSWORD or run interactively to configure the camera." >&2
    exit 1
  fi
  printf '%s\n' "$camera_password" | sudo tee "$CAMERA_PASSWORD_FILE" >/dev/null
  unset camera_password
fi
sudo chmod 0600 "$CAMERA_PASSWORD_FILE"
if test -n "${ROUND_CARPLAY_UPDATE_MANIFEST_URL:-}"; then
  printf '%s\n' "$ROUND_CARPLAY_UPDATE_MANIFEST_URL" | sudo tee "$CONFIG_DIR/update-manifest-url" >/dev/null
  sudo chmod 0644 "$CONFIG_DIR/update-manifest-url"
fi
sudo install -m 0755 "$REPOSITORY/scripts/round-carplay-runtime" /usr/local/sbin/round-carplay-runtime
sudo install -m 0755 "$REPOSITORY/scripts/round-carplay-browser-fallback" /usr/local/sbin/round-carplay-browser-fallback
sudo install -m 0755 "$REPOSITORY/scripts/round-carplay-camera-wifi" /usr/local/sbin/round-carplay-camera-wifi
sudo install -m 0755 "$REPOSITORY/scripts/round-carplay-connect-wifi" /usr/local/sbin/round-carplay-connect-wifi
sudo install -m 0755 "$REPOSITORY/scripts/round-carplay-restore-wifi" /usr/local/sbin/round-carplay-restore-wifi

CURSOR_THEME_NAME=round-carplay-transparent
CURSOR_THEME_ROOT="/usr/local/share/icons/$CURSOR_THEME_NAME"
sudo install -d -m 0755 "$CURSOR_THEME_ROOT/cursors"
sudo install -m 0644 \
  "$REPOSITORY/config/round-carplay-transparent.index.theme" \
  "$CURSOR_THEME_ROOT/index.theme"
node "$REPOSITORY/scripts/generate-transparent-cursor.mjs" \
  | sudo tee "$CURSOR_THEME_ROOT/cursors/left_ptr" >/dev/null
for cursor_name in default arrow hand hand1 hand2 pointer text xterm watch progress crosshair move; do
  sudo ln -sfn left_ptr "$CURSOR_THEME_ROOT/cursors/$cursor_name"
done

sudo tee /etc/pam.d/round-carplay-kiosk >/dev/null <<'PAM'
auth       required pam_unix.so nullok
account    required pam_unix.so
session    required pam_unix.so
session    required pam_systemd.so
PAM

# Cage has no cursor-hiding option. Ignore the round panel's mouse-only event
# node while retaining its proper multitouch interface.
sudo install -m 0644 \
  "$REPOSITORY/config/99-round-carplay-touchscreen-pointer.rules" \
  /etc/udev/rules.d/99-round-carplay-touchscreen-pointer.rules
sudo udevadm control --reload-rules

sudo tee /etc/systemd/system/round-carplay-electron.service >/dev/null <<EOF
[Unit]
Description=Round CarPlay Electron kiosk
After=systemd-user-sessions.service systemd-logind.service dbus.socket NetworkManager.service
Wants=systemd-logind.service dbus.socket
Before=graphical.target
Conflicts=getty@tty1.service display-manager.service round-carplay-browser-kiosk.service
ConditionPathExists=$APPIMAGE

[Service]
Type=simple
User=$INSTALL_USER
PAMName=round-carplay-kiosk
WorkingDirectory=$(dirname "$APPIMAGE")
Environment="HOME=$USER_HOME"
Environment="USER=$INSTALL_USER"
Environment="LOGNAME=$INSTALL_USER"
Environment="XDG_RUNTIME_DIR=/run/user/$INSTALL_UID"
Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$INSTALL_UID/bus"
Environment="XDG_SESSION_TYPE=wayland"
Environment="ELECTRON_OZONE_PLATFORM_HINT=wayland"
Environment="XCURSOR_THEME=$CURSOR_THEME_NAME"
Environment="XCURSOR_SIZE=1"
Environment="XCURSOR_PATH=/usr/local/share/icons:/usr/share/icons"
Environment="WLR_LIBINPUT_NO_DEVICES=1"
Environment="NO_AT_BRIDGE=1"
ExecStart=/usr/bin/cage -- "$APPIMAGE" --ozone-platform=wayland --disable-notifications
ExecStartPost=+/usr/bin/chvt 1
Restart=always
RestartSec=2
TimeoutStopSec=10
UtmpIdentifier=tty1
UtmpMode=user
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
StandardInput=tty-fail
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=graphical.target
EOF

sudo tee /etc/systemd/system/round-carplay-backend.service >/dev/null <<EOF
[Unit]
Description=Round CarPlay browser hardware backend
After=NetworkManager.service
Wants=NetworkManager.service
OnFailure=round-carplay-browser-fallback.service
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
User=$INSTALL_USER
WorkingDirectory=$RELEASE_ROOT/current
Environment="HOME=$USER_HOME"
Environment="USER=$INSTALL_USER"
Environment="LOGNAME=$INSTALL_USER"
Environment="NODE_ENV=production"
Environment="ROUND_CARPLAY_PORT=$PORT"
Environment="ROUND_CARPLAY_UI_DIR=$RELEASE_ROOT/current/ui"
Environment="ROUND_CARPLAY_DATA_DIR=$USER_HOME/.config/round-carplay"
Environment="ROUND_CARPLAY_RELEASE_ROOT=$RELEASE_ROOT"
Environment="ROUND_CARPLAY_REPO=$REPOSITORY"
ExecStart=$(command -v node) $RELEASE_ROOT/current/server/backend.js
Restart=always
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
EOF

mkdir -p "$USER_HOME/.config/round-carplay/chromium"
sudo tee /etc/systemd/system/round-carplay-browser-kiosk.service >/dev/null <<EOF
[Unit]
Description=Round CarPlay Chromium kiosk
After=round-carplay-backend.service systemd-user-sessions.service systemd-logind.service dbus.socket
Requires=round-carplay-backend.service
Wants=systemd-logind.service dbus.socket
Before=graphical.target
Conflicts=getty@tty1.service display-manager.service round-carplay-electron.service
OnFailure=round-carplay-browser-fallback.service
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
User=$INSTALL_USER
PAMName=round-carplay-kiosk
Environment="HOME=$USER_HOME"
Environment="USER=$INSTALL_USER"
Environment="LOGNAME=$INSTALL_USER"
Environment="XDG_RUNTIME_DIR=/run/user/$INSTALL_UID"
Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$INSTALL_UID/bus"
Environment="XDG_SESSION_TYPE=wayland"
Environment="XCURSOR_THEME=$CURSOR_THEME_NAME"
Environment="XCURSOR_SIZE=1"
Environment="XCURSOR_PATH=/usr/local/share/icons:/usr/share/icons"
Environment="WLR_LIBINPUT_NO_DEVICES=1"
Environment="NO_AT_BRIDGE=1"
ExecStartPre=/bin/bash -c 'for attempt in {1..60}; do /usr/bin/curl --fail --silent http://127.0.0.1:$PORT/health >/dev/null && exit 0; sleep 1; done; exit 1'
ExecStart=/usr/bin/cage -- $CHROMIUM --ozone-platform=wayland --enable-features=UseOzonePlatform,AcceleratedVideoDecodeLinuxGL,AcceleratedVideoDecodeLinuxZeroCopyGL --use-gl=angle --use-angle=gl --ignore-gpu-blocklist --enable-gpu-rasterization --autoplay-policy=no-user-gesture-required --kiosk --app=http://127.0.0.1:$PORT/ --no-first-run --disable-session-crashed-bubble --disable-infobars --disable-notifications --disable-translate --password-store=basic --user-data-dir=$USER_HOME/.config/round-carplay/chromium
ExecStartPost=+/usr/bin/chvt 1
Restart=always
RestartSec=2
TimeoutStopSec=10
UtmpIdentifier=tty1
UtmpMode=user
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
StandardInput=tty-fail
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=graphical.target
EOF

sudo tee /etc/systemd/system/round-carplay-browser-fallback.service >/dev/null <<EOF
[Unit]
Description=Round CarPlay browser failure rollback

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/round-carplay-browser-fallback
EOF

sudo tee /etc/sudoers.d/round-carplay-runtime >/dev/null <<EOF
$INSTALL_USER ALL=(root) NOPASSWD: /usr/local/sbin/round-carplay-runtime switch electron
$INSTALL_USER ALL=(root) NOPASSWD: /usr/local/sbin/round-carplay-runtime switch browser
$INSTALL_USER ALL=(root) NOPASSWD: /usr/local/sbin/round-carplay-camera-wifi
$INSTALL_USER ALL=(root) NOPASSWD: /usr/local/sbin/round-carplay-connect-wifi
$INSTALL_USER ALL=(root) NOPASSWD: /usr/local/sbin/round-carplay-restore-wifi
$INSTALL_USER ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
$INSTALL_USER ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff
EOF
sudo chmod 0440 /etc/sudoers.d/round-carplay-runtime
sudo visudo -cf /etc/sudoers.d/round-carplay-runtime

sudo systemctl disable round-carplay-kiosk.service >/dev/null 2>&1 || true
sudo systemctl daemon-reload

selected="$(sudo sed -n '1p' "$CONFIG_DIR/runtime" 2>/dev/null || true)"
if test "$selected" != electron && test "$selected" != browser; then
  if test -x "$APPIMAGE"; then selected=electron; else selected=browser; fi
fi
sudo /usr/local/sbin/round-carplay-runtime switch "$selected"
sudo systemctl set-default graphical.target

echo "Dual-runtime kiosk installed. Selected runtime: $selected"
echo "Switch without the UI: sudo round-carplay-runtime switch electron|browser"
echo "Reboot when ready: sudo systemctl reboot"
