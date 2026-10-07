# Project memory

## Canonical runtime

- Use the `browser-kiosk` branch/worktree for current development.
- The browser-based Chromium kiosk is the production/default target from now on.
- Keep Electron only as a rollback path unless a task explicitly targets it.

## USB backup camera

- Device: UVC camera labelled `2504`, USB VID:PID `32e6:9221`.
- Chromium captures it directly with `navigator.mediaDevices.getUserMedia`;
  camera frames never pass through the Node backend or Socket.IO.
- Opening a camera view powers the device. Unmounting the view stops all media
  tracks so the camera is released cleanly.
- Preserve crop-to-fill rotation, horizontal and vertical flips, selectable
  resolution, parking guides, and live FPS/device diagnostics.
- The kiosk user must belong to the Linux `video` group and Chromium must grant
  camera permission without an interactive kiosk prompt.
- Saved E-Eye/Wi-Fi adjustment values are migrated once to the generic USB
  camera settings; hotspot address and compression settings are discarded.

## CarPlay audio

- Round CarPlay is display/control-only. It always sends AutoKit's
  `audioTransferOn` command, never creates a local PCM player or microphone,
  and discards any audio packets the dongle still emits.
- The phone pairs directly with the car stereo for all media, navigation,
  call, and Siri audio. The Pi must not pair with the car's Bluetooth audio
  endpoint because that would compete with the phone connection.
- Audio gain and Pi Bluetooth connection controls are intentionally absent
  from the on-display menus.

The protocol analysis and standalone probe live in the sibling workspace at
`/Users/starkguo/Documents/wifi_backup_cam`.
