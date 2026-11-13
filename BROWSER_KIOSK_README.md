# Current browser kiosk runtime

The current runtime is the React round dashboard in Chromium, a local Node
backend, and the PlayPort CarPlay host. Use the current local browser-kiosk
checkout and the active PlayPort checkout recorded in PROJECT_MEMORY.md.
Electron/AppImage/Carlinkit migration instructions describe earlier versions.

## Raspberry Pi 3 B deployment

Use [the current Pi deployment guide](deploy/pi/README.md). The Mac packages
the live source trees with `scripts/package-pi.mjs`; the Pi installs the
resulting bundle using `deploy/install.sh`. The bundle contains no Electron
runtime, USB Carlinkit dependency, or VM. Do not run the old setup-pi.sh or
setup-browser-kiosk.sh for this PlayPort deployment: they configure older
runtimes and the latter disables the Bluetooth radio PlayPort needs.

Target Raspberry Pi OS Trixie 64-bit. Physical Pi validation is pending;
packaging and local tests do not establish performance or hardware readiness.

## Local development

```sh
./node_modules/.bin/electron-vite build --filter main --logLevel warn
./node_modules/.bin/vite build --config vite.renderer.config.ts --logLevel warn
node out/main/backend.js
```

The retained electron-vite tooling builds JavaScript; it does not launch
Electron. Set PLAYPORT_WS_URL and private controller environment variables
as recorded in the latest session handoff. UI/backend bind to 127.0.0.1:4000.
`/health` confirms backend readiness; it does not confirm an active phone session.

## Validation

```sh
node --test scripts/test-pi-deployment.cjs scripts/test-speed-ocr.cjs scripts/test-navigation-overlay.cjs
python3 deploy/pi/test_launch.py
./node_modules/.bin/tsc --noEmit -p tsconfig.backend.json
./node_modules/.bin/tsc --noEmit -p tsconfig.web.json --composite false
```

The Pi deployment uses signed prebuilt updates from the dedicated v3 GitHub
feed after one bootstrap installation. See [Wi-Fi and update setup](deploy/pi/MAINTENANCE.md).
It blocks the old branch/AppImage update path and has no Electron runtime switch.
