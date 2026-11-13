# Round CarPlay v3

A round CarPlay dashboard using a Chromium browser, a local Node backend and
our current PlayPort host. The map fills the circular dashboard; native Phone
and Media panels, navigation details, clock, USB camera and system controls
share the round interface.

The current runtime lives on the `browser-kiosk` branch. Retained Electron
build tooling and older source modules are historical; the v3 Pi runtime is
the browser dashboard plus PlayPort. It uses the phone's Bluetooth/Wi-Fi
CarPlay connection directly.

## Raspberry Pi

Target: Raspberry Pi OS Trixie **64-bit**, initially a Pi 3 Model B. Install the
private bootstrap package using [the deployment guide](deploy/pi/README.md).
This runs the host, backend and kiosk as services at boot. Accessory identity,
phone pairing and private controller/network settings stay on the device and
are excluded from public update packages.

Physical Pi testing established a live phone session and visible dashboard.
Connection reliability, round-screen touch/geometry, audio, camera, moving
speed OCR and the new maintenance flows still need target validation.

## Wi-Fi and updates

Settings → Wi-Fi provides a normal network chooser with saved passwords,
reconnect, and fallback to the previous profile if joining fails. PlayPort
refreshes its network/address settings after a switch.

Settings → System checks the dedicated signed v3 update feed. GitHub builds
our branch and the Pi downloads a ready-to-run ARM64 package. Automatic updates
wait while CarPlay is active. The previous release is retained and restored
when startup health checks fail. See [maintenance setup](deploy/pi/MAINTENANCE.md)
for the one-time bootstrap, signing secret and hosted release activation.

The dedicated GitHub workflow builds and publishes signed ARM64 releases. Its
first hosted build and public feed signature were verified. Device Wi-Fi
switching and the first OTA activation still require physical validation.

## Development

```sh
npm ci --ignore-scripts --legacy-peer-deps
./node_modules/.bin/tsc --noEmit -p tsconfig.backend.json
./node_modules/.bin/tsc --noEmit -p tsconfig.web.json --composite false
npm run test:pi
```

Build the standalone backend and web UI:

```sh
./node_modules/.bin/esbuild src/backend/index.ts --bundle --platform=node --format=cjs --target=node20 --external:bufferutil --external:utf-8-validate --outfile=out/pi/backend.cjs
./node_modules/.bin/vite build --config vite.renderer.config.ts
ROUND_CARPLAY_UI_DIR="$PWD/out/renderer" node out/pi/backend.cjs
```

The dashboard binds to `http://127.0.0.1:4000`. Configure `PLAYPORT_WS_URL` with
your local host endpoint/token to connect a phone; the backend keeps the token
out of the renderer. The current PlayPort CI source is captured in
[vendor](vendor/README.md); refresh that snapshot when the active host changes.

Unavailable navigation/speed data remains absent or `--`; the UI does not invent
values. Current speed uses local OCR of the native Google Maps stream rather
than requiring a separate phone app. Real moving-value accuracy is unverified.

## Licence

MIT; see [LICENSE](LICENSE). PlayPort's source licence is preserved in its vendor
snapshot. Apple and CarPlay are trademarks of Apple Inc.; this project is not
affiliated with or endorsed by Apple.
