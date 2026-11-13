# Current Round CarPlay on Raspberry Pi 3 B

This deploys the **current local browser dashboard and PlayPort host** from the
ROUNDSCREENCARPLAY chat. It does not install Electron, Carlinkit, an AppImage,
UTM, or any earlier application release. The Mac builds the assets and JVM
distribution; the Pi runs them directly. There is no prebuilt OS image yet.

## Status and target

- Target: Raspberry Pi OS **Trixie, 64-bit**, on the Pi 3 B; SSH and Wi-Fi enabled.
- Initial installation needs internet for Debian runtime packages. Boot and
  operation afterwards use local services and the configured Wi-Fi network.
- Physical Pi validation is pending. Packaging and local smoke checks do not
  establish video decode performance, Bluetooth compatibility, touch accuracy,
  audio routing, camera operation, OCR speed, or cold-boot reliability.
- Pi 3 B has 1 GB RAM. Initial JVM/Node heap limits are 256/128 MB; Chromium,
  native allocations and the OS use additional RAM. These are starting budgets.
- Current negotiation stays **512×512 map, 1024×1024 main, H.264, 60 fps**.
  Physical panel is 480×480. Preserve the **1280×960@60** HDMI mapping and the
  existing 4:3 CSS compensation. The installer does not change HDMI modes.
- Use the existing external Wi-Fi for bring-up. A Pi-hosted hotspot and
  simultaneous wireless CarPlay have not been validated.
- Use the current Insignia USB Bluetooth adapter for the first test if the Pi's
  built-in Bluetooth does not work. BlueZ is enabled. Do not apply the old
  scripts that turn the controller off.

## Build on Mac

From the active browser-kiosk checkout, with Java and the existing Gradle cache:

```sh
JAVA_HOME=/path/to/jdk-21 \
GRADLE_USER_HOME=/path/to/existing/gradle-cache \
node scripts/package-pi.mjs \
  --playport-source /path/to/current/playport \
  --include-private-identity \
  --brightness-profile /path/to/private/brightness-profile.json
```

The script builds the live sources, including uncommitted changes. It stages a
copy of PlayPort under `dist/pi-build` so the original checkout is not modified.
The offline Gradle build requires already cached dependencies. It packages no
Mac native modules, VM, phone pairing state, or Wi-Fi password. The backend is
bundled into one Node file, so npm and Gradle are unnecessary on the Pi.

The generated `dist/pi/<timestamp>/round-carplay-pi-PRIVATE.tar.gz` contains the
private accessory identity and optional brightness credentials. **Keep this
archive private; do not commit, publish, or share it.** Omitting the two private
options produces a bundle without those files, requiring a separately supplied
identity on the Pi. The file manifest hashes every payload file and records both
source revisions; local modifications are included in those payload hashes.

## Transfer and install

After ejecting the card and booting the Pi, replace HOST with its hostname or IP.
Use the `pi` account and enter its password at the SSH/SCP prompts.

```sh
scp /absolute/path/to/round-carplay-pi-PRIVATE.tar.gz pi@HOST:~/
ssh pi@HOST
umask 077
tar -xzf round-carplay-pi-PRIVATE.tar.gz
bash round-carplay-pi/deploy/install.sh --check
bash round-carplay-pi/deploy/install.sh
```

The installer verifies checksums, rejects a 32-bit or non-Trixie OS, installs
runtime packages, compiles the native BlueZ bridge on ARM64, and configures the
three services. It asks for the Wi-Fi name/password and the phone's Bluetooth
address; input is saved privately with mode 0600. The Mac's DHCP IP and VM SSH
address are never copied into the launcher. The Pi resolves its LAN IP at boot.

Pairing on another computer does not pair the phone to the Pi. The current
Linux bridge owns the complete first-pair flow: it advertises the accessory
iAP and CarPlay discovery profiles, opens a five-minute setup window when the
configured phone is not bonded, automatically confirms the Pi side of numeric
comparison, trusts the completed bond, and closes the setup window.

On the iPhone, open **Settings → General → CarPlay → Available Cars**, select
**PlayPort**, and approve the one iOS pairing/CarPlay prompt. Do not coordinate
a code in a terminal. The stored BlueZ bond survives dashboard updates and all
later boots reconnect automatically. If the setup window expires, restart only
`round-carplay-playport.service` to open another window; a full Pi reboot is not
required.

If installation preceded pairing and you need to change the address/settings:

```sh
python3 ~/.local/share/round-carplay-pi/current/deploy/launch.py configure
sudo reboot
```

Keep the phone on the configured Wi-Fi for the first test. Change the private
configuration and restart the host after changing Wi-Fi networks. No separate
phone speed app is required: the current UI continues using OCR, with `--` when
no reliable speed is available. Do not infer numeric accuracy from an OCR count.

## Check and recover

```sh
systemctl status round-carplay-playport round-carplay-backend round-carplay-browser-kiosk
curl -fsS http://127.0.0.1:4000/health
journalctl -u round-carplay-playport -b --no-pager
~/.local/share/round-carplay-pi/current/deploy/diagnose-connection.py
journalctl -u round-carplay-playport -u round-carplay-backend -u round-carplay-browser-kiosk -b --no-pager
free -h
vcgencmd get_throttled
```

Backend `ok` confirms its listener; `playportConfigured` confirms a URL was set.
Neither proves that the phone has an active CarPlay session. Verify the live
map, Phone/Media controls, touch, audio and reconnects on the actual hardware.
The installer keeps the visible cursor for initial pointer/touch testing.
HDMI carries video; touchscreen USB must also be connected.

If the kiosk fails, SSH stays enabled. Stop it and restore a desktop if the
flashed OS included one:

```sh
sudo systemctl disable --now round-carplay-browser-kiosk
# Read /etc/round-carplay/pi-display-manager for the recorded desktop unit.
sudo systemctl enable --now lightdm.service  # only if lightdm was recorded
```

Lite has no desktop to restore. Use SSH or stop the kiosk and start
`getty@tty1.service` for a local console. Existing Pi releases stay under
`~/.local/share/round-carplay-pi/releases` and `previous` records the prior
release; persistent pairing/identity/settings live outside releases. Reinstall
the previous bundle to roll back, then reboot. Do not delete pairing state.

For normal Wi-Fi switching and signed, prebuilt updates from our v3 branch,
see [MAINTENANCE.md](MAINTENANCE.md). A one-time updated bootstrap installation
provisions those helpers; subsequent releases can install through the Update
button. The old branch/AppImage update path remains blocked. A normal install
does not reboot, re-pair the phone, actuate brightness, set up a hotspot, or
change display modes. Reboot after installation to activate the kiosk and new
video/audio group membership.
