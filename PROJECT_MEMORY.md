# Project memory

## Canonical runtime

- Use the `browser-kiosk` branch/worktree for current development.
- The browser-based Chromium kiosk is the production/default target from now on.
- Keep Electron only as a rollback path unless a task explicitly targets it.

## Wi-Fi backup camera

- Device: E-Eye backup camera.
- Camera SSID confirmed from the Pi scan and the camera MAC suffix: `backcam_aee72870`.
- Its WPA-PSK is stored only on the Pi in the root-readable
  `/etc/round-carplay/eeye-camera-wifi-password` file; it must not be committed.
- Camera address: `192.168.10.1`.
- XMIP control: TCP `2222`; XMIP media: TCP `2223`.
- Validated stream: H.265 Main, `640×480`, 25 FPS, approximately two-second GOP.
- The backend decodes H.265 with ffmpeg and sends bounded, acknowledged JPEG
  frames to the browser UI. This avoids relying on Chromium HEVC support.
- The live camera overlay displays measured decoded FPS and link diagnostics.
- Opening the camera activates `eeye-camera`; closing it restores the previously
  active Wi-Fi profile.
- Camera activation briefly releases `wlan0` and restores the exact prior
  profile if activation fails. The on-display Wi-Fi menu must never disconnect
  the active profile merely to scan; a partial list is safer than stranding the
  kiosk off-network.

The protocol analysis and standalone probe live in the sibling workspace at
`/Users/starkguo/Documents/wifi_backup_cam`.
