# Seamless Dual-Runtime Kiosk Plan

Date: 2026-09-15

Stable branch: `wisecoco-480`

Migration branch: `browser-kiosk`

## Product behavior

Both runtimes expose the same System Menu behavior:

- Electron shows **Switch to Browser version** as the final menu button.
- Browser shows **Switch to Electron version** as the final menu button.
- The button is enabled only when the destination runtime passes a local readiness check.
- Selecting it opens a short confirmation, atomically selects the destination, and reboots.
- A failed selection leaves the current runtime selected and running.

Runtime switching is local and never depends on internet access.

## Runtime coordinator

Install one root-owned, narrowly scoped coordinator at
`/usr/local/sbin/round-carplay-runtime`. It supports only these commands:

```text
round-carplay-runtime status electron
round-carplay-runtime status browser
round-carplay-runtime switch electron
round-carplay-runtime switch browser
```

It must not accept paths, service names, shell fragments, or additional commands. A restricted
sudoers entry may authorize only these exact switch operations for the kiosk user.

The coordinator owns `/etc/round-carplay/runtime`, written through a temporary file and atomic
rename. It validates the complete destination before changing that file. Browser validation
includes the backend executable, a valid UI bundle, and both browser systemd units. Electron
validation includes the AppImage and Electron systemd unit.

Use distinct units so both installations can coexist:

```text
round-carplay-electron.service
round-carplay-backend.service
round-carplay-browser-kiosk.service
```

The existing `round-carplay-kiosk.service` is migrated to `round-carplay-electron.service` during
dual-runtime installation. The coordinator enables the selected runtime for the next boot without
stopping the currently visible runtime. Reboot happens only after selection succeeds.

## OTA model

The System Menu presents one Update action in either runtime. The backend returns separate
installed and available versions for the Electron AppImage, browser backend/runtime, browser UI
bundle, and runtime coordinator/systemd definitions.

An update manifest declares artifact URLs, SHA-256 checksums, architecture, minimum coordinator
version, and protocol compatibility. Downloads go to a staging directory, checksums are verified,
and activation uses atomic rename or symlink replacement. Keep one known-good previous artifact
for every class.

Updating the inactive runtime is allowed and preferred. Updating the active runtime stages the
artifact and activates it on restart. A browser UI-only update switches the versioned `current`
symlink and normally does not restart the hardware backend. No update may interrupt an active
backup-camera session.

The current Git-pull-and-build Electron updater remains available during the migration, but the
final OTA path consumes versioned release manifests instead of compiling on the Pi.

## Failure and recovery rules

- Never select a runtime whose readiness check fails.
- Do not disable the current runtime until the next runtime is completely staged and validated.
- Browser startup reports healthy only after the backend health endpoint and Chromium kiosk page
  are ready.
- A boot-attempt counter automatically returns to the last-known-good runtime after repeated failed
  starts.
- Keep a local console recovery command for both directions.
- Retain the Electron AppImage and service for at least one full release cycle after browser kiosk
  becomes the default.

## Delivery sequence

1. Electron menu contract: add the bottom switch button, IPC boundary, readiness check,
   confirmation, and reboot flow. Until the coordinator is installed the button remains visible but
   disabled with an explanatory message.
2. Dual-runtime installer: install the coordinator, rename the Electron unit, add the browser
   units, configure exact sudo permissions, and verify rollback.
3. Standalone backend and browser adapter: preserve the `window.carplay` behavior and implement the
   inverse switch button.
4. Unified OTA manifest: stage and update Electron, backend, UI, and coordinator independently with
   checksums and rollback.
5. Pi acceptance: test offline boot, failed browser boot rollback, repeated switching, power loss
   during updates, camera Wi-Fi transitions, and CarPlay media latency before making browser kiosk
   the default.

## Implementation status

- Complete: transport-neutral hardware event sinks and shared browser/Electron API contract.
- Complete: standalone loopback backend, static UI server, validated RPC payloads, and bounded/drop
  behavior for latency-sensitive video and camera events.
- Complete: browser adapter, settings persistence, camera acknowledgements, CarPlay input/media,
  networking, GPS, system controls, and inverse runtime switch button.
- Complete: atomic browser release installer, Chromium/Cage units, distinct Electron/browser units,
  fixed-command runtime coordinator, restricted sudo rules, and console recovery.
- Complete: branch fallback updates plus SHA-256 manifest OTA for Electron, full browser runtime, and
  UI-only artifacts with `current`/`previous` activation.
- Pending hardware acceptance: Raspberry Pi USB/audio/video, Cage/Chromium acceleration and
  permissions, physical touch display, power-loss, and boot-failure rollback testing.
