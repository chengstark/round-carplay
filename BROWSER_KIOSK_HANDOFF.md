# Browser Kiosk Migration Handoff

Date: 2026-09-15  
Repository: `round-carplay`  
Target branch: `wisecoco-480`

## Objective

Replace the Raspberry Pi Electron/AppImage runtime with a browser kiosk backed
by a local hardware service. Preserve the current UI and behavior while making
routine UI updates small and fast.

The desired Pi runtime is:

```text
systemd
├── round-carplay-backend.service
│   └── Node.js hardware/API service on 127.0.0.1
└── round-carplay-kiosk.service
    └── Cage → Chromium kiosk → http://127.0.0.1:<port>
```

This migration is not intended to redesign the interface. The React renderer,
circular 480-pixel layout, camera surface, parking guides, CarPlay presentation,
touch behavior, fonts, colors, and controls should remain visually equivalent.

## Why change

The current AppImage rebuilds and redistributes the complete Electron runtime,
Chromium, application bundle, and ARM64 native dependencies for every change.
That is convenient for installation but inefficient for small renderer changes.

The proposed split keeps the native/runtime layer installed and updates the web
bundle separately. A normal UI change should require only a frontend build and
deployment of a small archive, not a new ARM64 AppImage.

This does not eliminate frontend compilation. It eliminates routine Electron
packaging and native dependency rebuilds.

## Recommended scope

Migrate the Raspberry Pi kiosk first. Keep the Electron desktop wrapper for
macOS until the browser-kiosk path has reached feature parity. Both runtimes can
share the existing renderer and TypeScript contracts during the transition.

Use Node.js for the first backend extraction because the existing hardware
services are already TypeScript/Node code. A Rust rewrite would increase the
scope without helping establish transport and kiosk parity.

## Development isolation

Implement the migration on a dedicated Git branch in a separate Git worktree.
Do not develop it directly inside the current shipping checkout.

Recommended layout:

```text
/Users/starkguo/Documents/round-carplay                  # stable wisecoco-480
/Users/starkguo/Documents/round-carplay-browser-kiosk    # browser-kiosk branch
```

Recommended branch roles:

- `wisecoco-480` remains the stable Electron/AppImage release branch. Camera
  fixes and normal production updates continue from this checkout.
- `browser-kiosk` contains the backend extraction, browser adapter, kiosk
  services, and lightweight updater work.

Each worktree should have its own `node_modules`, generated output, local
configuration, and test state. Do not share build directories between them.
Experimental kiosk builds must not overwrite the installed production AppImage
or its recovery service.

Regularly merge the latest stable `wisecoco-480` changes into `browser-kiosk`
so camera and CarPlay fixes are not lost. Do not merge the migration branch back
until the browser-kiosk acceptance criteria pass. At that point, review it as a
normal pull request and retain the Electron branch/tag as the rollback point.

Creating the worktree is an implementation step for the migration task, not for
ordinary production updates. The current checkout should stay clean and usable
throughout the experiment.

## Current architecture

- `src/renderer` contains the React UI.
- `src/preload/index.ts` exposes `window.carplay` and translates calls/events to
  Electron IPC.
- `src/main/index.ts` owns Electron lifecycle and wires IPC to services.
- Main-process services currently handle:
  - Carlinkit USB and CarPlay transport
  - CarPlay audio/video/event delivery
  - E-Eye XMIP/H.265 Wi-Fi camera streaming and diagnostics
  - GPS state
  - NetworkManager Wi-Fi management
  - Settings persistence
  - Updates, reboot, and power-off
- `setup-pi.sh` installs an AppImage and launches it in Cage using a systemd
  kiosk service.

The renderer is already browser-oriented. The primary coupling to Electron is
the `window.carplay` API implemented by the preload script.

## Target architecture

### 1. Local backend service

Extract the non-window portions of `src/main/index.ts` into a standalone Node
service. Reuse the existing service classes wherever possible.

The backend should:

- Bind only to `127.0.0.1`.
- Serve the production web bundle.
- Provide request/response operations over HTTP or WebSocket RPC.
- Provide live and binary events over WebSocket.
- Start without an internet connection.
- Continue running if Chromium restarts.
- Exit and restart cleanly under systemd.

Suggested initial transport split:

- HTTP/RPC:
  - settings get/save
  - USB detection/reset/device information
  - camera start/configure/stop
  - GPS snapshot
  - Wi-Fi scan/connect/IP addresses
  - update status/start
  - reboot/power-off
- WebSocket events:
  - USB and CarPlay events
  - CarPlay video chunks
  - CarPlay audio chunks
  - GPS updates
  - camera JPEG frames
  - camera state and diagnostic updates
  - settings and updater status

The camera and CarPlay binary paths must retain their existing backpressure
behavior. Do not allow WebSocket queues to grow without bounds. Camera frame
acknowledgements and latest-frame replacement should remain in place.

### 2. Browser compatibility adapter

Create a browser implementation of the current `window.carplay` API. Preserve
the method names and callback shapes from `src/preload/index.ts` so most React
components do not need transport-specific changes.

Suggested structure:

```text
src/shared/carplayApiTypes.ts
src/preload/index.ts                   # Electron adapter
src/renderer/src/api/browserApi.ts     # HTTP/WebSocket adapter
```

Move shared payload and API types out of the preload module. At renderer startup:

- Use the preload-provided API when running under Electron.
- Otherwise install the browser adapter as `window.carplay`.

Add contract tests that run the same behavioral checks against both adapters.

### 3. Chromium kiosk

Replace the Electron command in `setup-pi.sh` with Chromium launched under
Cage. The exact Chromium binary name should be detected during installation.

The kiosk service should:

- Depend on the backend service and NetworkManager.
- Wait for a local backend health endpoint before launching Chromium.
- Use fullscreen/app/kiosk mode with no tabs, toolbar, dialogs, or notifications.
- Enable the hardware acceleration path validated on the target Pi.
- Disable session restore and crash bubbles.
- Restart Chromium after a crash.
- Keep the browser user-data directory local and disposable.
- Continue using the existing PAM/logind/Cage arrangement for the touchscreen,
  audio session, and seat access.

Do not run Chromium or the backend as root. Keep privileged system operations
behind the existing narrow helpers or explicitly authorized service actions.

### 4. Split update system

Separate updates into two artifact classes:

1. Runtime/backend release
   - Infrequent.
   - Contains Node, native dependencies, service definitions, and backend code.
   - May still require a larger platform-specific package.
2. Web UI release
   - Frequent.
   - Contains only versioned static assets and a manifest.
   - Download to a staging directory, verify checksum, then atomically switch a
     `current` symlink.
   - Keep the previous bundle for immediate rollback.

The UI build can remain Vite-based. Add a dedicated command that builds only the
renderer instead of invoking Electron packaging. The backend should serve a
fixed local fallback page if no valid UI bundle is available.

Updates requiring internet access must account for the Pi being connected to
the E-Eye hotspot, which has no internet route. Do not interrupt an active backup
camera session to fetch an update.

## Migration phases

### Phase 0: Baseline and contracts

- Record reference screenshots at the actual round 480-pixel display size.
- Record cold boot time, idle memory, video FPS, audio behavior, and touch
  latency.
- Inventory every `window.carplay` method and event.
- Extract shared API types without changing behavior.
- Add smoke tests for settings, camera, GPS, networking, system controls, and
  CarPlay message flow.

### Phase 1: Extract backend without removing Electron

- Remove direct `WebContents` dependencies from services by introducing typed
  event sinks/subscribers.
- Keep the Electron main process as one consumer of those service APIs.
- Add the standalone HTTP/WebSocket server as a second consumer.
- Run both modes during development and compare event payloads.

This is the key risk-reduction phase: hardware behavior should be unchanged
while transport is decoupled.

### Phase 2: Browser adapter and local preview

- Implement the browser `window.carplay` adapter.
- Run the existing renderer in ordinary Chromium against the local backend.
- Verify CarPlay video/audio, touch, settings, GPS, camera frames and frame
  acknowledgement, diagnostics, and update-status events.
- Confirm that browser autoplay, audio output, microphone permissions, pointer
  events, and canvas acceleration work without interactive prompts.

### Phase 3: Pi kiosk service

- Install the backend and Chromium/Cage systemd units alongside the current
  Electron kiosk.
- Add a configuration switch to choose Electron or browser kiosk at boot.
- Provide a recovery command that returns to the known-good Electron kiosk.
- Test repeated power loss, offline boot, camera Wi-Fi switching, and service
  restart behavior.

### Phase 4: Lightweight updates

- Publish a versioned renderer archive and checksum manifest.
- Add atomic install and rollback logic.
- Display the UI and backend versions separately in the system menu.
- Confirm that a UI-only update does not restart the hardware backend unless a
  protocol version requires it.

### Phase 5: Default and cleanup

- Make browser kiosk the Pi default only after acceptance criteria pass.
- Retain Electron recovery for at least one release cycle.
- Remove Pi Electron/AppImage packaging after the rollback window closes.
- Keep Electron for macOS unless a separate desktop migration is approved.

## Important implementation risks

### CarPlay video and audio

CarPlay media is latency-sensitive. WebSocket framing and browser decoding must
not introduce unbounded buffering or extra copies. Measure end-to-end latency,
not only FPS. Preserve latest-frame behavior where applicable.

### Native USB module

The `usb` native dependency must remain installed for the Pi architecture. The
benefit of this plan is that it is installed with the backend runtime and is not
rebuilt for each web UI change.

### Browser permissions

The kiosk must not show permission prompts. Audio, microphone, autoplay,
fullscreen, and any required media permissions must be preconfigured and tested
under the actual Cage/PAM session.

### Wi-Fi transitions

The camera button repairs and activates the `eeye-camera`
NetworkManager profile. Because the backend and browser communicate over
loopback, switching away from an internet Wi-Fi network must not break the UI.

### Security

- Bind the API server to loopback only.
- Validate every command payload.
- Restrict origins to the local UI.
- Do not expose generic shell execution.
- Keep reboot, power-off, updater, and network mutation operations narrowly
  scoped.
- Do not serve secrets back to the browser.

## Acceptance criteria

The browser kiosk is ready to replace Electron on the Pi when all of the
following are true:

- The 480-pixel round interface is visually equivalent to the current release.
- The Pi boots directly into the UI without a desktop, browser chrome, dialogs,
  or keyboard interaction.
- Boot works with no internet and with the E-Eye hotspot absent.
- CarPlay connects, renders, accepts touch/key input, and plays audio reliably.
- Microphone input remains functional.
- USB disconnect/reconnect and forced reset behavior match the current app.
- GPS state and smoothing match the current app.
- Wi-Fi scanning and connection management work.
- Opening the camera activates `eeye-camera`, disables Wi-Fi power saving, and
  displays live diagnostics while the XMIP/H.265 stream connects.
- Camera FPS, latency, reconnection, rotation, and resolution selection match
  the current app.
- Reboot, power-off, update status, and recovery operations work without a
  desktop shell.
- Chromium and backend crashes recover automatically.
- A UI-only update installs atomically, retains a rollback bundle, and does not
  require a new Electron/AppImage package.
- The previous Electron kiosk can be restored with one documented command
  during rollout.

## Suggested first implementation task

Do not begin by changing the kiosk or updater. First extract a typed service
boundary and implement the browser adapter while Electron remains the default.
The first milestone should be the unchanged React UI running in desktop
Chromium against the standalone backend with settings, GPS, networking, and the
Wi-Fi camera fully working. Add CarPlay media only after the transport and
backpressure behavior is proven.

## Explicit non-goals for the initial migration

- No visual redesign.
- No camera firmware changes.
- No replacement of React.
- No Rust rewrite.
- No removal of macOS support.
- No cloud dependency.
- No immediate deletion of the Electron recovery path.
