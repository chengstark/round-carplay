#!/usr/bin/env bash
set -euo pipefail

# ----------------------------------------
# round-carplay Raspberry Pi kiosk installer
# ----------------------------------------

# 0) Variables
USER_HOME="$HOME"
INSTALL_USER="$(id -un)"
INSTALL_UID="$(id -u)"
APPIMAGE_PATH="$USER_HOME/round-carplay/round-carplay.AppImage"
APPIMAGE_DIR="$(dirname "$APPIMAGE_PATH")"
KIOSK_SERVICE="round-carplay-kiosk.service"
KIOSK_CONFIG_DIR="/etc/round-carplay"
DISPLAY_MANAGER_FILE="$KIOSK_CONFIG_DIR/display-manager-unit"

echo "→ Creating target directory: $APPIMAGE_DIR"
mkdir -p "$APPIMAGE_DIR"

# Ensure required tools are installed. Cage replaces the full desktop with a
# single-application Wayland session.
echo "→ Checking for required tools: curl, xdg-user-dir, cage"
missing_packages=()
command -v curl >/dev/null 2>&1 || missing_packages+=(curl)
command -v xdg-user-dir >/dev/null 2>&1 || missing_packages+=(xdg-user-dirs)
command -v cage >/dev/null 2>&1 || missing_packages+=(cage)

if [ "${#missing_packages[@]}" -gt 0 ]; then
  sudo apt-get update
  sudo apt-get --yes install "${missing_packages[@]}"
else
  echo "   All required tools found"
fi

# Create udev rule for Carlinkit dongle
echo "→ Writing udev rule"
UDEV_FILE="/etc/udev/rules.d/52-carplay.rules"
sudo tee "$UDEV_FILE" > /dev/null <<EOF
SUBSYSTEM=="usb", ATTR{idVendor}=="1314", ATTR{idProduct}=="152*", MODE="0660", GROUP="plugdev"
EOF
echo "   Reloading udev rules"
sudo udevadm control --reload-rules
sudo udevadm trigger

# ICON INSTALLATION
ICON_URL="https://raw.githubusercontent.com/OneMakerShow/round-carplay/custom-round/assets/icons/linux/pi-carplay.png"
ICON_DEST="$USER_HOME/.local/share/icons/round-carplay.png"

if [ -d "$USER_HOME/.local/share" ]; then
  echo "→ Installing icon to $ICON_DEST"
  mkdir -p "$(dirname "$ICON_DEST")"
  
  echo "   Downloading icon from $ICON_URL..."
  curl -L "$ICON_URL" -o "$ICON_DEST"
  
  if [ $? -eq 0 ]; then
    echo "   App icon downloaded and installed successfully."
  else
    echo "   Failed to download icon from $ICON_URL. Skipping icon install."
  fi
else
  echo "   No ~/.local/share directory, skipping icon installation."
fi

# Preserve an AppImage already installed by the on-display updater. On a fresh
# installation only, fetch the latest ARM64 release.
if [ -f "$APPIMAGE_PATH" ]; then
  echo "→ Keeping existing AppImage: $APPIMAGE_PATH"
else
  echo "→ Fetching latest round-carplay release"
  latest_url=$(curl -s https://api.github.com/repos/OneMakerShow/round-carplay/releases/latest \
    | grep "browser_download_url" \
    | grep "arm64.AppImage" \
    | cut -d '"' -f 4)

  if [ -z "$latest_url" ]; then
    echo "Error: Could not find ARM64 AppImage URL in your repo releases" >&2
    exit 1
  fi

  echo "   Download URL: $latest_url"
  if ! curl -L "$latest_url" --output "$APPIMAGE_PATH"; then
    echo "Error: Download failed" >&2
    exit 1
  fi
  echo "   Download complete: $APPIMAGE_PATH"
fi

# Mark AppImage as executable
echo "→ Setting executable flag"
chmod +x "$APPIMAGE_PATH"

# Remove the old desktop-session autostart entry. The system service below now
# owns application startup and prevents duplicate launches.
AUTOSTART_DIR="$USER_HOME/.config/autostart"
rm -f "$AUTOSTART_DIR/round-carplay.desktop"

# Remember the existing display manager so the desktop can be restored with
# the recovery command installed below.
DISPLAY_MANAGER_UNIT=""
if [ -f "$DISPLAY_MANAGER_FILE" ]; then
  DISPLAY_MANAGER_UNIT="$(sudo sed -n '1p' "$DISPLAY_MANAGER_FILE")"
else
  DISPLAY_MANAGER_UNIT="$(systemctl show --property=Id --value display-manager.service 2>/dev/null || true)"
  if [ "$DISPLAY_MANAGER_UNIT" = "display-manager.service" ]; then
    DISPLAY_MANAGER_UNIT=""
  fi
fi

sudo install -d -m 0755 "$KIOSK_CONFIG_DIR"
printf '%s\n' "$DISPLAY_MANAGER_UNIT" | sudo tee "$DISPLAY_MANAGER_FILE" >/dev/null

# Cage's PAM session gives the compositor a proper logind seat and creates the
# user's runtime directory for audio and D-Bus services.
echo "→ Creating kiosk login session"
sudo tee /etc/pam.d/round-carplay-kiosk >/dev/null <<'EOF'
auth       required pam_unix.so nullok
account    required pam_unix.so
session    required pam_unix.so
session    required pam_systemd.so
EOF

echo "→ Installing kiosk boot service"
sudo tee "/etc/systemd/system/$KIOSK_SERVICE" >/dev/null <<EOF
[Unit]
Description=Round CarPlay kiosk
After=systemd-user-sessions.service systemd-logind.service dbus.socket NetworkManager.service plymouth-quit-wait.service
Wants=systemd-logind.service dbus.socket
Before=graphical.target
Conflicts=getty@tty1.service display-manager.service
ConditionPathExists=/dev/tty0

[Service]
Type=simple
User=$INSTALL_USER
PAMName=round-carplay-kiosk
WorkingDirectory=$APPIMAGE_DIR
Environment="HOME=$USER_HOME"
Environment="USER=$INSTALL_USER"
Environment="LOGNAME=$INSTALL_USER"
Environment="XDG_RUNTIME_DIR=/run/user/$INSTALL_UID"
Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$INSTALL_UID/bus"
Environment="XDG_SESSION_TYPE=wayland"
Environment="XDG_CURRENT_DESKTOP=round-carplay"
Environment="ELECTRON_OZONE_PLATFORM_HINT=wayland"
Environment="WLR_LIBINPUT_NO_DEVICES=1"
Environment="NO_AT_BRIDGE=1"
ExecStart=/usr/bin/cage -- "$APPIMAGE_PATH" --ozone-platform=wayland --disable-notifications
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

# Install a recovery helper. It restores the display manager for the next boot
# without deleting the kiosk configuration.
sudo tee /usr/local/sbin/round-carplay-desktop >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail

systemctl disable $KIOSK_SERVICE
display_manager=\$(sed -n '1p' "$DISPLAY_MANAGER_FILE" 2>/dev/null || true)
if [ -n "\$display_manager" ]; then
  systemctl enable "\$display_manager"
else
  echo "No previous display manager was recorded; install or enable one manually." >&2
fi
systemctl set-default graphical.target
echo "Desktop boot restored for the next reboot."
EOF
sudo chmod 0755 /usr/local/sbin/round-carplay-desktop

# Keep the currently running desktop alive, but make the kiosk the default from
# the next boot onward.
if [ -n "$DISPLAY_MANAGER_UNIT" ]; then
  sudo systemctl disable "$DISPLAY_MANAGER_UNIT" >/dev/null 2>&1 || true
fi
sudo systemctl daemon-reload
sudo systemctl enable "$KIOSK_SERVICE"
sudo systemctl set-default graphical.target

# Create Desktop shortcut
echo "→ Creating desktop shortcut"
if command -v xdg-user-dir >/dev/null 2>&1; then
  DESKTOP_DIR=$(xdg-user-dir DESKTOP)
else
  DESKTOP_DIR="$USER_HOME/Desktop"
fi

mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_DIR/round-carplay.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=round-carplay
Comment=Launch round-carplay AppImage
Exec=$APPIMAGE_PATH
Icon=round-carplay
Terminal=false
Categories=Utility;
StartupNotify=false
EOF
chmod +x "$DESKTOP_DIR/round-carplay.desktop"
echo "Desktop shortcut at $DESKTOP_DIR/round-carplay.desktop"

echo "✅ Installation complete! Round CarPlay will boot directly into kiosk mode."
echo "   Desktop notifications are absent because no desktop shell or notification daemon is started."
echo "   Reboot when ready: sudo reboot"
echo "   Restore desktop boot later: sudo round-carplay-desktop"
