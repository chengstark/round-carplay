# Browser Kiosk Runtime

The `browser-kiosk` branch runs the existing React UI in Chromium while a local Node.js service
owns CarPlay USB, audio, GPS, NetworkManager, and the E-Eye Wi-Fi camera. The API and UI bind only to
`127.0.0.1` and continue to work without internet access.

This is the canonical runtime for current development. See `PROJECT_MEMORY.md`
for the durable project assumptions and camera protocol summary.

## Local build and preview

```bash
npm run build:browser
ROUND_CARPLAY_PORT=4000 node out/main/backend.js
```

Open `http://127.0.0.1:4000/`. The backend also exposes `GET /health` for systemd startup checks.

## Raspberry Pi installation

Keep the stable Electron checkout and this branch in separate worktrees. From the browser-kiosk
checkout on the Pi, run:

```bash
./setup-browser-kiosk.sh
```

The installer builds an atomic browser release and installs these coexisting units:

- `round-carplay-electron.service`
- `round-carplay-backend.service`
- `round-carplay-browser-kiosk.service`

It preserves Electron as the initially selected runtime when an AppImage is present. Use the final
button in either runtime's System Menu to switch and reboot, or recover from a console with:

```bash
sudo round-carplay-runtime switch electron
sudo systemctl reboot
```

## OTA updates

Without an OTA manifest, each runtime retains its branch-based updater. Browser releases are
installed under `~/.local/share/round-carplay/releases`, and `current`/`previous` symlinks provide
atomic activation and rollback.

For artifact OTA, host a manifest matching `ota-manifest.example.json`, then install with:

```bash
ROUND_CARPLAY_UPDATE_MANIFEST_URL=https://updates.example.com/manifest.json \
  ./setup-browser-kiosk.sh
```

The same manifest is consumed by Electron and the browser backend. It can independently replace the
Electron AppImage, full browser runtime, or UI-only bundle. Every artifact is SHA-256 verified before
an atomic switch. An update is refused while the backup camera is active.

Create browser artifacts with:

```bash
npm run package:browser
```

This writes a full browser archive and a smaller UI-only archive under `dist/browser` and prints the
checksums needed by the manifest.

## Pi acceptance testing

Before making the browser runtime the default, test on the actual Pi and round display:

- cold/offline boot and missing camera hotspot;
- CarPlay video, audio, microphone, touch, and USB reset/reconnect;
- GPS state and smoothing;
- camera Wi-Fi activation, diagnostics, frame acknowledgement, latency, and reconnection;
- repeated Electron/browser switching and console recovery;
- backend/Chromium crash recovery and power loss during update staging;
- Electron, full-browser, and UI-only OTA installation plus rollback.
