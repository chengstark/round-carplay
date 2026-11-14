# Current Round CarPlay on Raspberry Pi 3 B

This deploys the **current local browser dashboard and PlayPort host** from the
ROUNDSCREENCARPLAY chat. It does not install Electron, Carlinkit, an AppImage,
UTM, or any earlier application release. The Mac builds the assets and JVM
distribution; the Pi runs them directly. There is no prebuilt OS image yet.

## Status and target

- Target: Raspberry Pi OS **Trixie, 64-bit**, on the Pi 3 B; SSH and Wi-Fi enabled.
- Initial installation needs internet for Debian runtime packages. Boot and
  operation afterwards use local services and the configured Wi-Fi network.
- On the current Pi 3 B, fresh iPhone pairing and automatic reconnection after
  reboot reached active CarPlay video. The startup guard also survived a network
  recovery timer cycle during playback. A second Pi has not yet been validated.
  Touch, camera and OCR still need separate physical acceptance checks.
- Pi 3 B has 1 GB RAM. Initial JVM/Node heap limits are 256/128 MB; Chromium,
  native allocations and the OS use additional RAM. These are starting budgets.
- Current negotiation stays **512×512 map, 1024×1024 main, H.264, 60 fps**.
  Physical panel is 480×480. Preserve the **1280×960@60** HDMI mapping and the
  existing 4:3 CSS compensation. The installer does not change HDMI modes.
- Use the existing external Wi-Fi for bring-up. A Pi-hosted hotspot and
  simultaneous wireless CarPlay have not been validated.
- The Pi launcher uses `--no-audio`: no advertised audio formats, audio resource
  ownership, or accepted audio stream ports. The Pi microphone is disabled.
  It also installs a WirePlumber 0.5 user configuration fragment disabling
  `monitor.bluez`, so the Pi does not advertise separate Bluetooth speaker or
  hands-free audio profiles. The native iAP pairing profiles remain available.
  Select the intended audio output on the iPhone; this does not configure a
  separate car stereo or Bluetooth speaker.
- Settings → Developer contains an enable switch and a persistent Show mouse
  pointer switch. The pointer is hidden by default.
  The installer enables a root-owned cursor-seat helper for touch-only Cage:
  a virtual mouse keeps cursor focus available without generating clicks.
  The UI refreshes pointer focus during startup and when the kiosk regains
  focus, with bounded delayed retries while Chromium applies its cursor rule.
  Existing installations predating that service need the installer once; OTA
  updates retain the installed helper and do not replace root-owned code.
- Network recovery restarts PlayPort only after its status API explicitly
  confirms idle; a slow status API during boot cannot interrupt phone startup.
  Recovery reads the radio's power-saving state and only disables it when
  needed, avoiding repeated writes to an already configured Wi-Fi device.
- The dashboard backend starts independently of PlayPort's network startup.
  The Pi JVM uses first-tier compilation to reduce cold-start work. A failed
  saved-phone Bluetooth attempt pauses two seconds before retrying; an ended
  session is re-invited after five seconds, and a stalled handoff from a
  previously live phone is retried after thirty seconds. First enrollment is
  kept open without that handoff deadline.
- Use the current Insignia USB Bluetooth adapter for the first test if the Pi's
  built-in Bluetooth does not work. BlueZ is enabled. Do not apply the old
  scripts that turn the controller off.

## Pi 3 startup and onboard Wi-Fi

On the Pi 3 B v1.2 tested on 2026-11-14, live CarPlay after a full boot improved
from 112 seconds to 62–67 seconds; the local dashboard backend was ready at
25 seconds. A host-only restart reconnected in 14–15 seconds. These are measured
examples, not an instantaneous-start guarantee. Existing installations need an
installer refresh to adopt the earlier systemd service ordering; OTA updates
preserve root-owned units.

This board also produced recurring `brcmfmac` SDIO timeouts with power saving
disabled. The current diagnostic configuration lowers the onboard Wi-Fi bus
from 50 MHz to 25 MHz using the documented firmware parameter in
`/boot/firmware/config.txt`:

```ini
[pi3]
dtparam=sdio_overclock=25
[all]
```

Back up the boot configuration before applying this board-specific setting and
reboot afterwards. Verify the **actual clock** with
`sudo cat /sys/kernel/debug/mmc1/ios`; the requested clock can still show 50 MHz.
This boot setting survives application updates but is not applied by the
installer or OTA. It is a stability experiment, not a confirmed general fix for
all SDIO failures. Removing this block restores the previous clock after reboot.

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
runtime packages, compiles the native BlueZ bridge on ARM64, and configures
PlayPort, the dashboard, the kiosk and network recovery. It asks for the Wi-Fi
name/password and the phone's Bluetooth address; input is saved privately with
mode 0600. The Mac's DHCP IP and VM SSH address are never copied into the
launcher. The Pi resolves its LAN IP at boot.

Pairing on another computer does not pair the phone to the Pi. The package
overlays four adapted Rust modules from `experiments/native-inbound` onto the
pinned PlayPort PR #4 bridge. This registers local accessory SDP/RFCOMM
services for the iPhone's initial connection. The dashboard's **Pair iPhone**
button opens a time-limited pairing window; the iPhone initiates the Bluetooth
connection. On the iPhone, select **PlayPort** in Settings → Bluetooth or
Settings → General → CarPlay → Available Cars, then approve the matching code
and CarPlay prompt. Pairing progress and the code appear in dashboard Settings.
For an incomplete saved bond, **Finish pairing** opens the window again without
deleting keys. **Connect iPhone** reuses a completed bond. Only a live
`/api/status.sessionActive=true` and video stream confirm CarPlay, not a
Bluetooth “Connected” label. The first clean pairing worked on the current Pi;
test the same procedure on every new Pi before calling its installation ready.

Both package paths include the native bridge overlay and the numbered PlayPort
patches for app requests, unnumbered replies, display-only audio, and active
session ownership. The dashboard keeps prepared apps and unchanged video
decoders alive across map/overlay transitions and viewer reconnects. The GitHub
ARM64 build compiles this source, runs its tests, and publishes the signed update.
A local private package can include uncommitted code; public updates contain
only committed source. Private accessory identity must be supplied securely for
each initial install; it is never included in public updates.

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
