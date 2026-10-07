<p align="center">
  <!-- Release -->
  <img alt="Release" src="https://img.shields.io/github/v/release/OneMakerShow/round-carplay?label=release">
  <!-- Version -->
  <img alt="Version" src="https://img.shields.io/github/package-json/v/OneMakerShow/round-carplay?label=version">
  <!-- Build Main -->
  <img alt="Build Main" src="https://img.shields.io/github/actions/workflow/status/OneMakerShow/round-carplay/build.yml?branch=main&label=build%20main&style=flat">
  <!-- Typecheck Main -->
  <img alt="Typecheck Main" src="https://img.shields.io/github/actions/workflow/status/OneMakerShow/round-carplay/typecheck.yml?branch=main&label=typecheck%20main&style=flat">
  <!-- Build Dev -->
  <img alt="Build Dev" src="https://img.shields.io/github/actions/workflow/status/OneMakerShow/round-carplay/build.yml?branch=dev&label=build%20dev&style=flat">
  <!-- Typecheck Dev -->
  <img alt="Typecheck Dev" src="https://img.shields.io/github/actions/workflow/status/OneMakerShow/round-carplay/typecheck.yml?branch=dev&label=typecheck%20dev&style=flat">
  <!-- License -->
  <img alt="License" src="https://img.shields.io/github/license/OneMakerShow/round-carplay">
</p>


# Round Carplay

Round Caraplay is an attempt to adapt the classic Apple CarPlay to a round screen using a Raspberry Pi. The idea is to display CarPlay in a central square area and then fill the surrounding space with information coming from the vehicle’s OBD bus.

The production runtime is a Chromium kiosk with a local Node.js hardware backend,
optimized for Raspberry Pi and ultra-low-resolution OEM displays.

> **Requirements:** A Carlinkit **CPC200-CCPA** (wireless & wired) or **CPC200-CCPW** (wired only) adapter.

## USB backup camera

The right-side crescent button opens the selected UVC/USB backup camera directly
through Chromium's media-device API. Double-tap the button to open or close the
feed. Opening the stream powers the camera; closing it stops every media track
and releases the device.

The existing image calibration is preserved: crop-to-fill at every angle,
continuous `0°`–`359°` rotation, one-degree adjustment buttons, horizontal and
vertical flips, resolution selection, and parking guides. The Camera tab and
reverse-triggered view use the same adjusted canvas. The live strip reports the
device name, negotiated resolution, and measured frame rate.

The installer grants the kiosk user access to Linux video devices and launches
Chromium with camera permission pre-approved for the local kiosk. On a fresh or
disconnected selection, the app prefers a camera labelled `2504`, then another
USB camera, before falling back to the first available video input.

## GPS speedometer

Tap the car artwork below the CarPlay square to switch between the artwork and
a live MPH readout. On Raspberry Pi, the app reads 9600-baud NMEA from
`/dev/serial0`; the serial hardware must be enabled and the serial login shell
disabled. The display shows `-- MPH` until the receiver has a valid GPS fix.

## On-display system menu

The menu button in the upper surround opens a panel over the CarPlay square;
CarPlay remains mounted and reappears immediately when the panel closes. The
panel can change the surround color, scan and connect to NetworkManager Wi-Fi
networks, and display the Pi's active IPv4 addresses. Raspberry Pi OS Bookworm
and newer use NetworkManager by default.

Round CarPlay operates as a display and controller only. It tells the Carlinkit
dongle not to send audio to the Pi, does not create a local CarPlay audio player,
and ignores any PCM packets a dongle may still emit. Pair the phone directly
with the car stereo for music, navigation, calls, and Siri audio. If the stereo
was previously paired with the Pi, remove that pairing so it cannot compete
with the phone's Bluetooth connection.

The kiosk powers off the Raspberry Pi Bluetooth controller at application
startup. A full kiosk installer run additionally stops and masks BlueZ and
rfkill-blocks the Pi radio. This does not disable the Carlinkit adapter's own
wireless CarPlay radio because the adapter is separate USB hardware.

## Installation (Raspberry Pi OS)

```bash
curl -LO https://raw.githubusercontent.com/OneMakerShow/round-carplay/main/setup-pi.sh
sudo chmod +x setup-pi.sh
./setup-pi.sh
```

The `setup-pi.sh` script performs the following tasks:

1. checks for required tools, including the Cage Wayland kiosk compositor
2. configures udev rules to ensure the proper access rights for the CarPlay dongle
3. preserves the installed AppImage, or downloads the latest release on a fresh install
4. makes a direct-to-app kiosk session the default boot experience
5. creates a desktop shortcut for easy access to the application

The kiosk session does not start the Raspberry Pi desktop, panel, update
notifier, NetworkManager applet, or notification daemon. Wi-Fi connection and
available-update pop-ups therefore cannot cover CarPlay. NetworkManager and the
operating system's background update services remain enabled, and Wi-Fi can
still be managed from Round CarPlay's on-display system menu.

The installer leaves the current desktop session running and applies kiosk mode
on the next reboot:

```bash
sudo reboot
```

To restore the full desktop for troubleshooting, run this command and reboot:

```bash
sudo round-carplay-desktop
sudo reboot
```

*Do not run this script on other Linux distributions.*

## Images
<p align="center">
  <strong><span style="font-size:20px;">Reference, Mini Cooper Navigator System</span></strong>
</p>

<p align="center">
  <img src="documentation/images/reference.jpg"
       alt="CarPlay"
       width="45%" />
</p>

<p align="center">
  <strong><span style="font-size:20px;">Real Device First Tests</span></strong>
</p>

<p align="center">
  <img src="documentation/images/01.jpg"
       alt="Settings"
       width="20%" />
  &emsp;&emsp;
  <img src="documentation/images/02.jpg"
       alt="Settings"
       width="20%" />
    &emsp;&emsp;
  <img src="documentation/images/03.jpg"
       alt="Settings"
       width="20%" />
    &emsp;&emsp;
  <img src="documentation/images/04.jpg"
       alt="Settings"
       width="20%" />
</p>


### System Requirements (build)

Make sure the following packages and tools are installed on your system before building:

- **Python 3.x** (for native module builds via `node-gyp`)
- **build-essential** (Linux: includes `gcc`, `g++`, `make`, etc.)
- **libusb-1.0-0-dev** (required for `node-usb`)
- **libudev-dev** (optional but recommended for USB detection on Linux)
- **fuse** (required to run AppImages)

---

### Clone & Build

```bash
git clone --branch main --single-branch https://github.com/OneMakerShow/round-carplay.git \
  && cd pi-carplay \
  && npm run install:clean \
  && npm run build \
  && npm run build:armLinux
```

---

### Linux (x86_64)

This AppImage has been tested on Debian Trixie (13). No additional software is required — just download the x86_64.AppImage and make it executable.

```bash
chmod +x round-carplay-*-x86_64.AppImage
```

---

### Mac (arm64)

This step is required for all non-Apple-signed apps.

```bash
xattr -cr /Applications/round-carplay.app
```

For microphone support, please install Sound eXchange (SoX) via brew.
```bash
brew install sox
```

---

## Links

* **Repository & Issue Tracker:** [OneMakerShow/round-carplay](https://github.com/OneMakerShow/round-carplay)
* **Inspired by:** [pi-carplay](https://github.com/f-io/pi-carplay)

## Disclaimer

** _Apple and CarPlay are trademarks of Apple Inc. This project is not affiliated with or endorsed by Apple in any way. All trademarks are the property of their respective owners._


## License

This project is licensed under the MIT License.
